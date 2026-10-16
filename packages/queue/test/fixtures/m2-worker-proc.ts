// One OS process running an application's queue (createQueue + drainOnSignal) on a shared SQLite file or
// Postgres database (argv: kind db effects go name runnerPid mode maxAttempts [livenessIdPrefix]).
//   mode 'plain': the handler writes `enter <name>`, waits for the `go` file, writes `effect <name>`.
//   mode 'run':   the handler runs its durable run (`ctx.run`); the run's one tool body does the same.
// It stays up until it is signalled (a server would keep it up the same way).
import { appendFileSync, existsSync } from 'node:fs';
import type { Storage } from '@gnldev/durable';
import { drainOnSignal, sqliteLiveness, postgresLiveness } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { createQueue } from '../../src/index.js';

const [kind, db, effects, go, name, runner, mode, maxAttempts, livenessId] = process.argv.slice(2) as [string, string, string, string, string, string, string, string, string | undefined];
setInterval(() => { try { process.kill(Number(runner), 0); } catch { process.exit(1); } }, 500).unref();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const storage: Storage = kind === 'postgres'
  ? new (await import('@gnldev/durable/postgres')).PostgresStorage({ connectionString: db }) as unknown as Storage
  : new SqliteStorage(db) as unknown as Storage;
await storage.init?.();
drainOnSignal({ deadlineMs: 20_000, onDrained: async () => { await storage.close?.(); } });

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
/** Turn 1: call `send`. Turn 2 (it has the tool's result): answer. */
const model: any = {
  specificationVersion: 'v2', provider: 'probe', modelId: 'm', supportedUrls: {},
  doGenerate: async ({ prompt }: any) => ((prompt ?? []).some((m: any) => m.role === 'tool')
    ? { content: [{ type: 'text', text: 'done' }], finishReason: 'stop', usage, warnings: [] }
    : { content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'send', input: '{}' }], finishReason: 'tool-calls', usage, warnings: [] }),
  doStream: async () => { throw new Error('no stream'); },
};
const body = async () => {
  appendFileSync(effects, `enter ${name}\n`);
  while (!existsSync(go)) await sleep(10);
  appendFileSync(effects, `effect ${name}\n`);
  return { sent: true };
};
createQueue(storage, {
  t: async (_p, ctx) => {
    if (mode === 'run') await ctx.run({ model, prompt: 'go', tools: { send: { execute: body } } as never });
    else await body();
  },
}, {
  owner: name, ttlMs: 1_000, pollMs: 20, backoff: false, maxAttempts: Number(maxAttempts),
  // A configured liveness id (a pm2 slot, a hostname): a prefix — the process's id is its own.
  ...(livenessId ? { liveness: kind === 'postgres' ? await postgresLiveness({ connectionString: db, id: livenessId }) : sqliteLiveness(db, livenessId) } : {}),
});
appendFileSync(effects, `ready ${name}\n`);
setInterval(() => {}, 1 << 30);
