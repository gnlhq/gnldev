// d25 A6 (cli/KARAR-4, option A): a workflow run that ends in an error is listed `failed`, never `completed`.
// Reported on 0.17.0 through the scheduler: the trigger went to retry, the run row said `completed`. Measured on
// 0.17.1: the same for a workflow run started directly with `gnl.runWorkflow()` — the rule lives in the workflow
// run itself, not in the scheduler.
//
// What the journal holds today (measured before writing this test): a failed workflow run leaves its `:input` and
// NO `wfrun:<runId>` record and no outcome; a successful one writes `wfrun:<runId>` {status:'completed'}. The run
// list therefore has nothing that says "failed" and shows the row as `completed`.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createGnl, toJournal, InMemoryStorage } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { workflow, step } from '@gnldev/workflow';
import { scheduleWorkflow, pollScheduler } from '../src/index.js';

afterEach(() => vi.restoreAllMocks());
const T0 = Date.UTC(2026, 0, 1);

const stores = [['sqlite', () => new SqliteStorage(':memory:')], ['in-memory', () => new InMemoryStorage()]] as const;

function setup(make: () => any) {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const storage = make();
  const journal = toJournal(storage.runs);
  const bad = workflow<{ asOf: string }>().then(step('read', async (input: any) => ({ v: input.asOf.toString() })));
  const good = workflow<{ asOf?: string }>().then(step('read', async () => ({ v: 1 })));
  const gnl = createGnl({ storage, workflows: { bad: bad as any, good: good as any } } as any);
  const rows = async () => ((await storage.runs.listRuns({} as any)) as any).items as Array<{ runId: string; status: string }>;
  return { storage, journal, gnl, rows };
}

describe.each(stores)('A6: a workflow run that throws is listed failed — %s', (_name, make) => {
  it('reported — a scheduler fire whose workflow throws on its first step', async () => {
    const { journal, gnl, rows } = setup(make);
    await scheduleWorkflow(journal, { id: 't', name: 'bad', at: T0 + 1 } as any, T0);
    await pollScheduler(journal, gnl as any, T0 + 10);
    const row = (await rows()).find((r) => r.runId.startsWith('sched:'));
    expect(row, 'the fire created a run row').toBeDefined();
    expect(row!.status).toBe('failed');
  });

  it('sibling — the same workflow started directly with runWorkflow()', async () => {
    const { gnl, rows } = setup(make);
    await expect(gnl.runWorkflow('bad', {} as any, { runId: 'direct-bad' } as any)).rejects.toThrow();
    const row = (await rows()).find((r) => r.runId === 'direct-bad');
    expect(row, 'the run has a row').toBeDefined();
    expect(row!.status).toBe('failed');
  });

  it('control — a workflow that succeeds is still listed completed (direct and fired)', async () => {
    const { journal, gnl, rows } = setup(make);
    await gnl.runWorkflow('good', {} as any, { runId: 'direct-good' } as any);
    await scheduleWorkflow(journal, { id: 'g', name: 'good', at: T0 + 1 } as any, T0);
    await pollScheduler(journal, gnl as any, T0 + 10);
    const all = await rows();
    expect(all.find((r) => r.runId === 'direct-good')?.status).toBe('completed');
    expect(all.find((r) => r.runId.startsWith('sched:'))?.status).toBe('completed');
  });
});
