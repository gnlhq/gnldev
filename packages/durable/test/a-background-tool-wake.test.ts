// A BACKGROUND TOOL's wake, where its first cut left it short of its promises (raporlar/2026-10-12-deferred,
// "Açık riskler"). Real processes on one store, as in a-background-tool-across-processes.test.ts.
//
//   W1 the agent is woken EXACTLY once — also when the store fails the wake's first write (it is a
//      failure of the store, not of the task: the wake is done again, not dropped);
//   W2 … and when the process dies after the task ended and before its wake wrote anything (another
//      process ends the task again, and that ending wakes the agent);
//   W3 a task stopped for a human (its body's process died with no way to know whether the effect ran)
//      is continued by the human's answer — the answer reaches the TASK, as its owner, and nobody else's
//      answer does;
//   W4 two tasks of one thread that end together wake the agent one after the other: no continuation
//      answers from a history the other is still writing into.
import { describe, it, expect, afterEach } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { newStore, startNode, post, waitFor, stopNode, sleep, linesOf, effectCount, PG_BASE, type Node, type Store } from './detached/harness.js';

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'deferred-node.ts');
const live: Node[] = [];
const stores: Store[] = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map(stopNode));
  stores.splice(0).forEach((s) => s.drop());
});
const store = (kind: 'sqlite' | 'postgres' = 'sqlite') => { const s = newStore(kind, 'dr2'); stores.push(s); return s; };
const node = async (s: Store, env: Record<string, string> = {}) => { const n = await startNode(s, env, fixture); live.push(n); return n; };
const get = async (n: Node, path: string) => (await fetch(n.url(path))).json();
const thread = (n: Node, threadId: string): Promise<Array<{ role: string; text: string }>> => get(n, `/thread?threadId=${encodeURIComponent(threadId)}`);
const results = (msgs: Array<{ role: string; text: string }>) => msgs.filter((m) => m.role === 'user' && m.text.startsWith('Background task'));
const calls = (s: Store) => linesOf(`${s.effects}.calls`).map((l) => l.split(' '));
const contCalls = (s: Store) => calls(s).filter((c) => c[1] === 'cont');
const done = async (n: Node, runId: string) => (await get(n, `/outcome?runId=${encodeURIComponent(runId)}`))?.status === 'completed';

const kinds: Array<'sqlite' | 'postgres'> = PG_BASE ? ['sqlite', 'postgres'] : ['sqlite'];

describe.each(kinds)('W1/W2 the agent is woken exactly once (%s)', (kind) => {
  it(`W1 ${kind}: the store fails the wake's first write — the wake is done again, once`, { timeout: 60_000 }, async () => {
    const s = store(kind);
    const env = { DF_TASK_MS: '300', DF_FAULT: 'wake-error', DF_SWEEP_MS: '200' };
    const a = await node(s, env);
    const b = await node(s, env);
    await post(a, '/chat', { runId: 'w1', threadId: 'TW1', text: 'research tides' });
    await waitFor(() => existsSync(`${s.effects}.faulted`), 20_000, 'the injected store error');
    await waitFor(() => done(b, 'cont:w1:call-1'), 20_000, 'the continuation after the store error');
    await sleep(1_500); // every sweep that could wake it again
    expect(effectCount(s), 'side effects').toBe(1);
    expect(results(await thread(b, 'TW1')).length, 'result messages').toBe(1);
    expect(contCalls(s).length, 'wakes').toBe(1);
  });

  it(`W2 ${kind}: SIGKILL after the task ended, before its wake wrote — another process wakes the agent, once`, { timeout: 60_000 }, async () => {
    const s = store(kind);
    const env = { DF_TASK_MS: '300', DF_KILL: 'before-wake', DF_SWEEP_MS: '200' };
    const a = await node(s, env);
    const b = await node(s, env);
    const c = await node(s, env);
    await post(a, '/chat', { runId: 'w2', threadId: 'TW2', text: 'research waves' }).catch(() => undefined);
    await waitFor(() => linesOf(`${s.effects}.killed`).length > 0, 20_000, 'the kill before the wake');
    await waitFor(() => done(b, 'cont:w2:call-1'), 20_000, 'the continuation, elsewhere');
    await sleep(1_500);
    expect(effectCount(s), 'side effects').toBe(1);
    expect(results(await thread(b, 'TW2')).length, 'result messages').toBe(1);
    expect(contCalls(s).length, 'wakes').toBe(1);
    void c;
  });
});

