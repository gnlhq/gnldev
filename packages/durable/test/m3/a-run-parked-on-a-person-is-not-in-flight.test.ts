// IN FLIGHT has one rule (model.ts `runsInFlight`), asked by a thread's deletion, a person's erasure
// order (`subjectRuns`) and an adoption into an organization (`assertNoRunsInFlight`): a run whose turn
// executes, or whose step or call is claimed right now. A run PARKED ON A PERSON (its outcome says
// `running`, a question is open) writes nothing until answered, so it is not — and a refusal says what to
// do about the runs that are (siblings of release audit D5).
import { describe, it, expect, afterAll } from 'vitest';
import { InMemoryStorage, runKeys, subjectRuns, stampFormat } from '../../src/index.js';
import { SqliteStorage } from '../../src/sqlite-storage.js';
import { PostgresStorage } from '../../src/postgres-storage.js';

const ends: Array<() => Promise<unknown>> = [];
afterAll(async () => { for (const e of ends.reverse()) await e(); });
const PG_URL = process.env.GNL_PG_URL;
const STORES: Array<[string, () => Promise<any>]> = [['in-memory', async () => new InMemoryStorage()], ['sqlite', async () => new SqliteStorage(':memory:')]];
if (PG_URL) {
  STORES.push(['postgres (real)', async () => {
    const s = new PostgresStorage({ connectionString: PG_URL });
    ends.push(() => s.close());
    await s.init?.();
    return s;
  }]);
}

const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Three runs of one person; ids carry `u` so a shared Postgres database holds no one else's. */
async function seed(storage: any, u: string) {
  const j = storage.runs;
  const at = Date.now();
  const run = async (runId: string) => {
    await j.put(runKeys.input(runId), { prompt: 'hi', resourceId: `alice-${u}`, threadId: `t-${runId}` });
    await j.put(runKeys.outcome(runId), { status: 'running', at });
  };
  // Waiting on a person: a question is open, nothing is claimed.
  await run(`parked-${u}`);
  await j.put(runKeys.tool(`parked-${u}`, 'c1'), stampFormat({ status: 'suspended', output: { __suspended: true }, toolName: 'pay' }));
  // Executing: its outcome is the write-ahead `running`, no question.
  await run(`busy-${u}`);
  // A question is open, and another call of the same step is still executing.
  await run(`parked-busy-${u}`);
  await j.put(runKeys.tool(`parked-busy-${u}`, 'c1'), stampFormat({ status: 'suspended', output: { __suspended: true }, toolName: 'pay' }));
  await j.put(runKeys.tool(`parked-busy-${u}`, 'c2'), stampFormat({ status: 'running', startedAt: at, attempts: 1 }));
}

describe.each(STORES)('a run parked on a person (%s)', (name, make) => {
  it('subjectRuns: the erasure order does not wait for a run parked on a person, and waits for the others', async () => {
    const storage = await make();
    const u = unique();
    await seed(storage, u);
    const runs = Object.fromEntries((await subjectRuns(storage, `alice-${u}`)).map((r) => [r.runId.replace(`-${u}`, ''), r.inFlight]));
    expect(runs).toEqual({ parked: false, busy: true, 'parked-busy': true });
  });

  // An adoption moves the whole store: not run against a Postgres database other files share.
  it.skipIf(name.startsWith('postgres'))('adoptIntoOrg passes a deployment whose only open run waits on a person', async () => {
    const storage = await make();
    const j = storage.runs;
    await j.put(runKeys.input('parked'), { prompt: 'hi', resourceId: 'alice', threadId: 't-parked' });
    await j.put(runKeys.outcome('parked'), { status: 'running', at: Date.now() });
    await j.put(runKeys.tool('parked', 'c1'), stampFormat({ status: 'suspended', output: { __suspended: true }, toolName: 'pay' }));
    await expect(storage.adoptIntoOrg('acme', { allowUnregistered: true, dryRun: true })).resolves.toBeDefined();
  });

  it.skipIf(name.startsWith('postgres'))('adoptIntoOrg refuses the runs that may still write, names them, says how to stop them, and counts the parked ones apart', async () => {
    const storage = await make();
    await seed(storage, 'x');
    let message = '';
    try { await storage.adoptIntoOrg('acme', { allowUnregistered: true, dryRun: true }); } catch (e) { message = (e as Error).message; }
    expect({
      count: message.includes('2 run(s) are still executing'),
      named: message.includes('busy-x') && message.includes('parked-busy-x'),
      cancel: message.includes('cancelAgentRun'),
      parked: message.includes('1 run(s) waiting on a person are not counted'),
    }).toEqual({ count: true, named: true, cancel: true, parked: true });
  });
});
