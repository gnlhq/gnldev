// Child process: ONE process that writes to TWO Postgres databases (a database per tenant), through the
// engine as an application would — a registry on each tenant's store.
//
//   argv: <db1 url> <db2 url> <effectsFile>
//
// Tenant 1's registry runs first (its executor makes the process's liveness from db1, as the first
// store a server opens does). Then tenant 2's registry runs an agent whose idempotent tool writes one
// line to the effects file and stays inside its body (a long effect in progress) until the process is
// killed.
import { appendFileSync } from 'node:fs';
import { z } from 'zod';
import { armFixtureWatchdog } from './watchdog.js';
import { createGnl, gnlTool, STAFF } from '../../src/index.js';
import { PostgresStorage } from '../../src/postgres-storage.js';
import { createMockModel, toolCallResult, finalTextResult } from '../mock.js';

armFixtureWatchdog(60_000);
const [db1, db2, effects] = process.argv.slice(2) as [string, string, string];
const s1 = new PostgresStorage({ connectionString: db1 });
const s2 = new PostgresStorage({ connectionString: db2 });

const plain = createMockModel(async () => finalTextResult('ok'));
await createGnl({ storage: s1, agents: { a: { model: plain } } } as any).run('a', { runId: 'tenant1-run', prompt: 'go', caller: STAFF } as any);

const sync = gnlTool({
  description: 'sync', inputSchema: z.object({}).passthrough(),
  execute: async () => { appendFileSync(effects, `${process.pid}\n`); await new Promise(() => {}); },
} as any, { idempotent: true } as any);
const calls = createMockModel(async ({ prompt }: any) => prompt.some((m: any) => m.role === 'tool') ? finalTextResult('done') : toolCallResult('sync', 'c1', {}));
await createGnl({ storage: s2, agents: { a: { model: calls, tools: { sync } } } } as any).run('a', { runId: 'tenant2-run', prompt: 'go', caller: STAFF } as any);
