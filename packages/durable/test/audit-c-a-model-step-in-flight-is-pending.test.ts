// AUDIT C (red): `gnl pending` / `gnl upgrade` read "running — work a live process is executing now
// (a run's step, a tool body). BLOCKS" (pending-work.ts). A run executing in-process (runDurable — the
// shape a queue job's `ctx.run`, a scheduler fire and a plain server route all use) is listed only while
// one of its TOOL bodies runs. While its MODEL step is in flight in a live process, nothing is listed and
// the store reads "nothing blocks a shutdown or an upgrade".
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toJournal, runDurable, pendingWork } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('pendingWork while a model step is in flight', () => {
  it('lists the run as running (it blocks), not "nothing blocks"', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gnl-pend-step-'));
    const storage = new SqliteStorage(join(dir, 'runs.db'));
    await storage.init();
    const journal = toJournal(storage.runs);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let inStep = false;
    const model: any = {
      specificationVersion: 'v2', provider: 'probe', modelId: 'm', supportedUrls: {},
      doGenerate: async () => { inStep = true; await gate; return { content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', usage, warnings: [] }; },
      doStream: async () => { throw new Error('no stream'); },
    };
    const run = runDurable({ runId: 'r-step', journal, model, prompt: 'go' } as never);
    while (!inStep) await new Promise((r) => setTimeout(r, 5));
    const p = await pendingWork(journal);
    release();
    await run;
    await storage.close();
    expect({ running: p.running.map((r) => r.runId), blocking: p.blocking }).toEqual({ running: ['r-step'], blocking: true });
  });
});
