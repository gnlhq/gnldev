// MOD3 k4 — on a real Postgres: the born-expired lock (Y1) and two schedulers firing in parallel.
// The candidate's DB comes from GNL_PG_URL (mod3_k4_<a|b|c>); every run uses fresh trigger ids.
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { PostgresStorage } from '@gnldev/durable/postgres';
import { scheduleWorkflow, pollScheduler, createScheduler, type WorkflowRunner } from '../../src/index.js';

const PG_URL = process.env.GNL_PG_URL!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const realNow = Date.now;
const tag = `${process.pid}${realNow().toString(36)}`;
let a: PostgresStorage, b: PostgresStorage;
beforeAll(async () => {
  a = new PostgresStorage({ connectionString: PG_URL });
  b = new PostgresStorage({ connectionString: PG_URL });
  await a.runs.get('warm'); await b.runs.get('warm');
  // Hermetic: this candidate's DB starts with no triggers (an earlier run's every-150 ms triggers stay due forever).
  await a.runs.deletePrefix!('sched:');
});
afterAll(async () => { await a.close(); await b.close(); });

describe.skipIf(!PG_URL)('k4 on Postgres', () => {
  it('R3 (Y1) born-expired: behind a long fire in the same poll, a later trigger\'s lock is still live — a correct-clock second poller does not start it again', async () => {
    const starts: string[] = [];
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const runnerA: WorkflowRunner = {
      async runWorkflow(name, _i, o) {
        starts.push(`A ${o!.runId}`);
        if (name === 'long') await sleep(3000); // longer than lockTtlMs
        else await gate;
        return { runId: o!.runId! };
      },
    };
    const runnerB: WorkflowRunner = { async runWorkflow(_n, _i, o) { starts.push(`B ${o!.runId}`); return { runId: o!.runId! }; } };
    const t = realNow();
    await scheduleWorkflow(a.runs, { id: `y1-a-long-${tag}`, name: 'long', at: t }, t);
    await scheduleWorkflow(a.runs, { id: `y1-b-short-${tag}`, name: 'short', at: t }, t);
    const pA = pollScheduler(a.runs, runnerA, realNow(), { owner: 'A', lockTtlMs: 2000 });
    const deadline = realNow() + 8000;
    while (!starts.some((s) => s.includes(`y1-b-short-${tag}`)) && realNow() < deadline) await sleep(5);
    // B polls the moment A's short fire is in hand (in A that is after the long one; elsewhere at once),
    // before the first heartbeat (ttl/3): what B sees is the lock as it was born.
    await pollScheduler(b.runs, runnerB, realNow(), { owner: 'B', lockTtlMs: 2000 });
    open();
    await pA;
    const shortStarts = starts.filter((s) => s.includes(`sched:y1-b-short-${tag}:0`));
    console.log(`[k4 R3] ${JSON.stringify(starts)}`);
    expect(shortStarts.length).toBe(1);
  }, 30_000);

  it('S5 two schedulers on one Postgres, fires running in parallel: every occurrence starts exactly once', async () => {
    const starts = new Map<string, string[]>();
    const runner = (who: string): WorkflowRunner => ({
      async runWorkflow(_n, _i, o) {
        const l = starts.get(o!.runId!) ?? [];
        l.push(who); starts.set(o!.runId!, l);
        await sleep(50 + Math.floor(Math.random() * 300));
        return { runId: o!.runId! };
      },
    });
    const t = realNow();
    for (let i = 0; i < 6; i++) await scheduleWorkflow(a.runs, { id: `s5-${i}-${tag}`, name: `w${i}`, every: 150 + i * 20 }, t);
    const sa = createScheduler(a.runs, runner('A'), { pollMs: 20, owner: 'A', lockTtlMs: 2000 });
    const sb = createScheduler(b.runs, runner('B'), { pollMs: 20, owner: 'B', lockTtlMs: 2000 });
    sa.start(); sb.start();
    await sleep(3000);
    sa.stop(); sb.stop();
    await sleep(600);
    const mine = [...starts.entries()].filter(([k]) => k.includes(tag));
    const doubles = mine.filter(([, v]) => v.length > 1);
    const byWho = { A: mine.filter(([, v]) => v[0] === 'A').length, B: mine.filter(([, v]) => v[0] === 'B').length };
    console.log(`[k4 S5] occurrences=${mine.length} by A=${byWho.A} B=${byWho.B} doubles=${JSON.stringify(doubles)}`);
    expect(mine.length).toBeGreaterThan(20);
    expect(doubles).toEqual([]);
  }, 30_000);
});
