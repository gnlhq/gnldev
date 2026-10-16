// A job whose run id was erased is answered as erased — at the door, and by a worker that meets it later.
//
// Measured before (raporlar/2026-10-16-e2e, F1): after `eraseSubject('ayse')`, `enqueue(…, { id:
// 'weekly:w42', caller: user('ayse') })` returned ok; the job's run `job:<id>` was fenced by the erasure,
// so every attempt was refused at the run's birth, and the worker retried it until `failed`, each time
// reporting "run … was deleted while it was running" — about a run that never ran again. The same held
// for a job whose run was deleted while the job waited for its next attempt, and for `retryJob` on a
// dead letter whose run was deleted.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { InMemoryStorage, eraseSubject, purgeResource, toJournal, user, type Storage } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { PostgresStorage } from '@gnldev/durable/postgres';
import { enqueue, createWorker, listJobs, retryJob, jobEraser } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fromDurable = createRequire(join(here, '..', '..', 'durable', 'package.json'));
const PG_URL = process.env.GNL_PG_URL;
const ends: Array<() => unknown> = [];
afterAll(async () => { for (const end of ends.reverse()) await end(); });

const BACKENDS: Array<[string, () => Promise<Storage>]> = [
  ['in-memory', async () => new InMemoryStorage()],
  ['Sqlite', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gnl-erased-job-'));
    const storage = new SqliteStorage(join(dir, 'q.db')) as unknown as Storage;
    ends.push(() => { (storage as any).close?.(); rmSync(dir, { recursive: true, force: true }); });
    return storage;
  }],
  ['Postgres (pg-mem)', async () => {
    const { newDb } = fromDurable('pg-mem');
    const { Pool } = newDb().adapters.createPg();
    const { inMemoryLiveness } = await import('@gnldev/durable');
    return Object.assign(new PostgresStorage({ pool: new Pool() }), { processLiveness: async () => inMemoryLiveness() }) as unknown as Storage;
  }],
];
if (PG_URL) BACKENDS.push(['Postgres (real)', async () => {
  const pg = fromDurable('pg');
  const admin = new pg.Client({ connectionString: PG_URL });
  await admin.connect();
  const name = `fixen_t_${process.pid}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const u = new URL(PG_URL); u.pathname = `/${name}`;
  const storage = new PostgresStorage({ connectionString: u.toString() }) as unknown as Storage;
  ends.push(async () => { await (storage as any).close?.().catch(() => {}); await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await admin.end(); });
  return storage;
}]);

const ayse = user('ayse');
const eraseAyse = (s: Storage) => eraseSubject(s, 'ayse', { erasers: [jobEraser(s)] });

function rig(storage: Storage, handler: (p: any, ctx: any) => Promise<unknown> = async () => undefined, retryDelayMs = 0) {
  let ran = 0;
  const errors: string[] = [];
  const worker = createWorker(storage, { t: async (p: any, ctx: any) => { ran++; return handler(p, ctx); } }, {
    maxAttempts: 3, retryDelayMs, onError: (e: any) => errors.push(String(e?.message ?? e)),
  } as any);
  return { worker, errors, ran: () => ran };
}

const jobOf = async (s: Storage, name: string) => (await listJobs(s.work!)).find((j) => j.id.endsWith(`:${name}`));

describe.each(BACKENDS)('a job under an erased run id — %s', (_name, make) => {
  it('enqueue under the id of a run the erasure deleted is refused as erased, and writes no job', async () => {
    const s = await make();
    const r = rig(s);
    await enqueue(s.work!, 't', {}, { id: 'weekly:w42', caller: ayse });
    await r.worker.drain();
    expect(r.ran()).toBe(1);
    await eraseAyse(s);
    await expect(enqueue(s.work!, 't', {}, { id: 'weekly:w42', caller: ayse })).rejects.toMatchObject({ name: 'RunErasedError' });
    expect(await jobOf(s, 'weekly:w42')).toBeUndefined();
    await r.worker.drain();
    expect(r.ran()).toBe(1);
    expect(r.errors).toEqual([]);
  });

  it('control: after the erasure a new id for the same person runs', async () => {
    const s = await make();
    const r = rig(s);
    await enqueue(s.work!, 't', {}, { id: 'weekly:w42', caller: ayse });
    await r.worker.drain();
    await eraseAyse(s);
    await enqueue(s.work!, 't', {}, { id: 'weekly:w43', caller: ayse });
    await r.worker.drain();
    expect(r.ran()).toBe(2);
    expect((await jobOf(s, 'weekly:w43'))?.status).toBe('done');
  });

  it('a job whose run is deleted before its next attempt ends failed as erased, with no further attempt', async () => {
    const s = await make();
    let calls = 0;
    // The first attempt fails, and the person's runs are deleted before the retry (here: by that attempt,
    // so every store sees the same order without a clock).
    const r = rig(s, async () => { calls++; if (calls === 1) { await purgeResource(toJournal(s.runs), 'ayse'); throw new Error('transient'); } });
    await enqueue(s.work!, 't', {}, { id: 'report:7', caller: ayse });
    await r.worker.drain();
    const job = await jobOf(s, 'report:7');
    expect(calls).toBe(1);
    expect(job?.status).toBe('failed');
    expect(job?.attempts).toBe(2);
    // One report per attempt: the failure, then the deletion — which does not claim the run was running.
    expect(r.errors).toHaveLength(2);
    expect(r.errors[1]).toMatch(/deleted/);
    expect(r.errors[1]).not.toMatch(/while it was running/);
  });

  it('retryJob on a dead letter whose run was deleted is refused as erased; { newRun: true } still retries', async () => {
    const s = await make();
    const r = rig(s, async () => { throw new Error('always'); });
    const id = await enqueue(s.work!, 't', {}, { id: 'export:1', caller: ayse });
    await r.worker.drain();
    expect((await jobOf(s, 'export:1'))?.status).toBe('failed');
    await purgeResource(toJournal(s.runs), 'ayse');
    await expect(retryJob(s.work!, id)).rejects.toMatchObject({ name: 'RunErasedError' });
    expect(typeof (await retryJob(s.work!, id, { newRun: true }))).toBe('string');
  });
});
