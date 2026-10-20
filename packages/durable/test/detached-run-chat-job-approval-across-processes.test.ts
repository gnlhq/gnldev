// S1 chat, S2 long job, S3 approval — real app processes on a shared Sqlite file and on Postgres,
// each built from @gnldev/durable alone (test/fixtures/detached-node.ts).
import { describe, it, expect, afterEach } from 'vitest';
import { newStore, startNode, post, readEvents, effectCount, linesOf, stopNode, sleep, PG_BASE, type Node, type Store } from './detached/harness.js';
import { textOf } from './detached/models.js';

const kinds: Array<'sqlite' | 'postgres'> = PG_BASE ? ['sqlite', 'postgres'] : ['sqlite'];
const live: Node[] = [];
const stores: Store[] = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map(stopNode));
  stores.splice(0).forEach((s) => s.drop());
});
const node = async (s: Store, env: Record<string, string> = {}) => { const n = await startNode(s, env); live.push(n); return n; };
const store = (k: 'sqlite' | 'postgres') => { const s = newStore(k); stores.push(s); return s; };
const finalState = (evs: any[]) => evs.filter((e) => e.kind === 'status').map((e) => e.data.state).pop();
const words = Array.from({ length: 20 }, (_, i) => `w${i}`);
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };
const p95 = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length * 0.95)]!; };

async function timeToFirstText(n: Node, path: string, runId: string): Promise<number> {
  const t0 = performance.now();
  const res = await post(n, path, { runId });
  let at = -1;
  await readEvents(res, (e) => { if (e.kind === 'text' && at < 0) at = performance.now() - t0; return false; });
  return at;
}

describe.each(kinds)('S1–S3 on %s', (kind) => {
  it(`S1 ${kind}: the same call streams live; disconnect, reconnect on ANOTHER process, no gap, no duplicate`, { timeout: 60_000 }, async () => {
    const s = store(kind);
    const env = { DN_NO_TOOL: '1', DN_WORDS: words.join(' '), DN_GAP_MS: '30' };
    const [a, b] = await Promise.all([node(s, env), node(s, env)]);
    const first = await readEvents(await post(a, '/start?stream=1', { runId: 'chat' }), (_e, all) => all.filter((x) => x.kind === 'text').length >= 3);
    // The reader's cursor: the last event, and how much of the next one's text it holds (live deltas).
    const last = first[first.length - 1];
    const rest = await readEvents(await fetch(b.url(`/events?runId=chat&after=${last.seq}${last.offset ? `.${last.offset}` : ''}`)));
    const all = [...first, ...rest];
    const seqs = all.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(textOf(all)).toBe(words.map((w) => `${w} `).join(''));
    expect(finalState(all)).toBe('completed');
    const late = await readEvents(await fetch(b.url('/events?runId=chat')));
    expect(textOf(late)).toBe(words.map((w) => `${w} `).join(''));
    console.log(`[S1 ${kind}] firstLeg=${first.length} rest=${rest.length} events=${all.length} lateReader=${late.length}`);
  });

  it(`S1-ttft ${kind}: time to first text, detached+streamed vs today's in-request stream (median of 30)`, { timeout: 120_000 }, async () => {
    const s = store(kind);
    const n = await node(s, { DN_NO_TOOL: '1', DN_WORDS: 'a b c', DN_GAP_MS: '1' });
    for (let i = 0; i < 3; i++) { await timeToFirstText(n, '/direct-stream', `warm-d-${i}`); await timeToFirstText(n, '/start?stream=1', `warm-s-${i}`); }
    const base: number[] = [];
    const cand: number[] = [];
    for (let i = 0; i < 30; i++) {
      base.push(await timeToFirstText(n, '/direct-stream', `d-${i}`));
      cand.push(await timeToFirstText(n, '/start?stream=1', `s-${i}`));
    }
    console.log(`[S1-ttft ${kind}] baseline median=${median(base).toFixed(1)}ms p95=${p95(base).toFixed(1)} | detached median=${median(cand).toFixed(1)}ms p95=${p95(cand).toFixed(1)} | delta=${(median(cand) - median(base)).toFixed(1)}ms`);
    expect(cand.every((x) => x > 0)).toBe(true);
  });

  it(`S2 ${kind}: a long tool — HTTP not held, status events, completion, one completion notice`, { timeout: 60_000 }, async () => {
    const s = store(kind);
    const env = { DN_TOOL_MS: '3000', DN_WORDS: 'report ready' };
    const [a, b] = await Promise.all([node(s, env), node(s, env)]);
    const t0 = performance.now();
    const started = await (await post(a, '/start', { runId: 'job' })).json();
    const answeredIn = performance.now() - t0;
    const effectsAtAnswer = effectCount(s); // the 3 s tool has not finished when the caller is answered
    const evs = await readEvents(await fetch(b.url('/events?runId=job')));
    await sleep(200);
    const statuses = evs.filter((e) => e.kind === 'status').map((e) => e.data.state + (e.data.tool ? `:${e.data.tool}` : ''));
    const hooks = linesOf(`${s.effects}.hooks`);
    console.log(`[S2 ${kind}] started=${started.state} answeredIn=${answeredIn.toFixed(0)}ms statuses=${JSON.stringify(statuses)} hooks=${JSON.stringify(hooks)} effects=${effectCount(s)}`);
    expect(effectsAtAnswer).toBe(0);
    expect(statuses).toContain('tool:effect');
    expect(finalState(evs)).toBe('completed');
    expect(hooks).toHaveLength(1);
    expect(effectCount(s)).toBe(1);
  });

  it(`S3 ${kind}: approval — waits, approved through ANOTHER process, the observer sees it continue`, { timeout: 60_000 }, async () => {
    const s = store(kind);
    const env = { DN_CONFIRM: '1', DN_WORDS: 'approved and done', ...(kind === 'postgres' ? { DN_SIGNAL: 'notify' } : {}) };
    const [a, b] = await Promise.all([node(s, env), node(s, env)]);
    const firstLeg = await readEvents(await post(a, '/start?stream=1', { runId: 'appr' }), (e) => e.kind === 'status' && e.data.state === 'waiting-approval');
    // An observer on A stays attached while a human approves on B.
    const observed = readEvents(await fetch(a.url(`/events?runId=appr&after=${firstLeg[firstLeg.length - 1].seq}`)));
    await sleep(300);
    expect(effectCount(s)).toBe(0);
    const approved = await (await post(b, '/start', { runId: 'appr', approvals: { 'call-1': true } })).json();
    const evs = await observed;
    console.log(`[S3 ${kind}] approved=${approved.state} observerSaw=${JSON.stringify(evs.filter((e) => e.kind === 'status').map((e) => e.data.state))} effects=${effectCount(s)}`);
    expect(approved.state).toBe('resumed');
    expect(finalState(evs)).toBe('completed');
    expect(textOf([...firstLeg, ...evs])).toBe('approved and done ');
    expect(effectCount(s)).toBe(1);
  });
});
