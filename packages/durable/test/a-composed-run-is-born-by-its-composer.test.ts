// Every run id family in RUN_ID_FAMILIES is composed by someone — the engine from a parent run, or a
// package on it for the owner it works for (a schedule's fire, a queued job, a batch item) — and only
// that composer begins it. Before, `sched:`, `job:` and `batch:` could be begun by anyone: an end user
// who spelled `sched:~o~:alice:weekly:0` through any door took the fire, and alice's trigger retried
// until it failed (owner mismatch), her job never ran, her batch item ran zero times, and her erasure
// — which finds these ids by her name — deleted the stranger's run.
//
// Driven by the table, so a family added later is covered here without anyone remembering to add it.
// A family a caller names for itself (`begin: 'caller'`) is the one exception, and is tested as such.
// Postgres runs when GNL_PG_URL is set.
import { describe, it, expect, afterAll } from 'vitest';
import { InMemoryStorage, createGnl, runDurable, durableTool, RUN_ID_FAMILIES, type Storage } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { workflow, step } from '@gnldev/workflow';
import { user } from '../src/run-identity.js';
import { createMockModel, finalTextResult } from './mock.js';

const ends: Array<() => Promise<unknown>> = [];
afterAll(async () => { for (const e of ends.reverse()) await e(); });

const PG_URL = process.env.GNL_PG_URL;
const STORES: Array<[string, () => Promise<Storage>]> = [
  ['in-memory', async () => new InMemoryStorage()],
  ['sqlite', async () => new SqliteStorage(':memory:')],
];
if (PG_URL) {
  // One store for the whole file: every test names its own run, and a pool per test exhausts the server.
  let shared: PostgresStorage | undefined;
  STORES.push(['postgres (real)', async () => {
    if (!shared) { shared = new PostgresStorage({ connectionString: PG_URL }); const s = shared; ends.push(() => s.close()); }
    return shared;
  }]);
}
const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const composed = Object.entries(RUN_ID_FAMILIES).filter(([, f]) => f.begin !== 'caller').map(([root]) => root);
const callerNamed = Object.entries(RUN_ID_FAMILIES).filter(([, f]) => f.begin === 'caller').map(([root]) => root);

type Path = (storage: Storage, runId: string) => Promise<unknown>;
const PATHS: Array<[string, Path]> = [
  ['an agent run', (storage, runId) => createGnl({ storage, agents: { a: { model: createMockModel(async () => finalTextResult('x')) } } }).run('a', { runId, prompt: 'x', caller: user('mallory') })],
  ['a workflow run', (storage, runId) => createGnl({ storage, workflows: { w: workflow<{ n: number }>().then(step('s', async () => ({ ok: true }))) } } as never).runWorkflow('w', { n: 1 }, { runId, caller: user('mallory') })],
  ['runDurable', (storage, runId) => runDurable({ journal: storage.runs, runId, model: createMockModel(async () => finalTextResult('x')), prompt: 'x', caller: user('mallory') } as never)],
  ['a durable tool', (storage, runId) => durableTool({ description: 't', sideEffect: true, recover: async () => ({ done: false as const }), execute: async () => ({ ok: 1 }) } as never, { journal: storage.runs, runId, identity: user('mallory') } as never, 't').execute!({}, { toolCallId: 'c1' } as never)],
];

describe.each(STORES)('a composed run is born by its composer, %s', (_n, make) => {
  it('the table names who composes every family, and only eval is named by its caller', () => {
    expect(callerNamed).toEqual(['eval']);
    expect(composed.length).toBeGreaterThan(0);
  });

  for (const root of composed) {
    for (const [path, begin] of PATHS) {
      it(`${root}: ${path} without its composer's mark is refused and writes nothing`, async () => {
        const storage = await make();
        const runId = `${root}:~o~:alice-${unique()}:x:0`;
        await expect(begin(storage, runId)).rejects.toThrow(/composed by/);
        expect(await storage.runs.listKeys(`${runId}:`)).toEqual([]);
      });
    }
  }

  it('eval: a caller names its own run, as with any id it chooses', async () => {
    const storage = await make();
    const runId = `eval:ds-${unique()}:c1`;
    await PATHS[0]![1](storage, runId);
    expect((await storage.runs.listKeys(`${runId}:`)).length).toBeGreaterThan(0);
  });
});
