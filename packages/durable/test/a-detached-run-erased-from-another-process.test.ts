// T3/T5 across real processes: the run executes on A, the erasure comes from B, on a shared Sqlite file
// and on Postgres. Two kinds of erasure (the person, the run) at two moments (mid-answer, mid-tool).
// After it: nothing of the run is in the store, no completion notice, no execution record, and a
// follower on A ended. Also T4 across processes: another caller naming the run gets 404, not its text.
import { describe, it, expect, afterEach } from 'vitest';
import { newStore, startNode, post, readEvents, waitFor, stopNode, sleep, linesOf, PG_BASE, type Node, type Store } from './detached/harness.js';

const kinds: Array<'sqlite' | 'postgres'> = PG_BASE ? ['sqlite', 'postgres'] : ['sqlite'];
const live: Node[] = [];
const stores: Store[] = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map(stopNode));
  stores.splice(0).forEach((s) => s.drop());
});
const node = async (s: Store, env: Record<string, string>) => { const n = await startNode(s, env); live.push(n); return n; };
const keys = async (n: Node, prefix: string): Promise<string[]> => (await fetch(n.url(`/keys?prefix=${encodeURIComponent(prefix)}`))).json();

const moments = {
  'mid-answer': { env: { DN_NO_TOOL: '1', DN_WORDS: Array.from({ length: 150 }, (_, i) => `w${i}`).join(' '), DN_GAP_MS: '20' }, when: (evs: any[]) => evs.filter((e) => e.kind === 'text').length >= 3 },
  'mid-tool': { env: { DN_TOOL_MS: '2000' }, when: (evs: any[]) => evs.some((e) => e.kind === 'tool-call') },
} as const;

describe.each(kinds)('T3/T5 on %s', (kind) => {
  for (const what of ['subject', 'run'] as const) {
    for (const [moment, m] of Object.entries(moments)) {
      it(`T3 ${kind}: erase the ${what} ${moment} from another process → nothing comes back`, { timeout: 60_000 }, async () => {
        const s = newStore(kind); stores.push(s);
        const a = await node(s, { ...m.env, DN_SWEEP_MS: '300' });
        const b = await node(s, { ...m.env, DN_SWEEP_MS: '300' });
        const res = await post(a, '/start?stream=1', { runId: 'r-x' });
        let erased = false;
        const evs = await Promise.race([
          readEvents(res, (ev, all) => {
            if (!erased && m.when(all)) {
              erased = true;
              void post(b, '/erase', what === 'subject' ? { kind: 'subject', subject: 'alice' } : { kind: 'run', runId: 'r-x' });
            }
            return false;
          }),
          sleep(20_000).then(() => null),
        ]);
        expect(evs, 'the follower of an erased run never ended').not.toBeNull();
        await sleep(3_000); // the executor's last writes, the sweeps
        const left = (await keys(b, '')).filter((k) => k.startsWith('r-x:') || k.includes('r-x'));
        expect(left, 'keys of the erased run in the store').toEqual([]);
        expect(linesOf(`${s.effects}.hooks`), 'a completion notice for an erased run').toEqual([]);
      });
    }
  }

  it(`T4 ${kind}: another caller naming a live run gets 404, not its text`, { timeout: 60_000 }, async () => {
    const s = newStore(kind); stores.push(s);
    const env = { DN_NO_TOOL: '1', DN_WORDS: Array.from({ length: 100 }, (_, i) => `w${i}`).join(' '), DN_GAP_MS: '20' };
    const a = await node(s, env);
    const b = await node(s, env);
    expect((await (await post(a, '/start', { runId: 'r-own', caller: 'alice' })).json()).state).toBe('started');
    const r = await post(b, '/start?stream=1', { runId: 'r-own', caller: 'mallory' });
    expect(r.status).toBe(404);
    expect(await r.text()).not.toContain('w1');
    await waitFor(async () => (await keys(a, '__exec__:')).length === 0, 20_000, 'the run to end');
  });
});
