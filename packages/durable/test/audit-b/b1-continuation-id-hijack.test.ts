// B1: a stranger who knows the parent run id and the toolCallId starts `cont:<parent>:<toolCallId>`
// (or `task:…`) as an ordinary run of their own BEFORE the engine makes it. The owner's wake must still
// happen exactly once, and the stranger must not own a run in the derived-id space.
import { describe, it, expect } from 'vitest';
import { readRunOutcome, eraseSubject } from '../../src/index.js';
import { app, turn, until, sleep, textOf } from './helpers.js';

describe('B1 derived run ids cannot be taken first by a stranger', () => {
  it('a stranger starting cont:<parent>:<call> before the task ends cannot block the owner\'s wake', async () => {
    const { gnl, storage, calls, effects } = app({ bodyMs: 400, sweepMs: 100 });
    await turn(gnl, { runId: 'h1', threadId: 'T', prompt: 'research', resourceId: 'alice' });
    // While the task runs, mallory names the continuation id on her own thread.
    let strangerRefused = false;
    try { await turn(gnl, { runId: 'cont:h1:call-1', threadId: 'M', prompt: 'hello', resourceId: 'mallory' }); }
    catch { strangerRefused = true; }
    const ownerRec: any = await storage.runs.get('cont:h1:call-1:input');
    await until(() => effects.length === 1, 3_000);
    const woke = await until(async () => {
      const msgs = await gnl.memory!.getMessages('T');
      return msgs.some((m: any) => m.role === 'user' && textOf(m).startsWith('Background task'));
    }, 3_000);
    await sleep(300);
    expect({
      strangerRefused,
      continuationOwnedByStranger: JSON.stringify(ownerRec ?? null).includes('mallory'),
      ownerWoken: woke,
      contCalls: calls.filter((c) => c === 'cont').length,
      contOutcome: (await readRunOutcome(storage.runs as any, 'cont:h1:call-1'))?.status,
    }).toEqual({ strangerRefused: true, continuationOwnedByStranger: false, ownerWoken: true, contCalls: 1, contOutcome: 'completed' });
  });

  it('a stranger starting task:<parent>:<call> before the call is made cannot make the owner\'s background call fail', async () => {
    const { gnl, storage, effects } = app({ bodyMs: 50, sweepMs: 100 });
    let strangerRefused = false;
    try { await turn(gnl, { runId: 'task:h2:call-1', threadId: 'M', prompt: 'hello', resourceId: 'mallory' }); }
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

  it('after a stranger took cont:<parent>:<call>, the task\'s ending is not retried on every sweep for good', async () => {
    const warns: string[] = [];
    const w = console.warn; console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(' ')); };
    try {
      const { gnl } = app({ bodyMs: 200, sweepMs: 100 });
      await turn(gnl, { runId: 'h3', threadId: 'T', prompt: 'research', resourceId: 'alice' });
      try { await turn(gnl, { runId: 'cont:h3:call-1', threadId: 'M', prompt: 'hello', resourceId: 'mallory' }); } catch { /* refused: fine */ }
      await sleep(3_000);
      const endings = warns.filter((x) => x.includes("the ending of 'task:h3:call-1' was not done")).length;
      expect(endings, 'the task ended again by every sweep').toBeLessThanOrEqual(1);
    } finally {
      console.warn = w;
    }
  });

  it("the owner's erasure does not delete a run another person owns", async () => {
    const { gnl, storage } = app({ bodyMs: 200, sweepMs: 100 });
    await turn(gnl, { runId: 'h4', threadId: 'T', prompt: 'research', resourceId: 'alice' });
    let strangerOwns = true;
    try { await turn(gnl, { runId: 'cont:h4:call-1', threadId: 'M', prompt: 'hello', resourceId: 'mallory' }); } catch { strangerOwns = false; }
    await sleep(500);
    const keys = async () => ((await (storage.runs as any).listKeys('cont:h4:call-1:')) as string[]).length;
    const before = await keys();
    await eraseSubject(storage as any, 'alice');
    // Either the stranger never owned the id, or her run outlives alice's erasure.
    expect(strangerOwns ? { before: before > 0, after: (await keys()) > 0 } : 'refused').toEqual(strangerOwns ? { before: true, after: true } : 'refused');
  });
});
