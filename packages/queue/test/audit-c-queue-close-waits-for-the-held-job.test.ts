// AUDIT C (red): `Queue.close()` says "Stops the worker running here (the job it holds finishes; nothing
// new is taken)". It returns while the held job's handler is still running. An application that then
// closes its store — the natural shutdown order — releases its process lock with the job still in its
// hands: another worker reads the holder as dead, takes the job and runs the handler a second time.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Storage } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { createDatabaseSync, dropDatabaseSync } from '../../../test/support/pg-admin.js';
import { createQueue, createWorker, listJobs } from '../src/index.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PG_URL = process.env.GNL_PG_URL;
const drops: string[] = [];
afterAll(() => { for (const n of drops) dropDatabaseSync(n); });
let seq = 0;
async function open(kind: 'sqlite' | 'postgres', db: string): Promise<Storage> {
  const s: Storage = kind === 'postgres'
    ? new (await import('@gnldev/durable/postgres')).PostgresStorage({ connectionString: db }) as unknown as Storage
    : new SqliteStorage(db) as unknown as Storage;
  await s.init?.();
  return s;
}

for (const kind of ['sqlite', 'postgres'] as const) describe.skipIf(kind === 'postgres' && !PG_URL)(`Queue.close() and the job it holds (${kind})`, () => {
  it('resolves after the held job finished — and the job runs once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gnl-q-close-'));
    dirs.push(dir);
    let db = join(dir, 'q.db');
    if (kind === 'postgres') { const n = `acq_close_${process.pid}_${seq++}`; db = createDatabaseSync(n); drops.push(n); }
    const effects: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const a = await open(kind, db);
    const qa = createQueue(a, { t: async () => { effects.push('enter A'); await gate; effects.push('effect A'); } }, { owner: 'A', pollMs: 10, backoff: false, ttlMs: 1_000 });
    await qa.enqueue('t', {});
    while (!effects.includes('enter A')) await sleep(5);
    setTimeout(release, 150); // the handler finishes while close() waits for it
    await qa.close();
    const finishedBeforeCloseReturned = effects.includes('effect A');
    await a.close?.().catch(() => undefined); // the application's shutdown: queue first, then the store
    // Another worker on the same file (another process's view of it).
    const b = await open(kind, db);
    const wb = createWorker(b, { t: async () => { effects.push('enter B'); effects.push('effect B'); } }, { owner: 'B', ttlMs: 1_000 });
    await wb.runOnce();
    const statuses = (await listJobs(b.work!)).map((j) => j.status);
    await b.close?.();
    expect({ finishedBeforeCloseReturned, effects: effects.filter((e) => e.startsWith('effect')) })
      .toEqual({ finishedBeforeCloseReturned: true, effects: ['effect A'] });
    expect(statuses).toEqual(['done']);
  });
});
