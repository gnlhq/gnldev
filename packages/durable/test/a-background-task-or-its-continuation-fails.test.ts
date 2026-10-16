// A background task, or the continuation it wakes, that FAILS — not a crash: an ending. Each follows what
// any agent run gets when it fails, and nothing is lost or repeated.
//
//   F1 the task's run fails before its call ran (the store refuses the call's record): the task has
//      ended — failed, with the run's error — and the agent is woken once to hear it. Before: the task's
//      ending threw "ended before its call was settled", the next sweep executed the task again, and so
//      on every sweep for good; the agent was never woken.
//   F2 the continuation's model call fails: the continuation ends failed, like a failed turn — the
//      result stays in the thread once, nothing executes it again by itself, and its owner's retry
//      (naming the run, as for any failed run) answers once; a stranger naming it is refused.
import { describe, it, expect, afterEach } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newStore, startNode, post, waitFor, stopNode, sleep, linesOf, type Node, type Store } from './detached/harness.js';

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'deferred-node.ts');
const live: Node[] = [];
const stores: Store[] = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map(stopNode));
  stores.splice(0).forEach((s) => s.drop());
});
const store = () => { const s = newStore('sqlite'); stores.push(s); return s; };
const node = async (s: Store, env: Record<string, string> = {}) => { const n = await startNode(s, env, fixture); live.push(n); return n; };
const get = async (n: Node, path: string) => (await fetch(n.url(path))).json();
const thread = (n: Node, threadId: string): Promise<Array<{ role: string; text: string }>> => get(n, `/thread?threadId=${encodeURIComponent(threadId)}`);
const results = (msgs: Array<{ role: string; text: string }>) => msgs.filter((m) => m.role === 'user' && m.text.startsWith('Background task'));
const contCalls = (s: Store) => linesOf(`${s.effects}.calls`).filter((l) => l.split(' ')[1] === 'cont');
const outcome = async (n: Node, runId: string) => (await get(n, `/outcome?runId=${encodeURIComponent(runId)}`))?.status as string | undefined;

describe('F1 a task whose call never ran ends failed and wakes the agent once', () => {
  it('F1: the store refuses the call record every time → one execution, one wake that says failed', { timeout: 60_000 }, async () => {
    const s = store();
    const a = await node(s, { DF_FAULT: 'task-call', DF_SWEEP_MS: '200' });
    const r = await (await post(a, '/chat', { runId: 'p7', threadId: 'T7', text: 'research sand' })).json();
    expect(r.results).toEqual([{ status: 'started', taskId: 'task:p7:call-1' }]);
    await waitFor(async () => (await outcome(a, 'cont:p7:call-1')) === 'completed', 20_000, 'the agent woken about the failed task');
    const tries = linesOf(`${s.effects}.taskfault`).length;
    await sleep(2_000); // every sweep that could execute the task again
    expect(linesOf(`${s.effects}.taskfault`).length, 'the task executed again after it ended').toBe(tries);
    expect(linesOf(`${s.effects}.started`).length, 'the body ran').toBe(0);
    const msgs = results(await thread(a, 'T7'));
    expect(msgs.length, 'result messages').toBe(1);
    expect(msgs[0]!.text).toContain('failed');
    expect(contCalls(s).length, 'wakes').toBe(1);
  });
});

describe('F2 a continuation that fails is a failed turn', () => {
  it('F2: its model call fails → ended failed, not executed again by itself; its owner retries it once, a stranger cannot', { timeout: 60_000 }, async () => {
    const s = store();
    const a = await node(s, { DF_CONT_FAIL: 'once', DF_TASK_MS: '200', DF_SWEEP_MS: '200' });
    await post(a, '/chat', { runId: 'p8', threadId: 'T8', text: 'research rock' });
    await waitFor(async () => (await outcome(a, 'cont:p8:call-1')) === 'failed', 20_000, 'the continuation to fail');
    await sleep(2_000); // every sweep that could execute it again
    expect(contCalls(s).length, 'model calls of the continuation').toBe(1);
    expect(results(await thread(a, 'T8')).length, 'the result is in the thread once').toBe(1);

    const stranger = await post(a, '/chat', { runId: 'cont:p8:call-1', threadId: 'T8', text: 'x', caller: 'mallory' });
    expect(stranger.status, 'a stranger naming the continuation').toBe(404);
    const retried = await post(a, '/chat', { runId: 'cont:p8:call-1', threadId: 'T8', text: 'again' });
    expect(retried.status, await retried.clone().text()).toBe(200);
    expect(await outcome(a, 'cont:p8:call-1')).toBe('completed');
    const msgs = await thread(a, 'T8');
    expect(results(msgs).length, 'the result is in the thread once').toBe(1);
    expect(msgs.filter((m) => m.role === 'assistant' && m.text.includes('noted:')).length, 'answers').toBe(1);
    expect(msgs.some((m) => m.text.includes('again')), 'the retry\'s own text in the thread').toBe(false);
    expect(contCalls(s).length).toBe(2);
  });
});
