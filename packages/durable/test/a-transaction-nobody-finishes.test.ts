// A transaction nobody is left to finish does not hold a MongoDB store's writes.
//
// A process killed between a transaction's writes and its commit leaves it open on the server, with no
// connection under it, for `transactionLifetimeLimitSeconds` (60 s by default). Every write on those documents
// conflicts with it. Measured with the store's own claims, four writers and a SIGKILL at a random moment:
// 2 of 12 kills left the next claim on the run failing at the store's 60 s budget (WriteConflict), and with
// a kill placed after the write, 5 of 5 held a write 72 s or more. In k1-takeover T1 this was the process that
// took the run over, standing at its tool call. `claimTtlMs` plays no part: no claim was ever committed.
//
// Here: a dead holder (a child, SIGKILLed with its transaction open) does not hold the write; a LIVE holder
// keeps its transaction through a writer that conflicts with it past the look; and both with the role the
// README asks of a user (`readWrite` + `clusterMonitor`), which may not kill another user's sessions.
// Runs when GNL_MONGO_URL is set.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoStorage } from '../src/mongo-storage.js';

const URL_ = process.env.GNL_MONGO_URL;
const here = dirname(fileURLToPath(import.meta.url));
const { MongoClient } = createRequire(import.meta.url)('mongodb');
const database = `gnl_orphan_${Date.now().toString(36)}`;
const user = `gnl_orphan_${Math.random().toString(36).slice(2, 8)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TX = { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' };

function limitedUrl(): string {
  const u = new URL(URL_!);
  u.username = user;
  u.password = 'gnl';
  return u.toString();
}

/** A process that writes `key`'s document in a transaction, says so, and is killed before it commits. */
async function killedInsideATransaction(url: string, key: string): Promise<void> {
  const code = `
    const { MongoClient } = require('mongodb');
    (async () => {
      const c = new MongoClient(process.argv[1]); await c.connect();
      const s = c.startSession();
      s.startTransaction(${JSON.stringify(TX)});
      await c.db(process.argv[2]).collection('gnl_run_journal').updateOne({ _id: process.argv[3] }, { $set: { held: true } }, { session: s });
      console.log('HOLDING');
      await new Promise(() => {});
    })();`;
  const p = spawn(process.execPath, ['--no-warnings', '-e', code, url, database, key], { stdio: ['ignore', 'pipe', 'inherit'], cwd: here });
  await new Promise<void>((resolve) => p.stdout!.on('data', (d) => { if (String(d).includes('HOLDING')) resolve(); }));
  const gone = new Promise((r) => p.on('exit', r));
  p.kill('SIGKILL');
  await gone;
}

describe.skipIf(!URL_)('a transaction nobody is left to finish — mongo', () => {
  let admin: any;
  const ends: Array<() => unknown> = [];
  beforeAll(async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    admin = new MongoClient(URL_);
    await admin.connect();
    await admin.db('admin').command({ createUser: user, pwd: 'gnl', roles: [{ role: 'readWrite', db: database }, { role: 'clusterMonitor', db: 'admin' }] });
  });
  afterAll(async () => {
    for (const e of ends.reverse()) await e();
    await admin.db('admin').command({ dropUser: user });
    await admin.db(database).dropDatabase();
    await admin.close();
  });
  const store = async (url: string) => {
    const s = new MongoStorage({ connectionString: url, database });
    ends.push(() => s.close());
    await s.init();
    return s;
  };

  describe.each([['the superuser', () => URL_!], ['readWrite + clusterMonitor', limitedUrl]])('as %s', (_who, url) => {
    it('a dead holder does not hold the write, and the write lands', async () => {
      const s = await store(url());
      const key = `dead-${Math.random().toString(36).slice(2, 8)}:tool:c1`;
      await s.runs.put(key, { n: 1 });
      await killedInsideATransaction(url(), key);
      const t0 = Date.now();
      await s.runs.put(key, { n: 2 });
      expect(Date.now() - t0).toBeLessThan(15_000);
      expect(await s.runs.get(key)).toEqual({ n: 2 });
    }, 90_000);

    it('a live holder keeps its transaction through a write that conflicts with it past the look', async () => {
      const s = await store(url());
      const key = `live-${Math.random().toString(36).slice(2, 8)}:tool:c1`;
      await s.runs.put(key, { n: 1 });
      const holder = new MongoClient(url());
      ends.push(() => holder.close());
      await holder.connect();
      const session = holder.startSession();
      session.startTransaction(TX);
      await holder.db(database).collection('gnl_run_journal').updateOne({ _id: key }, { $set: { held: true } }, { session });
      const t0 = Date.now();
      const write = s.runs.put(key, { n: 2 });
      await sleep(2_500);
      await session.commitTransaction();
      await session.endSession();
      await write;
      expect(Date.now() - t0).toBeGreaterThanOrEqual(2_500);
      expect((await holder.db(database).collection('gnl_run_journal').findOne({ _id: key }))?.held).toBe(true);
      expect(await s.runs.get(key)).toEqual({ n: 2 });
    }, 90_000);
  });
});
