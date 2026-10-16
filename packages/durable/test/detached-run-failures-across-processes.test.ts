// S4 — side-effect executions under failure, with REAL processes on a shared Sqlite file and Postgres.
// One side effect = one line in a file outside the database. It must be exactly 1 everywhere; where
// that is physically undecidable, the run must stop and ask a human instead of running again.
import { describe, it, expect, afterEach } from 'vitest';
import { newStore, startNode, post, readEvents, effectCount, linesOf, waitFor, stopNode, sleep, PG_BASE, type Node, type Store } from './detached/harness.js';
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
const followAll = async (n: Node, runId: string, after = 0) => readEvents(await fetch(n.url(`/events?runId=${runId}&after=${after}`)));
const dump = (tag: string, s: Store, evs: any[]) => console.log(`[${tag}] effects=${JSON.stringify(linesOf(s.effects))} started=${JSON.stringify(linesOf(`${s.effects}.started`))} events=${JSON.stringify(evs.map((e) => [e.seq, e.kind, e.step, e.kind === 'status' || e.kind === 'error' || e.kind === 'step-retry' || e.kind === 'tool-result' ? e.data : '']))}`);
const finalState = (evs: any[]) => evs.filter((e) => e.kind === 'status').map((e) => e.data.state).pop();

describe.each(kinds)('S4 on %s', (kind) => {
  it(`S4a ${kind}: the same request 5 times concurrently, on two processes → one execution`, { timeout: 60_000 }, async () => {
    const s = store(kind);
    const env = { DN_TOOL_MS: '800' };
    const [a, b] = await Promise.all([node(s, env), node(s, env)]);
    const res = await Promise.all([a, b, a, b, a].map((n) => post(n, '/start', { runId: 'r-4a' }).then((r) => r.json())));
    const states = res.map((r: any) => r.state).sort();
    expect(states.filter((x: string) => x === 'started')).toHaveLength(1);
    const evs = await followAll(b, 'r-4a');
    expect(finalState(evs)).toBe('completed');
    expect(effectCount(s)).toBe(1);
    console.log(`[S4a ${kind}] states=${JSON.stringify(states)} effects=${effectCount(s)}`);
  });

  it(`S4b ${kind}: the executing process is frozen with SIGSTOP past claimTtl → not taken over, one execution`, { timeout: 60_000 }, async () => {
    const s = store(kind);
    const env = { DN_TOOL_MS: '1500', DN_CLAIM_TTL: '1000', DN_RECOVER: '1', DN_SWEEP_MS: '200' };
    const a = await node(s, env);
    const b = await node(s, env);
    expect((await (await post(a, '/start', { runId: 'r-4b' })).json()).state).toBe('started');
    await waitFor(() => linesOf(`${s.effects}.started`).length === 1, 10_000, 'tool body started on A');
    a.kill('SIGSTOP');
    const frozenAt = Date.now();
    // While A is frozen past 4× its claim TTL: B sweeps, a client retries 5 times on B, and an operator
    // continues the run on B by the in-request path (no execution record): nothing executes.
    const retries = await Promise.all(Array.from({ length: 5 }, () => post(b, '/start', { runId: 'r-4b' }).then((r) => r.json())));
    const direct = await (await post(b, '/direct', { runId: 'r-4b' })).json();
    await sleep(4_000 - (Date.now() - frozenAt));
    const duringFreeze = effectCount(s);
    const pending = await (await fetch(b.url('/pending?quiet=1000'))).json();
    a.kill('SIGCONT');
    const evs = await followAll(b, 'r-4b');
    dump('S4b', s, evs);
    console.log(`[S4b ${kind}] retries=${JSON.stringify(retries.map((r: any) => r.state))} direct=${JSON.stringify(direct).slice(0, 160)} duringFreeze=${duringFreeze} pending=${JSON.stringify(pending)} final=${finalState(evs)} effects=${effectCount(s)}`);
    expect(retries.every((r: any) => r.state === 'attached')).toBe(true);
    expect(direct.ok).not.toBe(true); // the claim's process is alive: busy, never the crash ladder
    expect(duringFreeze).toBe(0);
    expect(finalState(evs)).toBe('completed');
    expect(effectCount(s)).toBe(1);
  });

  it(`S4b-baseline ${kind}: today's claim-by-age, same freeze → the effect runs twice (E6 reproduced)`, { timeout: 60_000 }, async () => {
    const s = store(kind);
    const env = { DN_TOOL_MS: '1500', DN_CLAIM_TTL: '1000', DN_RECOVER: '1', DN_BASELINE: '1' };
    const a = await node(s, env);
    const b = await node(s, env);
    const first = post(a, '/direct', { runId: 'r-4b0' }).then((r) => r.json()).catch(() => undefined);
    await waitFor(() => linesOf(`${s.effects}.started`).length === 1, 10_000, 'tool body started on A');
    a.kill('SIGSTOP');
    await sleep(2_500);
    const retry = await (await post(b, '/direct', { runId: 'r-4b0' })).json();
    a.kill('SIGCONT');
    await first;
    await sleep(500);
    dump('S4b0', s, []);
    console.log(`[S4b-baseline ${kind}] retry=${JSON.stringify(retry).slice(0, 300)} effects=${effectCount(s)}`);
    expect(effectCount(s)).toBe(2);
  });

  it(`S4c ${kind}: SIGKILL after the effect, before its record; recover() answers → another process continues, one execution`, { timeout: 60_000 }, async () => {
    const s = store(kind);
    const env = { DN_TOOL_MS: '200', DN_AFTER_MS: '3000', DN_RECOVER: '1', DN_SWEEP_MS: '200' };
    const a = await node(s, env);
    const b = await node(s, env);
    await post(a, '/start', { runId: 'r-4c' });
    await waitFor(() => effectCount(s) === 1, 10_000, 'effect landed on A');
    a.kill('SIGKILL');
    await a.exited;
    const evs = await followAll(b, 'r-4c');
    dump('S4c', s, evs);
    console.log(`[S4c ${kind}] final=${finalState(evs)} effects=${effectCount(s)} text=${JSON.stringify(textOf(evs))}`);
    expect(finalState(evs)).toBe('completed');
    expect(effectCount(s)).toBe(1);
    expect(evs.some((e) => e.kind === 'step-retry')).toBe(true);
  });

  it(`S4c-undecidable ${kind}: same kill, no recover() → the run stops and asks a human; nothing runs again`, { timeout: 60_000 }, async () => {
    const s = store(kind);
    const env = { DN_TOOL_MS: '200', DN_AFTER_MS: '3000', DN_SWEEP_MS: '200' };
    const a = await node(s, env);
    const b = await node(s, env);
    await post(a, '/start', { runId: 'r-4cu' });
    await waitFor(() => effectCount(s) === 1, 10_000, 'effect landed on A');
    a.kill('SIGKILL');
    await a.exited;
    const evs = await readEvents(await fetch(b.url('/events?runId=r-4cu')), (e) => e.kind === 'status' && e.data.state === 'waiting-approval');
    const pending = await (await fetch(b.url('/pending?quiet=600000'))).json();
    dump('S4cu', s, evs);
    console.log(`[S4c-undecidable ${kind}] last=${finalState(evs)} pending=${JSON.stringify(pending)} effects=${effectCount(s)}`);
    expect(finalState(evs)).toBe('waiting-approval');
    expect(pending.some((p: any) => p.runId === 'r-4cu' && p.status === 'parked')).toBe(true);
    expect(effectCount(s)).toBe(1);
  });

  it(`S4d ${kind}: SIGTERM during a tool → drain: 503, the tool finishes, no next step, exit; another process finishes the run`, { timeout: 60_000 }, async () => {
    const s = store(kind);
    const env = { DN_TOOL_MS: '1500', DN_SWEEP_MS: '200', DN_WORDS: 'after the tool' };
    const a = await node(s, env);
    const b = await node(s, env);
    await post(a, '/start', { runId: 'r-4d' });
    await waitFor(() => linesOf(`${s.effects}.started`).length === 1, 10_000, 'tool body started on A');
    a.kill('SIGTERM');
    await sleep(100);
    const refused = await post(a, '/start', { runId: 'r-4d-new' }).then((r) => r.status, () => 'closed');
    const code = await a.exited;
    const effectsAtExit = effectCount(s);
    const evs = await followAll(b, 'r-4d');
    const drain = linesOf(`${s.effects}.drain`);
    console.log(`[S4d ${kind}] refused=${refused} exit=${code} effectsAtExit=${effectsAtExit} final=${finalState(evs)} effects=${effectCount(s)} text=${JSON.stringify(textOf(evs))} drain=${JSON.stringify(drain)}`);
    expect(refused).toBe(503);
    expect(code).toBe(0);
    expect(effectsAtExit).toBe(1); // the running tool finished before the exit
    expect(finalState(evs)).toBe('completed');
    expect(textOf(evs)).toBe('after the tool ');
    expect(effectCount(s)).toBe(1);
  });
});
