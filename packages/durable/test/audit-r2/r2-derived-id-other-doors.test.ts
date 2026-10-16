// AUDIT ROUND 2 (red): B1's gate ("task:/cont: ids are born by the engine only") sits in the agent path
// (registry startFollowed). The workflow door takes a caller's runId too (server POST /workflows/:name/run,
// studio). A stranger who names `task:<parent>:<call>` there takes the id before the owner's background
// call is made — the B1 harm through another door.
import { describe, it, expect } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { InMemoryStorage, BasicMemory, createGnl, gnlTool } from '../../src/index.js';
import { model, turn, until, sleep } from '../audit-b/helpers.js';

function appWithWorkflow() {
  const storage = new InMemoryStorage();
  const effects: string[] = [];
  const calls: string[] = [];
  const research = gnlTool(tool({
    description: 'deep research', inputSchema: z.object({ topic: z.string() }),
    execute: async ({ topic }: { topic: string }) => { await sleep(50); effects.push(topic); return `report on ${topic}`; },
  }), { sideEffect: true, background: true } as any);
  const wf = { build: () => [{ id: 's1' }], run: async () => ({ ok: true }) };
  const gnl: any = createGnl({ storage, memoryFactory: (src: any) => new BasicMemory(src.runs ?? src), agents: { a: { model: model(calls), tools: { research } } }, workflows: { w: wf }, detached: { sweepMs: 100 } } as any);
  return { storage, gnl, effects };
}

describe('derived run ids cannot be taken first through the workflow door (sibling of B1)', () => {
  it("a stranger's workflow run named task:<parent>:<call> is refused and the owner's background call still runs", async () => {
    const { gnl, storage, effects } = appWithWorkflow();
    let strangerRefused = false;
    try { await gnl.runWorkflow('w', {}, { runId: 'task:h2:call-1', resourceId: 'mallory' }); }
    catch { strangerRefused = true; }
    const r = await turn(gnl, { runId: 'h2', threadId: 'T', prompt: 'research', resourceId: 'alice' });
    const results = (await r.steps).flatMap((s: any) => [...s.toolResults.map((x: any) => x.output), ...(s.content ?? []).filter((p: any) => p.type === 'tool-error').map((p: any) => ({ error: String(p.error?.message ?? p.error) }))]);
    await until(() => effects.length === 1, 3_000);
    expect({
      strangerRefused,
      launcherResult: results,
      effects: effects.length,
      taskOwnedByStranger: JSON.stringify((await storage.runs.get('task:h2:call-1:input')) ?? null).includes('mallory'),
    }).toEqual({ strangerRefused: true, launcherResult: [{ status: 'started', taskId: 'task:h2:call-1' }], effects: 1, taskOwnedByStranger: false });
  });
});
