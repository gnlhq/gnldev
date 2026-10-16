// A BACKGROUND TOOL in one process: what the model is answered, whose the task and its continuation
// are, where they live. (The crash, race and erasure promises are proven across real processes in
// a-background-tool-across-processes.test.ts.)
import { describe, it, expect } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { InMemoryStorage, BasicMemory, createGnl, gnlTool, scopeConfigToOrg, readRunOutcome, purgeRun } from '../src/index.js';
import { user } from '../src/run-identity.js';
import { fenceRun } from '../src/erasure-fence.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };
const textOf = (m: any): string => (typeof m?.content === 'string' ? m.content : Array.isArray(m?.content) ? m.content.map((p: any) => p.text ?? '').join('') : '');

/** Calls `research` on a "research …" turn, answers otherwise; counts the continuation's calls. */
function model(calls: string[]): any {
  return {
    specificationVersion: 'v4', provider: 'scripted', modelId: 'bg', supportedUrls: {},
    doGenerate: async () => { throw new Error('stream only'); },
    doStream: async ({ prompt }: any) => {
      let i = prompt.length - 1;
      while (i >= 0 && prompt[i].role !== 'user') i--;
      const text = textOf(prompt[i]);
      const toolAfter = prompt.slice(i + 1).some((m: any) => m.role === 'tool');
      calls.push(text.startsWith('Background task') ? 'cont' : 'turn');
      const callTool = text.startsWith('research') && !toolAfter;
      return {
        stream: new ReadableStream({
          start(c) {
            c.enqueue({ type: 'stream-start', warnings: [] });
            if (callTool) c.enqueue({ type: 'tool-call', toolCallId: 'call-1', toolName: 'research', input: JSON.stringify({ topic: 'tides' }) });
            else { c.enqueue({ type: 'text-start', id: 't' }); c.enqueue({ type: 'text-delta', id: 't', delta: `answer to ${text.slice(0, 30)}` }); c.enqueue({ type: 'text-end', id: 't' }); }
            c.enqueue({ type: 'finish', finishReason: callTool ? { unified: 'tool-calls', raw: 'tool-calls' } : { unified: 'stop', raw: 'stop' }, usage });
            c.close();
          },
        }),
      };
    },
  };
}

function app(opts: { background?: boolean; org?: string; bodyMs?: number } = {}) {
  const storage = new InMemoryStorage();
  const effects: string[] = [];
  const calls: string[] = [];
  const research = gnlTool(tool({
    description: 'deep research', inputSchema: z.object({ topic: z.string() }),
    execute: async ({ topic }: { topic: string }) => { await sleep(opts.bodyMs ?? 50); effects.push(topic); return `report on ${topic}`; },
  }), { sideEffect: true, ...(opts.background === false ? {} : { background: true }) } as any);
  const config: any = { storage, memoryFactory: (src: any) => new BasicMemory(src.runs ?? src), agents: { a: { model: model(calls), tools: { research } } }, detached: { sweepMs: 0 } };
  const gnl = createGnl(opts.org ? scopeConfigToOrg(config, opts.org).config : config);
  return { storage, gnl, effects, calls };
}

async function turn(gnl: any, opts: Record<string, unknown>) {
  const r = await gnl.stream('a', opts);
  await r.consumeStream();
  return r;
}
async function until(cond: () => Promise<boolean> | boolean, ms = 5_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return; await sleep(20); }
  throw new Error('timed out');
}

