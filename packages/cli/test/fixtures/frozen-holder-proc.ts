// One OS process holding a run's tool body on a shared Sqlite file, with the file's liveness installed:
// it writes `holder <the liveness id that answers for the store>` (the store's own, bound by runDurable on
// its first call — the installed one stands in only for a store with none) and `entered` when the body starts, `effect` when the body's effect
// happens (3 s later — the parent freezes it meanwhile), and `done` when the run ends. argv: db out
import { appendFileSync } from 'node:fs';
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { runDurable, installProcessLiveness, sqliteLiveness, livenessFor, toJournal } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';

const [db, out] = process.argv.slice(2) as [string, string];
const storage = new SqliteStorage(db);
await storage.init();
const live = sqliteLiveness(db);
installProcessLiveness(live);
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const model: any = {
  specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
  doGenerate: async ({ prompt }: any) => (prompt.some((m: any) => m.role === 'tool')
    ? { content: [{ type: 'text', text: 'done' }], finishReason: 'stop', usage, warnings: [] }
    : { content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'charge', input: JSON.stringify({ id: 'A' }) }], finishReason: 'tool-calls', usage, warnings: [] }),
};
const charge = tool({
  description: 'charge', inputSchema: z.object({ id: z.string() }),
  execute: async () => {
    appendFileSync(out, `holder ${livenessFor(storage.runs)?.id}\nentered\n`);
    await new Promise((r) => setTimeout(r, 3_000));
    appendFileSync(out, 'effect\n');
    return { ok: true };
  },
});
await runDurable({ runId: 'r-frozen', journal: toJournal(storage.runs), model, tools: { charge }, prompt: 'go', stopWhen: stepCountIs(3) } as never);
appendFileSync(out, 'done\n');
setInterval(() => {}, 1 << 30);
