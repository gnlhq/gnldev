// AUDIT C fixture: a process with the framework's shutdown (drainOnSignal) and a run started with
// runDurable whose tool body takes 2 s. Writes `enter`/`effect` lines to argv[2].
import { appendFileSync } from 'node:fs';
import { InMemoryStorage, toJournal, runDurable, drainOnSignal } from '../../src/index.js';

const out = process.argv[2]!;
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const model: any = {
  specificationVersion: 'v2', provider: 'probe', modelId: 'm', supportedUrls: {},
  doGenerate: async ({ prompt }: any) => ((prompt ?? []).some((m: any) => m.role === 'tool')
    ? { content: [{ type: 'text', text: 'done' }], finishReason: 'stop', usage, warnings: [] }
    : { content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'charge', input: '{}' }], finishReason: 'tool-calls', usage, warnings: [] }),
  doStream: async () => { throw new Error('no stream'); },
};
drainOnSignal({ deadlineMs: 10_000 });
void runDurable({ runId: 'r', journal: toJournal(new InMemoryStorage().runs), model, prompt: 'go',
  tools: { charge: { execute: async () => { appendFileSync(out, 'enter\n'); await new Promise((r) => setTimeout(r, 2_000)); appendFileSync(out, 'effect\n'); return { ok: true }; } } } as any } as never);
setInterval(() => {}, 1 << 30);