describe('a background tool', () => {
  it('the default is still to wait: without `background` the model gets the body\'s output', async () => {
    const { gnl, effects } = app({ background: false });
    const r = await turn(gnl, { runId: 'w1', threadId: 'T', prompt: 'research', resourceId: 'alice' });
    expect((await r.steps).flatMap((s: any) => s.toolResults.map((x: any) => x.output))).toEqual(['report on tides']);
    expect(effects).toEqual(['tides']);
  });

  it('the model is answered with a stable `started` and the turn ends before the body does', async () => {
    const { gnl, effects, storage, calls } = app({ bodyMs: 300 });
    const r = await turn(gnl, { runId: 'b1', threadId: 'T', prompt: 'research', resourceId: 'alice' });
    expect((await r.steps).flatMap((s: any) => s.toolResults.map((x: any) => x.output))).toEqual([{ status: 'started', taskId: 'task:b1:call-1' }]);
    expect(effects, 'the turn waited for the body').toEqual([]);
    await until(async () => (await readRunOutcome(storage.runs as any, 'cont:b1:call-1'))?.status === 'completed');
    expect(effects).toEqual(['tides']);
    expect(calls.filter((c) => c === 'cont')).toEqual(['cont']);
    const msgs = await gnl.memory!.getMessages('T');
    expect(msgs.filter((m: any) => m.role === 'user' && textOf(m).startsWith('Background task')).length).toBe(1);
    expect(textOf(msgs[msgs.length - 1])).toContain('answer to Background task');
  });

  it('a stranger cannot follow, approve or receive the task or its continuation', async () => {
    const { gnl, storage } = app({ bodyMs: 200 });
    await turn(gnl, { runId: 'b2', threadId: 'T', prompt: 'research', resourceId: 'alice' });
    await until(async () => (await readRunOutcome(storage.runs as any, 'cont:b2:call-1'))?.status === 'completed');
    for (const runId of ['task:b2:call-1', 'cont:b2:call-1']) {
      await expect(gnl.stream('a', { runId, threadId: 'M', prompt: 'give', resourceId: 'mallory' } as any), `${runId}: follow`).rejects.toThrow();
      await expect(gnl.stream('a', { runId, prompt: 'give', resourceId: 'mallory', approvals: { 'call-1': true } } as any), `${runId}: approve`).rejects.toThrow();
    }
    expect(await gnl.memory!.getMessages('M'), "the stranger's thread").toEqual([]);
    const input: any = await storage.runs.get('task:b2:call-1:input');
    expect(input?.owner ?? input?.resourceId ?? input?.caller, 'the task is the parent owner\'s').toBeDefined();
    expect(JSON.stringify(input)).toContain('alice');
    expect(JSON.stringify(await storage.runs.get('cont:b2:call-1:input'))).toContain('alice');
  });

  it("an organization's parent: its task and continuation live in that organization", async () => {
    const { gnl, storage } = app({ org: 'acme', bodyMs: 50 });
    await turn(gnl, { runId: 'b3', threadId: 'T', prompt: 'research', caller: user('alice', 'acme') });
    const keys = async (p: string) => (await (storage.runs as any).listKeys(p)) as string[];
    await until(async () => (await keys('org:acme:cont:b3:call-1:')).length > 0 && (await readRunOutcome(storage.runs as any, 'org:acme:cont:b3:call-1'))?.status === 'completed');
    expect((await keys('org:acme:task:b3:call-1:')).length).toBeGreaterThan(0);
    expect(await keys('task:'), 'a task outside its organization').toEqual([]);
    expect(await keys('cont:'), 'a continuation outside its organization').toEqual([]);
  });

  it('the derived runs are in the erasure model: purging the parent purges its task and continuation', async () => {
    const { gnl, storage } = app({ bodyMs: 20 });
    await turn(gnl, { runId: 'b4', threadId: 'T', prompt: 'research', resourceId: 'alice' });
    await until(async () => (await readRunOutcome(storage.runs as any, 'cont:b4:call-1'))?.status === 'completed');
    await sleep(100);
    await purgeRun(storage.runs as any, 'b4');
    const left = ((await (storage.runs as any).listKeys('')) as string[]).filter((k) => k.includes('b4') && !k.startsWith('__run_erased__'));
    expect(left, JSON.stringify(left)).toEqual([]);
  });

  it("a parent whose erasure has begun (its fence written, its records not yet gone) gets no continuation", async () => {
    // The erasure plans a run's children from its tool records, then fences and deletes it. A task that
    // ends in between finds no fence of its own — its PARENT's fence is what stops it (lineage).
    const { gnl, storage, calls } = app({ bodyMs: 300 });
    await turn(gnl, { runId: 'b6', threadId: 'T', prompt: 'research', resourceId: 'alice' });
    await fenceRun(storage.runs as any, 'b6');
    await sleep(1_000);
    expect(calls.filter((c) => c === 'cont'), 'the agent woken for an erased run').toEqual([]);
    expect(((await (storage.runs as any).listKeys('cont:b6:')) as string[]), 'a continuation born under an erased parent').toEqual([]);
    expect(((await (storage.runs as any).listKeys('task:b6:')) as string[]), "the task's records after it was stopped").toEqual([]);
    const msgs = await gnl.memory!.getMessages('T');
    expect(msgs.filter((m: any) => textOf(m).startsWith('Background task')), 'the result written to the thread').toEqual([]);
  });

  it('two deliveries of the same task end in one process wake the agent once', async () => {
    const { gnl, storage, calls } = app({ bodyMs: 20 });
    await turn(gnl, { runId: 'b5', threadId: 'T', prompt: 'research', resourceId: 'alice' });
    await until(async () => (await readRunOutcome(storage.runs as any, 'cont:b5:call-1'))?.status === 'completed');
    // The same turn asked again (a retry of the request): it replays, starts nothing, wakes nothing.
    await turn(gnl, { runId: 'b5', threadId: 'T', prompt: 'research', resourceId: 'alice' });
    await sleep(300);
    expect(calls.filter((c) => c === 'cont')).toEqual(['cont']);
  });
});
