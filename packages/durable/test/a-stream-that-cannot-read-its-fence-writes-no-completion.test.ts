// A streamed turn that cannot read whether its run was deleted does not write its completion.
//
// Before the turn's messages go into the thread, `streamDurable` reads the run's fence (erasure-fence.ts).
// It read it as `.catch(() => false)`: a failed read meant "not deleted", and the answer went into a
// thread the deletion may just have taken. `runDurable` throws there, writing nothing and recording the
// run failed; the stream path now does the same (the settle reads once more afterwards).
//
// Siblings: the same read that succeeds writes the completion as before; `runDurable` with the same
// failing read writes nothing of the completion either.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { InMemoryStorage, BasicMemory, toJournal } from '../src/index.js';
import { runDurable, streamDurable } from '../src/run.js';
import { runFenceKey } from '../src/erasure-fence.js';
import type { Journal } from '../src/journal.js';
import { createMockModel, finalTextResult } from './mock.js';

let warn: ReturnType<typeof vi.spyOn>;
beforeAll(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };

/** A journal whose next read of `key` fails once armed — the read after the model's last step. */
function failingFenceRead(inner: Journal, key: string) {
  let armed = false;
  const journal = new Proxy(inner, {
    get(t, p) {
      const v = (t as any)[p];
      if (p === 'get') {
        return async (k: string) => {
          if (armed && k === key) { armed = false; throw new Error('EIO: the store did not answer'); }
          return (t as any).get(k);
        };
      }
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  return { journal, arm: () => { armed = true; } };
}

const streamModel = (text: string, onFinish: () => void): any => ({
  specificationVersion: 'v4', provider: 'mock', modelId: 'mock-stream', supportedUrls: {},
  doGenerate: async () => { throw new Error('stream-only'); },
  doStream: async () => ({
    stream: new ReadableStream({ start(c) {
      for (const p of [{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: '1' }, { type: 'text-delta', id: '1', delta: text },
        { type: 'text-end', id: '1' }, { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }]) c.enqueue(p);
      onFinish();
      c.close();
    } }),
  }),
});

describe('a turn that cannot read its fence before writing its completion', () => {
  it('streamDurable: no answer in the thread, and the run is recorded failed, not completed', async () => {
    const root = toJournal(new InMemoryStorage().runs);
    const runId = `r-${Math.random().toString(36).slice(2, 8)}`;
    const f = failingFenceRead(root, runFenceKey(runId));
    const memory = new BasicMemory(root);
    const res: any = await streamDurable({ runId, journal: f.journal, model: streamModel('THE-ANSWER', f.arm), memory, prompt: 'question', threadId: 'T1' } as any);
    for await (const _ of res.fullStream) { /* drain */ }
    await new Promise((r) => setTimeout(r, 50));
    const thread = JSON.stringify(await memory.getMessages('T1'));
    expect(thread).not.toContain('THE-ANSWER');
    expect(await root.get<{ status: string }>(`${runId}:outcome`)).toMatchObject({ status: 'failed' });
    expect(warn.mock.calls.some((c) => String(c[0]).includes('could not read whether it was deleted'))).toBe(true);
  });

  it('sibling: the same read answering writes the completion as before', async () => {
    const root = toJournal(new InMemoryStorage().runs);
    const runId = `r-${Math.random().toString(36).slice(2, 8)}`;
    const memory = new BasicMemory(root);
    const res: any = await streamDurable({ runId, journal: root, model: streamModel('THE-ANSWER', () => {}), memory, prompt: 'question', threadId: 'T1' } as any);
    for await (const _ of res.fullStream) { /* drain */ }
    await new Promise((r) => setTimeout(r, 50));
    expect(JSON.stringify(await memory.getMessages('T1'))).toContain('THE-ANSWER');
    expect(await root.get<{ status: string }>(`${runId}:outcome`)).toMatchObject({ status: 'completed' });
  });

  it('sibling: runDurable with the same failing read writes nothing of the completion', async () => {
    const root = toJournal(new InMemoryStorage().runs);
    const runId = `r-${Math.random().toString(36).slice(2, 8)}`;
    const f = failingFenceRead(root, runFenceKey(runId));
    const memory = new BasicMemory(root);
    const model = createMockModel(async () => { f.arm(); return finalTextResult('THE-ANSWER'); });
    await expect(runDurable({ runId, journal: f.journal, model, memory, prompt: 'question', threadId: 'T1' } as any)).rejects.toThrow(/EIO/);
    expect(JSON.stringify(await memory.getMessages('T1'))).not.toContain('THE-ANSWER');
  });
});
