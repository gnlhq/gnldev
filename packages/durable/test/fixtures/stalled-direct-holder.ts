// Child process: calls a side-effect tool DIRECTLY (`durableTool`, no executor, no worker, no liveness
// bound by the host) on a shared store, writes one line to the effects file inside the body, and stays
// in it. The test then freezes this process (SIGSTOP) past the claim's TTL.
//
//   argv: <sqlite|postgres> <db path or url> <effectsFile> <claimTtlMs> [direct URL to install a liveness on]
import { appendFileSync } from 'node:fs';
import { armFixtureWatchdog } from './watchdog.js';
import { durableTool } from '../../src/durable-tool.js';
import { SqliteStorage } from '../../src/sqlite-storage.js';
import { PostgresStorage } from '../../src/postgres-storage.js';
import { installProcessLiveness, postgresLiveness } from '../../src/process-liveness.js';
import type { DurableCtx } from '../../src/journal.js';

armFixtureWatchdog(60_000);
// The body never ends; this keeps the process up meanwhile (an unsettled top-level await alone exits 13).
setInterval(() => {}, 1_000);
const [kind, target, effects, ttl, installOn] = process.argv.slice(2) as [string, string, string, string, string | undefined];
if (installOn) installProcessLiveness(await postgresLiveness({ connectionString: installOn }));
const storage = kind === 'sqlite' ? new SqliteStorage(target) : new PostgresStorage({ connectionString: target });
const tool = {
  sideEffect: true, claimTtlMs: Number(ttl),
  recover: async () => ({ done: false as const }),
  execute: async () => { appendFileSync(effects, `${process.pid}\n`); await new Promise(() => {}); },
};
await durableTool(tool as any, { journal: storage.runs, runId: 'stalled-direct' } as unknown as DurableCtx, 'charge').execute!({ amount: 1 }, { toolCallId: 'c1' } as any);
