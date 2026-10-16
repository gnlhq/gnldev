// One OS process: a route that streams a run with streamDurable directly on a shared Sqlite file, whose
// client goes away after two chunks (the reader cancels). On SIGTERM it drains and writes the drain's
// answer and how long it took. argv: db out
import { appendFileSync } from 'node:fs';
import { streamDurable, drainProcess, installProcessLiveness, sqliteLiveness, toJournal } from '../../../src/index.js';
import { SqliteStorage } from '../../../src/sqlite-storage.js';

const [db, out] = process.argv.slice(2) as [string, string];
const storage = new SqliteStorage(db);
await (storage as any).init?.();
installProcessLiveness(sqliteLiveness(db));
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };
const model: any = {
  specificationVersion: 'v3', provider: 'probe', modelId: 'm', supportedUrls: {},
  doGenerate: async () => { throw new Error('stream only'); },
  doStream: async () => ({
    stream: new ReadableStream({
      async start(c) {
        c.enqueue({ type: 'stream-start', warnings: [] }); c.enqueue({ type: 'text-start', id: 't' });
        for (let i = 0; i < 50; i++) { await new Promise((r) => setTimeout(r, 10)); c.enqueue({ type: 'text-delta', id: 't', delta: `w${i} ` }); }
        c.enqueue({ type: 'text-end', id: 't' }); c.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }); c.close();
      },
    }),
  }),
};
process.on('SIGTERM', async () => {
  const t0 = Date.now();
  const r = await drainProcess({ deadlineMs: 3_000 });
  appendFileSync(out, `drain ${JSON.stringify(r)} ${Date.now() - t0}\n`);
  process.exit(0);
});
const r = await streamDurable({ runId: 'r-abandoned', journal: toJournal(storage.runs), model, prompt: 'go', resourceId: 'u' } as any);
const reader = (r.textStream as ReadableStream<string>).getReader();
await reader.read(); await reader.read();
await reader.cancel(); // the client went away
appendFileSync(out, 'abandoned\n');
setInterval(() => {}, 1 << 30);
