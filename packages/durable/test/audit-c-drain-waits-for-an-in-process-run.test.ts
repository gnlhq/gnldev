// AUDIT C (red): drainProcess() — "waits for the work in hand — runs (released at their next boundary),
// queue jobs, scheduler fires. `{ drained: true }` when nothing is left". A run started with runDurable
// (the package's own entry point, called from an application's route or script) is not counted: the drain
// resolves `drained: true` at once while its tool body is still running, and drainOnSignal then exits the
// process — the body is cut off mid-way, the crash path, after the drain said nothing was left.
import { describe, it, expect, afterEach } from 'vitest';
import { InMemoryStorage, toJournal, runDurable, drainProcess, endDrain } from '../src/index.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const model: any = {
  specificationVersion: 'v2', provider: 'probe', modelId: 'm', supportedUrls: {},
  doGenerate: async ({ prompt }: any) => ((prompt ?? []).some((m: any) => m.role === 'tool')
    ? { content: [{ type: 'text', text: 'done' }], finishReason: 'stop', usage, warnings: [] }
    : { content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'charge', input: '{}' }], finishReason: 'tool-calls', usage, warnings: [] }),
  doStream: async () => { throw new Error('no stream'); },
};
afterEach(() => endDrain());

describe('drainProcess and a run started with runDurable', () => {
  it('does not report drained while the run\'s tool body is still running', async () => {
    const journal = toJournal(new InMemoryStorage().runs);
    let inBody = false;
    let bodyDone = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const run = runDurable({ runId: 'r-drain', journal, model, prompt: 'go', tools: { charge: { execute: async () => { inBody = true; await gate; bodyDone = true; return { ok: true }; } } } as any } as never);
    while (!inBody) await new Promise((r) => setTimeout(r, 5));
    const result = await drainProcess({ deadlineMs: 300 });
    const bodyDoneWhenDrained = bodyDone;
    release();
    await run.catch(() => undefined);
    expect({ result, bodyDoneWhenDrained }).not.toEqual({ result: { drained: true }, bodyDoneWhenDrained: false });
  });
});
