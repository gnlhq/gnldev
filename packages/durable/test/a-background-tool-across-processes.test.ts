// A BACKGROUND TOOL (`gnlTool(t, { background: true })`) across real processes on one store.
//
// The model is answered at once with `{ status: 'started', taskId }` and the turn ends; the body runs
// as its own run (`task:<parentRunId>:<toolCallId>`), and when it ends the agent is woken by ONE
// continuation run (`cont:<parentRunId>:<toolCallId>`) whose question is the result. Promised here:
//   D1 the result reaches the thread exactly once — also when a process dies around that write;
//   D2 the agent is woken exactly once — also when the task's end is delivered twice (a process died
//      while it was waking it, another replays it) and two processes race to continue;
//   D3 the side effect runs once — SIGKILL mid-body (recover() answers), SIGSTOP (never taken over);
//   D4 a person or thread erased while the task runs gets nothing back (Sqlite and Postgres);
//   D5 the user keeps writing while the task runs: the continuation waits for the live turn and the
//      thread reads in order.
import { describe, it, expect, afterEach } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { newStore, startNode, post, waitFor, stopNode, sleep, linesOf, effectCount, PG_BASE, type Node, type Store } from './detached/harness.js';

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'deferred-node.ts');
const live: Node[] = [];
const stores: Store[] = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map(stopNode));
  stores.splice(0).forEach((s) => s.drop());
});
const store = (kind: 'sqlite' | 'postgres' = 'sqlite') => { const s = newStore(kind, 'deferred'); stores.push(s); return s; };
const node = async (s: Store, env: Record<string, string> = {}) => { const n = await startNode(s, env, fixture); live.push(n); return n; };
const get = async (n: Node, path: string) => (await fetch(n.url(path))).json();
const chat = async (n: Node, body: Record<string, unknown>) => (await post(n, '/chat', body)).json();
const thread = (n: Node, threadId: string): Promise<Array<{ role: string; text: string }>> => get(n, `/thread?threadId=${encodeURIComponent(threadId)}`);
const results = (msgs: Array<{ role: string; text: string }>) => msgs.filter((m) => m.role === 'user' && m.text.startsWith('Background task'));
const contCalls = (s: Store) => linesOf(`${s.effects}.calls`).filter((l) => l.split(' ')[1] === 'cont');
const done = async (n: Node, runId: string) => (await get(n, `/outcome?runId=${encodeURIComponent(runId)}`))?.status === 'completed';

