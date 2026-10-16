// AUDIT C (red): a job a live worker is running is work in hand. `gnl pending` / `gnl upgrade`
// (pendingWork) read runs only: while a queue job's handler runs — its side effects outside `ctx.run`,
// or its run between tool bodies — the store reads "nothing blocks a shutdown or an upgrade".
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pendingWork, toJournal } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { enqueue, createWorker } from '../src/index.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe('pendingWork while a worker holds a job', () => {
  it('blocks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gnl-q-pending-'));
    dirs.push(dir);
    const storage = new SqliteStorage(join(dir, 'q.db'));
    await storage.init();
    await enqueue(storage.work!, 't', {});
    let entered = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const worker = createWorker(storage as never, { t: async () => { entered = true; await gate; } }, { ttlMs: 1_000 });
    const running = worker.runOnce();
    while (!entered) await new Promise((r) => setTimeout(r, 5));
    const p = await pendingWork(toJournal(storage.runs));
    release();
    await running;
    await storage.close();
    expect(p.blocking).toBe(true);
  });
});
