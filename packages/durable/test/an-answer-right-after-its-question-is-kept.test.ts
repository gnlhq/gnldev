// A run that stops on a question answers its caller as soon as its ending is in the log; its execution
// record is parked a moment later. A resume carrying the answer that arrived in between attached to the
// ending execution and was told the question again: the answer was dropped, the effect never ran (seen in
// the public CI's upgrade test U4, then 5 of 1,000 rounds on Postgres under load). Here the park is held
// back 50 ms, so every resume lands in that moment — by the same executor, and by another one.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { InMemoryStorage, createGnl, gnlTool, user } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { EXEC_PREFIX } from '../src/exec-record.js';
import { createMockModel, toolCallResult, finalTextResult } from './mock.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** `storage` whose runs journal parks an execution record `ms` late. */
function slowPark<S extends { runs: any }>(storage: S, ms = 50): S {
  const runs = new Proxy(storage.runs, {
    get(t, k) {
      if (k === 'putIfMatch') {
        return async (key: string, expected: unknown, next: any) => {
          if (key.startsWith(EXEC_PREFIX) && next?.status === 'parked') await new Promise((r) => setTimeout(r, ms));
          return t.putIfMatch(key, expected, next);
        };
      }
      const v = t[k];
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  return new Proxy(storage, { get: (t, k) => (k === 'runs' ? runs : (t as any)[k]) });
}

function agentsWith(paid: string[]) {
  const pay = gnlTool({ description: 'pay', inputSchema: z.object({ amt: z.number() }), execute: async (a: any) => { paid.push(`pay:${a.amt}`); return { ok: true }; } }, { sideEffect: true, confirm: true });
  const model = createMockModel(async ({ prompt }: any) => (prompt.some((x: any) => x.role === 'tool') ? finalTextResult('paid') : toolCallResult('pay', 'call_0', { amt: 5 })));
  return { payer: { model, tools: { pay } } };
}

const ROUNDS = 5;

describe('an answer that arrives right after its question is kept', () => {
  it('by the executor that asked: the resume runs the approved call', async () => {
    const paid: string[] = [];
    const g = createGnl({ storage: slowPark(new InMemoryStorage()), agents: agentsWith(paid), memory: false } as any);
    const answers: string[] = [];
    for (let i = 0; i < ROUNDS; i++) {
      const first: any = await g.run('payer', { runId: `r${i}`, prompt: 'go', caller: user('ayse') } as any);
      const again: any = await g.run('payer', { runId: `r${i}`, prompt: 'go', caller: user('ayse'), approvals: { [first.interrupts[0].toolCallId]: true } } as any);
      answers.push(again.interrupts.length ? 'asked again' : again.text);
    }
    expect({ answers, paid: paid.length }).toEqual({ answers: Array(ROUNDS).fill('paid'), paid: ROUNDS });
  });

  it('by another executor on the same store: the resume runs the approved call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gnl-answer-'));
    dirs.push(dir);
    const file = join(dir, 'app.db');
    const paid: string[] = [];
    const asker = createGnl({ storage: slowPark(new SqliteStorage(file)), agents: agentsWith(paid), memory: false } as any);
    const answerer = createGnl({ storage: new SqliteStorage(file), agents: agentsWith(paid), memory: false } as any);
    const answers: string[] = [];
    for (let i = 0; i < ROUNDS; i++) {
      const first: any = await asker.run('payer', { runId: `r${i}`, prompt: 'go', caller: user('ayse') } as any);
      const again: any = await answerer.run('payer', { runId: `r${i}`, prompt: 'go', caller: user('ayse'), approvals: { [first.interrupts[0].toolCallId]: true } } as any);
      answers.push(again.interrupts.length ? 'asked again' : again.text);
    }
    expect({ answers, paid: paid.length }).toEqual({ answers: Array(ROUNDS).fill('paid'), paid: ROUNDS });
  });

  it('when the run is not given back (a process frozen after its ending), the answer is refused as busy — never dropped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gnl-answer-'));
    dirs.push(dir);
    const file = join(dir, 'app.db');
    const paid: string[] = [];
    const asker = createGnl({ storage: slowPark(new SqliteStorage(file), 7_000), agents: agentsWith(paid), memory: false } as any);
    const answerer = createGnl({ storage: new SqliteStorage(file), agents: agentsWith(paid), memory: false } as any);
    const first: any = await asker.run('payer', { runId: 'r-frozen', prompt: 'go', caller: user('ayse') } as any);
    const t0 = Date.now();
    const again = await answerer.run('payer', { runId: 'r-frozen', prompt: 'go', caller: user('ayse'), approvals: { [first.interrupts[0].toolCallId]: true } } as any)
      .then((r: any) => (r.interrupts.length ? 'asked again' : r.text), (e: any) => e?.name);
    expect({ again, paid: paid.length, waited: Date.now() - t0 >= 5_000 }).toEqual({ again: 'RunBusyError', paid: 0, waited: true });
    // Once the run is given back, the same answer runs it.
    await new Promise((r) => setTimeout(r, 2_500));
    const later: any = await answerer.run('payer', { runId: 'r-frozen', prompt: 'go', caller: user('ayse'), approvals: { [first.interrupts[0].toolCallId]: true } } as any);
    expect({ later: later.text, paid: paid.length }).toEqual({ later: 'paid', paid: 1 });
  }, 30_000);
});
