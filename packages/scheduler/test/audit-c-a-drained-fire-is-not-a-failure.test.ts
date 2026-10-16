// AUDIT C (red): a fire whose durable run is released by a SIGTERM drain did not fail. The run says so
// itself ("another process continues it"); the poller reads the throw as the workflow failing, counts an
// attempt, and on the last one marks the trigger `failed` for good — no process continues it.
import { describe, it, expect, afterEach } from 'vitest';
import { InMemoryJournal, runDurable, beginDrain, endDrain } from '@gnldev/durable';
import { scheduleWorkflow, pollScheduler, listTriggers, type WorkflowRunner } from '../src/index.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const model: any = {
  specificationVersion: 'v2', provider: 'probe', modelId: 'm', supportedUrls: {},
  doGenerate: async ({ prompt }: any) => ((prompt ?? []).some((m: any) => m.role === 'tool')
    ? { content: [{ type: 'text', text: 'done' }], finishReason: 'stop', usage, warnings: [] }
    : { content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'send', input: '{}' }], finishReason: 'tool-calls', usage, warnings: [] }),
  doStream: async () => { throw new Error('no stream'); },
};

afterEach(() => endDrain());

describe('a drain reaching a scheduled fire', () => {
  it('leaves the trigger due for another process instead of failing it', async () => {
    const j = new InMemoryJournal();
    const runner: WorkflowRunner = {
      async runWorkflow(_name, _input, o) {
        // SIGTERM arrives while the tool body runs.
        await runDurable({ runId: o!.runId!, journal: j, model, prompt: 'go', tools: { send: { execute: async () => { beginDrain(); return { ok: true }; } } } as any } as never);
        return { runId: o!.runId! };
      },
    } as WorkflowRunner;
    const now = Date.now();
    await scheduleWorkflow(j, { id: 'nightly', name: 'wf', at: now, maxAttempts: 1 }, now);
    await pollScheduler(j, runner, now);
    const t = (await listTriggers(j)).find((x) => x.id === 'nightly')!;
    expect({ status: t.status, attempts: t.attempts }).toEqual({ status: 'pending', attempts: 0 });
  });
});