describe('W3 a task stopped for a human is continued by the human', () => {
  it('W3: SIGKILL mid-body, no recover() — the task waits; a stranger cannot answer it; its owner\'s approval runs it, once, and wakes the agent', { timeout: 60_000 }, async () => {
    const s = store();
    const env = { DF_TASK_MS: '1500', DF_SWEEP_MS: '200' };
    const a = await node(s, env);
    const b = await node(s, env);
    await post(a, '/chat', { runId: 'w3', threadId: 'TW3', text: 'research reefs' });
    await waitFor(() => linesOf(`${s.effects}.started`).length === 1, 10_000, 'the body to start');
    a.kill('SIGKILL');
    // Taken over: the call was in flight and nothing can say whether its effect happened — a human decides.
    await sleep(3_000);
    expect(effectCount(s), 'an effect ran without the human').toBe(0);
    expect(contCalls(s), 'the agent was woken before the task ended').toEqual([]);

    const stranger = await post(b, '/chat', { runId: 'task:w3:call-1', threadId: 'TW3', caller: 'mallory', approvals: { 'call-1': true } });
    expect(stranger.status, 'a stranger answered somebody else\'s task').toBe(404);
    await sleep(1_000);
    expect(effectCount(s), 'the stranger\'s answer ran the effect').toBe(0);

    const owner = await post(b, '/chat', { runId: 'task:w3:call-1', threadId: 'TW3', approvals: { 'call-1': true } });
    expect(owner.status, await owner.clone().text()).toBe(200);
    await waitFor(() => done(b, 'cont:w3:call-1'), 20_000, 'the continuation after the approval');
    await sleep(1_000);
    expect(effectCount(s), 'side effects').toBe(1);
    expect(results(await thread(b, 'TW3')).length, 'result messages').toBe(1);
    expect(contCalls(s).length, 'wakes').toBe(1);
  });
});

describe('W4 two tasks of one thread that end together', () => {
  it('W4: their continuations run one after the other — each answers from a history the other is not writing into', { timeout: 60_000 }, async () => {
    const s = store();
    // The two tasks end on one tick; call-1's wake is slow to write after it looked at the thread (a slow
    // store) — so call-2's wake looks while call-1's continuation is decided and not yet born.
    const env = { DF_TASK_MS: '600', DF_TASK_ALIGN: '1', DF_WAKE_DELAY: 'call-1:150', DF_CONT_MS: '250', DF_SWEEP_MS: '200' };
    const a = await node(s, env);
    const b = await node(s, env);
    await post(a, '/chat', { runId: 'w4', threadId: 'TW4', text: 'twin tides' });
    await waitFor(async () => (await done(a, 'cont:w4:call-1')) && (await done(a, 'cont:w4:call-2')), 30_000, 'both continuations');
    const all = calls(s);
    const windows = ['call-1', 'call-2'].map((c) => {
      const tag = `task:w4:${c}`;
      const start = all.find((x) => x[1] === 'cont' && x.slice(3).join(' ').includes(tag));
      const end = all.find((x) => x[1] === 'cont-end' && x.slice(3).join(' ').includes(tag));
      return { c, start: Number(start?.[2]), end: Number(end?.[2]) };
    }).sort((x, y) => x.start - y.start);
    expect(windows.every((w) => w.start > 0 && w.end >= w.start), JSON.stringify(windows)).toBe(true);
    expect(windows[1]!.start, `the second continuation started while the first was answering: ${JSON.stringify(windows)}`).toBeGreaterThanOrEqual(windows[0]!.end);
    expect(effectCount(s), 'side effects').toBe(2);
    expect(results(await thread(a, 'TW4')).length, 'result messages').toBe(2);
    expect(contCalls(s).length, 'wakes').toBe(2);
    void b;
  });
});