describe('D1/D2 the result is written once and the agent woken once (Sqlite file, real processes)', () => {
  it('D1 no crash: the model hears "started" before the body ends; then one result and one answer in the thread', { timeout: 60_000 }, async () => {
    const s = store();
    const a = await node(s, { DF_TASK_MS: '1500' });
    const r = await chat(a, { runId: 'p1', threadId: 'T1', text: 'research tides' });
    expect(r.results, 'what the model was answered').toEqual([{ status: 'started', taskId: 'task:p1:call-1' }]);
    expect(effectCount(s), 'the turn waited for the body').toBe(0);
    await waitFor(() => done(a, 'cont:p1:call-1'), 20_000, 'the continuation');
    const msgs = await thread(a, 'T1');
    expect(results(msgs).length, 'result messages in the thread').toBe(1);
    expect(msgs[msgs.length - 1]).toMatchObject({ role: 'assistant' });
    expect(msgs[msgs.length - 1]!.text).toContain('noted:');
    expect(effectCount(s)).toBe(1);
    expect(contCalls(s).length, 'model calls of the continuation').toBe(1);
  });

  for (const point of ['body-end', 'before-write', 'after-write', 'after-answer'] as const) {
    it(`D1/D2 SIGKILL at ${point}: another process continues — effect 1, result 1, wake 1`, { timeout: 60_000 }, async () => {
      const s = store();
      const env = { DF_TASK_MS: '400', DF_RECOVER: '1', DF_KILL: point, DF_SWEEP_MS: '200' };
      const a = await node(s, env);
      // Two more processes race to continue what `a` leaves (the task's end delivered again, twice over).
      const b = await node(s, env);
      const c = await node(s, env);
      await post(a, '/chat', { runId: 'p2', threadId: 'T2', text: 'research waves' }).catch(() => undefined);
      await waitFor(() => linesOf(`${s.effects}.killed`).length > 0, 20_000, `the kill at ${point}`);
      await waitFor(() => done(b, 'cont:p2:call-1'), 30_000, 'the continuation, elsewhere');
      await sleep(1_500); // every sweep that could still wake it again
      const msgs = await thread(b, 'T2');
      expect(effectCount(s), 'side effects').toBe(1);
      expect(results(msgs).length, 'result messages in the thread').toBe(1);
      expect(msgs.filter((m) => m.role === 'assistant' && m.text.includes('noted:')).length, 'continuation answers').toBe(1);
      expect(contCalls(s).length, 'model calls of the continuation').toBe(1);
      void c;
    });
  }

  for (const kind of ['sqlite', 'postgres'] as const) {
    it.skipIf(kind === 'postgres' && !PG_BASE)(`D2 SIGKILL while the continuation is answering (${kind}): another process answers — one answer, wake 1`, { timeout: 60_000 }, async () => {
      const s = store(kind);
      // The continuation's answer streams slowly enough that the kill lands between its words.
      const env = { DF_TASK_MS: '300', DF_KILL: 'mid-answer', DF_CONT_MS: '150', DF_SWEEP_MS: '200' };
      const a = await node(s, env);
      const b = await node(s, env);
      await chat(a, { runId: 'p7', threadId: 'T7', text: 'research currents' });
      await waitFor(() => linesOf(`${s.effects}.killed`).length > 0, 20_000, 'the kill mid-answer');
      await waitFor(() => done(b, 'cont:p7:call-1'), 30_000, 'the continuation, elsewhere');
      await sleep(1_500); // every sweep that could still wake it again
      const msgs = await thread(b, 'T7');
      expect(effectCount(s), 'side effects').toBe(1);
      expect(results(msgs).length, 'result messages in the thread').toBe(1);
      const answers = msgs.filter((m) => m.role === 'assistant' && m.text.includes('noted:'));
      expect(answers.length, 'continuation answers').toBe(1);
      expect(answers[0]!.text, 'the answer is whole, not the killed half').toContain('Background task');
      // The killed attempt called the model once; the one that answered, once more — never a third wake.
      expect(contCalls(s).length, 'model calls of the continuation').toBe(2);
    });
  }
});

describe('D3 the side effect runs once', () => {
  it('D3 SIGKILL mid-body: recover() says it never happened, the body runs once elsewhere', { timeout: 60_000 }, async () => {
    const s = store();
    const env = { DF_TASK_MS: '1500', DF_RECOVER: '1', DF_SWEEP_MS: '200' };
    const a = await node(s, env);
    const b = await node(s, env);
    await chat(a, { runId: 'p3', threadId: 'T3', text: 'research reefs' });
    await waitFor(() => linesOf(`${s.effects}.started`).length === 1, 10_000, 'the body to start');
    a.kill('SIGKILL');
    await waitFor(() => done(b, 'cont:p3:call-1'), 30_000, 'the continuation');
    expect(effectCount(s)).toBe(1);
    expect(results(await thread(b, 'T3')).length).toBe(1);
    expect(contCalls(s).length).toBe(1);
  });

  it('D3 SIGSTOP mid-body: a frozen process keeps its task — nobody runs the body beside it', { timeout: 60_000 }, async () => {
    const s = store();
    const env = { DF_TASK_MS: '1000', DF_SWEEP_MS: '200' };
    const a = await node(s, env);
    const b = await node(s, env);
    await chat(a, { runId: 'p4', threadId: 'T4', text: 'research ice' });
    await waitFor(() => linesOf(`${s.effects}.started`).length === 1, 10_000, 'the body to start');
    a.kill('SIGSTOP');
    await sleep(3_000);
    expect(linesOf(`${s.effects}.started`).length, 'a second body started beside the frozen one').toBe(1);
    a.kill('SIGCONT');
    await waitFor(() => done(b, 'cont:p4:call-1'), 30_000, 'the continuation');
    expect(effectCount(s)).toBe(1);
    expect(results(await thread(b, 'T4')).length).toBe(1);
    expect(contCalls(s).length).toBe(1);
  });
});

