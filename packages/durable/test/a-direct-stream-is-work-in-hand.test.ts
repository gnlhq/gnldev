// A run streamed with streamDurable, called directly (an application's route, outside the executor), is work
// this process holds until its stream settles — the rule runDurable keeps (process-liveness.ts `holdWhile`,
// audit C3): a drain waits for it, `pendingWork` lists it, and neither does once it has ended.
import { describe, it, expect, afterEach } from 'vitest';
import { InMemoryStorage, toJournal, streamDurable, drainProcess, endDrain, pendingWork } from '../src/index.js';

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };
const parts = (arr: any[]) => new ReadableStream({ start(c) { for (const p of arr) c.enqueue(p); c.close(); } });
const model: any = {
  specificationVersion: 'v3', provider: 'probe', modelId: 'm', supportedUrls: {},
  doGenerate: async () => { throw new Error('stream only'); },
  doStream: async ({ prompt }: any) => ({
    stream: (prompt ?? []).some((m: any) => m.role === 'tool')
      ? parts([{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'done' }, { type: 'text-end', id: 't' }, { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }])
      : parts([{ type: 'stream-start', warnings: [] }, { type: 'tool-call', toolCallId: 'c1', toolName: 'charge', input: '{}' }, { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage }]),
  }),
};
afterEach(() => endDrain());

function gatedRun(runId: string) {
  const journal = toJournal(new InMemoryStorage().runs);
  const s = { inBody: false, bodyDone: false, release: () => {} };
  const gate = new Promise<void>((r) => (s.release = r));
  const consumed = (async () => {
    const result = await streamDurable({ runId, journal, model, prompt: 'go', resourceId: 'u', tools: { charge: { execute: async () => { s.inBody = true; await gate; s.bodyDone = true; return { ok: true }; } } } } as any);
    await result.consumeStream();
    await result.text;
  })();
  return { journal, s, consumed };
}
const until = async (ok: () => boolean) => { while (!ok()) await new Promise((r) => setTimeout(r, 5)); };

describe('a run streamed with streamDurable directly is work in hand', () => {
  it('a drain does not report drained while its tool body runs', async () => {
    const { s, consumed } = gatedRun('r-stream-drain');
    await until(() => s.inBody);
    const result = await drainProcess({ deadlineMs: 300 });
    const bodyDoneWhenDrained = s.bodyDone;
    s.release();
    await consumed.catch(() => undefined);
    expect({ result, bodyDoneWhenDrained }).not.toEqual({ result: { drained: true }, bodyDoneWhenDrained: false });
  });

  it('pendingWork lists it while it streams, and not once it has ended', async () => {
    const { journal, s, consumed } = gatedRun('r-stream-pending');
    await until(() => s.inBody);
    const during = (await pendingWork(journal)).running.map((r: any) => r.runId);
    s.release();
    await consumed;
    const after = (await pendingWork(journal)).running.map((r: any) => r.runId);
    expect({ during: during.includes('r-stream-pending'), after: after.includes('r-stream-pending') }).toEqual({ during: true, after: false });
  });

  it('a stream that is refused before it starts holds nothing', async () => {
    const journal = toJournal(new InMemoryStorage().runs);
    await expect(streamDurable({ runId: 'bad:model', journal, model, prompt: 'go' } as any)).rejects.toThrow();
    expect((await drainProcess({ deadlineMs: 200 }))).toEqual({ drained: true });
  });
});
