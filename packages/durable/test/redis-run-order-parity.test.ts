// Redis lists runs through its run order (a sorted set of runs, redis-storage.ts RunOrder) and answers
// exactly what the full read answers on the same Redis data — and what SqliteStorage answers on the
// same writes — for every filter, across page boundaries, in both orders.
import { describe, it, expect, afterAll } from 'vitest';
import Redis from 'ioredis';
import { RedisStorage } from '../src/redis-storage.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { makeFakeRedis } from './fake-redis.js';

const clients: Redis[] = [];
afterAll(async () => { for (const c of clients) await c.quit(); });
// A real server when the real-backend job provides one (GNL_REDIS_URL); the fake always.
const REDIS_URL = process.env.GNL_REDIS_URL;
const real = () => { const c = new Redis(REDIS_URL!); clients.push(c); return c; };

const V = { _v: 1 };
const id = (i: number) => `r${String(i).padStart(3, '0')}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The same write sequence, sent to every journal in lockstep (one ms apart per run). */
async function writeAll(js: any[]) {
  const all = (f: (j: any) => Promise<unknown>) => Promise.all(js.map(f));
  for (let i = 0; i < 130; i++) {
    const r = id(i);
    const kind = i % 10;
    if (kind === 0) { // suspended tool, resolved later
      await all((j) => j.put(`${r}:input`, { ...V, threadId: `t${i % 3}`, agent: 'a', resourceId: 'u1' }));
      await all((j) => j.put(`${r}:model:0`, { text: 'x' }));
      await all((j) => j.put(`${r}:tool:c1`, { status: 'suspended' }));
    } else if (kind === 1) { // failed outcome + entries
      await all((j) => j.put(`${r}:input`, { ...V, agent: 'b', resourceId: 'u2', workKey: 'wk1' }));
      await all((j) => j.put(`${r}:model:0`, { text: 'x' }));
      await all((j) => j.put(`${r}:outcome`, { status: 'failed', error: 'boom failed' }));
    } else if (kind === 2) { // only a cancel
      await all((j) => j.put(`${r}:outcome`, { status: 'canceled' }));
    } else if (kind === 3) { // only :input
      await all((j) => j.put(`${r}:input`, { ...V, agent: 'a' }));
    } else if (kind === 4) { // running
      await all((j) => j.put(`${r}:outcome`, { status: 'running' }));
      await all((j) => j.put(`${r}:model:0`, { text: 'x' }));
    } else if (kind === 5) { // a child of the previous run
      await all((j) => j.put(`${r}:input`, { ...V, agent: 'c', parentRunId: id(i - 1) }));
      await all((j) => j.put(`${r}:tool:c1`, { status: 'succeeded' }));
    } else if (kind === 6) { // deleted afterwards
      await all((j) => j.put(`${r}:input`, { ...V, agent: 'a' }));
      await all((j) => j.put(`${r}:model:0`, { text: 'x' }));
    } else if (kind === 7) { // unversioned input only: not a run
      await all((j) => j.put(`${r}:input`, { agent: 'z' }));
    } else if (kind === 8) { // putIfAbsent claim + several tools
      await all((j) => j.putIfAbsent(`${r}:tool:c1`, { status: 'succeeded' }));
      await all((j) => j.put(`${r}:tool:c2`, { status: 'succeeded' }));
      await all((j) => j.put(`${r}:outcome`, { status: 'completed' }));
    } else { // model only
      await all((j) => j.put(`${r}:model:0`, { text: 'x' }));
      await all((j) => j.put(`${r}:model:1`, { text: 'y' }));
    }
    await sleep(1);
  }
  // later events
  for (let i = 0; i < 130; i += 10) await all((j) => j.put(`${id(i)}:tool:c1`, { status: 'succeeded' }));
  for (let i = 6; i < 130; i += 20) await all((j) => j.deletePrefix(`${id(i)}:`));
  // A new key for an old run, written last: the run keeps its place (its first write).
  await sleep(2);
  for (let i = 9; i < 130; i += 30) await all((j) => j.put(`${id(i)}:model:9`, { text: 'late' }));
}

async function walk(j: any, q: Record<string, unknown>, limit: number) {
  const out: unknown[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const p = await j.listRuns({ ...q, limit, ...(cursor ? { cursor } : {}) });
    out.push(...p.items);
    cursor = p.nextCursor;
    if (++pages > 1000) throw new Error('cursor loop');
  } while (cursor);
  return out;
}

const QUERIES: Record<string, unknown>[] = [
  {}, { status: 'suspended' }, { status: 'failed' }, { status: 'canceled' }, { status: 'running' }, { status: 'completed' },
  { agent: 'a' }, { resourceId: 'u2' }, { workKey: 'wk1' }, { topLevel: true }, { agent: 'a', status: 'completed' },
  // Newest first, as the Studio lists.
  { order: 'desc' }, { order: 'desc', status: 'completed' }, { order: 'desc', agent: 'a' }, { order: 'desc', topLevel: true },
];

const clientsUnderTest: [string, () => any][] = [['fake', () => makeFakeRedis(undefined, true)], ...(REDIS_URL ? [['real Redis', real] as [string, () => any]] : [])];
for (const [name, mk] of clientsUnderTest) {
  describe(`run order parity (${name})`, () => {
    it('in order = full read = Sqlite, every filter, pages of 1, 7, 50, 1000', async () => {
      const client: any = mk();
      const pfx = `par${process.pid}-${Math.random().toString(36).slice(2, 7)}:`;
      const redis = new RedisStorage({ client, keyPrefix: pfx });
      const sqlite = new SqliteStorage();
      await writeAll([redis.runs, sqlite.runs]);
      expect(await client.get(pfx + 'runidxstate')).toBe('on');
      // The same data read the old way: another instance on the same keys, its run order turned off.
      await client.set(pfx + 'runidxstate', 'pending');
      const legacy = new RedisStorage({ client, keyPrefix: pfx });
      const full: Record<string, unknown[]> = {};
      for (const q of QUERIES) full[JSON.stringify(q)] = await walk(legacy.runs, q, 1000);
      await client.set(pfx + 'runidxstate', 'on');
      const fresh = new RedisStorage({ client, keyPrefix: pfx });
      for (const q of QUERIES) {
        const want = await walk(sqlite.runs, q, 1000);
        expect(full[JSON.stringify(q)], `full read vs sqlite ${JSON.stringify(q)}`).toEqual(want);
        for (const limit of [1, 7, 50, 1000]) {
          expect(await walk(fresh.runs, q, limit), `in order ${JSON.stringify(q)} limit ${limit}`).toEqual(want);
        }
      }
      expect((await walk(fresh.runs, {}, 1000)).length).toBeGreaterThan(90);
    }, 120_000);

    it('a store an earlier version wrote: pending lists as before, rebuildKeyIndex switches it on with the same answer', async () => {
      const client: any = mk();
      const pfx = `old${process.pid}-${Math.random().toString(36).slice(2, 7)}:`;
      // 0.10's writes: no zrange on the client, so no run order and no run-order state.
      const old = new RedisStorage({ client: new Proxy(client, { get: (t, p) => (p === 'zrange' ? undefined : typeof t[p] === 'function' ? t[p].bind(t) : t[p]) }), keyPrefix: pfx });
      const sqlite = new SqliteStorage();
      await writeAll([old.runs, sqlite.runs]);
      expect(await client.get(pfx + 'runidxstate')).toBeNull();
      const now = new RedisStorage({ client, keyPrefix: pfx });
      await now.runs.put('late:model:0', { text: 'x' });
      await sqlite.runs.put('late:model:0', { text: 'x' });
      expect(await client.get(pfx + 'runidxstate')).toBe('pending');
      expect(await walk(now.runs, {}, 7)).toEqual(await walk(sqlite.runs, {}, 1000));
      const res = (await now.upgrade({ only: ['key-index'] })).steps.find((x) => x.name === 'key-index')!.detail as any;
      expect(res.listedRuns).toBeGreaterThan(90);
      expect(await client.get(pfx + 'runidxstate')).toBe('on');
      for (const q of QUERIES) expect(await walk(now.runs, q, 7), JSON.stringify(q)).toEqual(await walk(sqlite.runs, q, 1000));
    }, 120_000);

    it('applyBatch names its run; deletePrefix of a run removes it from the order', async () => {
      const client: any = mk();
      const pfx = `bat${process.pid}-${Math.random().toString(36).slice(2, 7)}:`;
      const s = new RedisStorage({ client, keyPrefix: pfx });
      const j: any = s.runs;
      await j.put('a:model:0', { text: 'x' });
      expect(await j.applyBatch({ claim: { key: 'b:tool:c1', value: { status: 'succeeded' } }, puts: [{ key: 'b:outcome', value: { status: 'completed' } }] })).toBe(true);
      expect(await client.zrange(pfx + 'idx:runs', 0, -1)).toEqual(['a', 'b']);
      await j.deletePrefix('a:');
      expect(await client.zrange(pfx + 'idx:runs', 0, -1)).toEqual(['b']);
      expect((await j.listRuns()).items.map((r: any) => r.runId)).toEqual(['b']);
    });

    it('adoptIntoOrg: the moved runs list under their new ids, in order, as the full read lists them', async () => {
      const client: any = mk();
      const pfx = `ado${process.pid}-${Math.random().toString(36).slice(2, 7)}:`;
      const s = new RedisStorage({ client, keyPrefix: pfx });
      for (let i = 0; i < 12; i++) { await s.runs.put(`${id(i)}:input`, { ...V, agent: 'a' }); await s.runs.put(`${id(i)}:model:0`, { text: 'x' }); await sleep(1); }
      await s.adoptIntoOrg!('acme', { allowUnregistered: true, allowInFlight: true });
      const inOrder = await walk(s.runs, {}, 5);
      await client.set(pfx + 'runidxstate', 'pending');
      const full = await walk(new RedisStorage({ client, keyPrefix: pfx }).runs, {}, 1000);
      expect(inOrder).toEqual(full);
      expect((inOrder as any[]).map((r) => r.runId)).toEqual(Array.from({ length: 12 }, (_, i) => `org:acme:${id(i)}`));
    });
  });
}