const kinds: Array<'sqlite' | 'postgres'> = PG_BASE ? ['sqlite', 'postgres'] : ['sqlite'];
describe.each(kinds)('D4 erased while the task runs (%s): nothing comes back', (kind) => {
  for (const what of ['subject', 'thread'] as const) {
    it(`D4 ${kind}: erase the ${what} mid-task → no message, no continuation, no events`, { timeout: 60_000 }, async () => {
      const s = store(kind);
      const env = { DF_TASK_MS: '2000', DF_SWEEP_MS: '200' };
      const a = await node(s, env);
      const b = await node(s, env);
      await chat(a, { runId: 'p5', threadId: 'T5', text: 'research dunes' });
      await waitFor(() => linesOf(`${s.effects}.started`).length === 1, 10_000, 'the body to start');
      const erased = await post(b, '/erase', what === 'subject' ? { kind: 'subject', subject: 'alice' } : { kind: 'thread', threadId: 'T5' });
      expect(erased.status, await erased.clone().text()).toBe(200);
      await sleep(5_000); // the body's end, every sweep after it
      expect(await thread(b, 'T5'), 'messages in the erased thread').toEqual([]);
      expect(contCalls(s), 'the agent was woken for an erased conversation').toEqual([]);
      const left = (await get(b, '/keys?prefix=')).filter((k: string) => /p5|T5/.test(k) && !k.startsWith('__run_erased__'));
      expect(left, 'records of the erased conversation').toEqual([]);
    });
  }
});

describe('D5 the user keeps writing while the task runs', () => {
  it('D5 the continuation waits for the live turn; the thread reads in order', { timeout: 60_000 }, async () => {
    const s = store();
    // The task ends when the test says so, not after a fixed time: with a 1.2 s body, a machine slow
    // enough to take that long over the next two turns let the task end in a quiet thread, and the
    // continuation then rightly answered before them ('u a t a R a u a u a' — measured by delaying the
    // second turn 1.5 s, 3/3).
    const gate = `${s.effects}.gate`;
    const a = await node(s, { DF_TASK_GATE: gate, DF_LONG_MS: '80' });
    await chat(a, { runId: 'p6', threadId: 'T6', text: 'research tides' });
    await chat(a, { runId: 'p6b', threadId: 'T6', text: 'hello' });
    // A long answer that is still streaming when the task ends (30 words × 80 ms ≈ 2.4 s): the task is
    // let end once the long turn's model call has begun.
    const long = chat(a, { runId: 'p6c', threadId: 'T6', text: 'long story' });
    await waitFor(() => linesOf(`${s.effects}.calls`).some((l) => l.includes('long story')), 20_000, 'the long turn');
    writeFileSync(gate, '');
    await long;
    await waitFor(() => done(a, 'cont:p6:call-1'), 20_000, 'the continuation');
    const calls = linesOf(`${s.effects}.calls`).map((l) => l.split(' '));
    const contAt = Number(calls.find((c) => c[1] === 'cont')![2]);
    const lastLongCall = Math.max(...calls.filter((c) => c[3]?.includes('long story')).map((c) => Number(c[2])));
    expect(contAt, 'the continuation started inside a live turn').toBeGreaterThan(lastLongCall);
    const msgs = await thread(a, 'T6');
    const roles = msgs.map((m) => (m.role === 'user' && m.text.startsWith('Background task') ? 'R' : m.role[0]));
    // u1 a1(call) t a1(text) | u2 a2 | u3 a3 | R a(answer)
    expect(roles.join(' ')).toBe('u a t a u a u a R a');
  });
});
