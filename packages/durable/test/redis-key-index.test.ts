// The Redis store lists a prefix through its key index, not by SCAN, which walks the whole database:
// a 10-call run took 44 ms with the database to itself and 2983 ms beside 1 000 000 other keys; a
// queue's 10 jobs 78 → 6318 ms. A store an earlier version wrote keeps SCAN until every process is
// upgraded and `rebuildKeyIndex()` is called — an earlier version writes keys the index does not hold.
import { describe, it, expect, vi, afterAll } from 'vitest';
import { z } from 'zod';
import superjson from 'superjson';
import { RedisStorage, createGnl, gnlTool, STAFF } from '../src/index.js';
import { makeFakeRedis } from './fake-redis.js';
import { enqueue, createWorker } from '../../queue/src/index.js';
import { createMockModel, toolCallResult, finalTextResult } from './mock.js';

/** A fake Redis that counts SCAN walks, optionally without the commands the index needs. */
function counted(opts: { noLex?: boolean } = {}) {
  const inner = makeFakeRedis(undefined, true) as any;
  const stats = { walks: 0 };
  const client = new Proxy(inner, {
    get(t, p) {
      if (opts.noLex && (p === 'zrangebylex' || p === 'zremrangebylex')) return undefined;
      if (p === 'scan') return async (...a: any[]) => { if (String(a[0]) === '0') stats.walks++; return t.scan(...a); };
      const v = t[p];
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  return { client, stats };
}
/** What 0.9 wrote: the same key and value format, with no index member. */
async function oldRunKey(client: any, prefix: string, runId: string) {
  await client.set(`${prefix}rj:${runId}:model:0`, superjson.stringify({ v: { text: 'old' }, r: runId, k: 'model', s: false, t: 1 }));
}
async function tenCalls(storage: RedisStorage, runId: string) {
  const t = gnlTool({ description: 't', inputSchema: z.object({}).passthrough(), execute: async () => ({ ok: true }) }, { sideEffect: true, idempotencyWindow: 'run', idempotencyKey: (a: any) => String(a.k) } as any);
  const m = createMockModel(async ({ prompt }: any) => { const n = prompt.filter((x: any) => x.role === 'tool').length; return n < 10 ? toolCallResult('t', `c${n}`, { k: n }) : finalTextResult('ok'); });
  await createGnl({ storage, agents: { a: { model: m, tools: { t }, maxSteps: 14 } } } as any).run('a', { runId, prompt: 'go', caller: STAFF } as any);
}

describe('a new store lists through its key index', () => {
  it('a run walks the database 0 times, beside 20 000 other keys', async () => {
    const { client, stats } = counted();
    for (let i = 0; i < 20_000; i++) await client.set(`otherapp:item:${i}`, 'x');
    const storage = new RedisStorage({ client, keyPrefix: 'gnl:' });
    await tenCalls(storage, 'r0'); // the first contact decides the store is new (one walk)
    stats.walks = 0;
    await tenCalls(storage, 'r1');
    expect(stats.walks).toBe(0);
    expect((await storage.runs!.readRun!('r1')).length).toBeGreaterThan(10);
  });
  it('a queue enqueues and drains with 0 walks', async () => {
    const { client, stats } = counted();
    const storage = new RedisStorage({ client, keyPrefix: 'gnl:' });
    await enqueue(storage.work!, 'mail', { i: 0 });
    stats.walks = 0;
    const ran: number[] = [];
    for (let i = 1; i <= 10; i++) await enqueue(storage.work!, 'mail', { i });
    await createWorker(storage as any, { mail: async (p: { i: number }) => { ran.push(p.i); } }).drain();
    expect(stats.walks).toBe(0);
    expect(ran.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
  it('any prefix, not only a run: listKeys and deletePrefix', async () => {
    const { client, stats } = counted();
    const storage = new RedisStorage({ client, keyPrefix: 'gnl:' });
    const j = storage.runs!;
    for (const k of ['sched:def:a', 'sched:def:b', 'sched:other', 'wfrun:1']) await j.put(k, 1);
    stats.walks = 0;
    expect((await j.listKeys!('sched:def:')).sort()).toEqual(['sched:def:a', 'sched:def:b']);
    expect(await j.deletePrefix!('sched:')).toBe(3);
    expect(await j.listKeys!('sched:')).toEqual([]);
    expect(await j.listKeys!('')).toEqual(['wfrun:1']);
    expect(stats.walks).toBe(0);
  });
  it('deletePrefix erases the counters under the prefix too, without walking the database', async () => {
    const { client, stats } = counted();
    const j = new RedisStorage({ client, keyPrefix: 'gnl:' }).runs!;
    await j.put('r1:input', 1);
    await j.incrBy!('r1:proc:spend', { tokens: 5 });
    await j.incrBy!('r2:proc:spend', { tokens: 7, calls: 1 });
    stats.walks = 0;
    await j.deletePrefix!('r1:');
    expect(await j.getCounters!('r1:proc:spend')).toBeUndefined();
    expect(await j.getCounters!('r2:proc:spend')).toEqual({ tokens: 7, calls: 1 });
    expect(stats.walks).toBe(0);
  });
  it('a prefix spans every key that starts with it, compared as UTF-8 bytes', async () => {
    const { client } = counted();
    const j = new RedisStorage({ client, keyPrefix: 'gnl:' }).runs!;
    const keys = ['a', 'a:é', 'a:😀', 'a:\uFFFD', 'a;', 'b'];
    for (const k of keys) await j.put(k, 1);
    expect((await j.listKeys!('a:')).sort()).toEqual(['a:é', 'a:😀', 'a:\uFFFD'].sort());
  });
});

describe('a store an earlier version wrote', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  afterAll(() => warn.mockRestore());
  it('lists by SCAN, sees what a 0.9 process writes afterwards, and says how to switch', async () => {
    const { client, stats } = counted();
    await oldRunKey(client, 'gnl:', 'old-run');
    const storage = new RedisStorage({ client, keyPrefix: 'gnl:' });
    await tenCalls(storage, 'r1');
    await oldRunKey(client, 'gnl:', 'later-run'); // a 0.9 process still running
    stats.walks = 0;
    expect((await storage.runs!.readRun!('later-run')).map((e) => e.key)).toEqual(['later-run:model:0']);
    expect(stats.walks).toBeGreaterThan(0);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('rebuildKeyIndex')).length).toBe(1);
  });
  it('after rebuildKeyIndex: the earlier keys are listed, every process sharing it switches, 0 walks', async () => {
    const { client, stats } = counted();
    await oldRunKey(client, 'gnl:', 'old-run');
    const a = new RedisStorage({ client, keyPrefix: 'gnl:' });
    const b = new RedisStorage({ client, keyPrefix: 'gnl:' }); // another process
    await tenCalls(a, 'r1');
    expect(await b.runs!.readRun!('old-run')).toHaveLength(1); // b decides: pending
    expect((await a.rebuildKeyIndex()).runs).toBeGreaterThan(10);
    stats.walks = 0;
    expect((await b.runs!.readRun!('old-run')).map((e) => e.key)).toEqual(['old-run:model:0']);
    expect((await a.runs!.readRun!('r1')).length).toBeGreaterThan(10);
    expect(stats.walks).toBe(0);
  });
});

it('a client without ZRANGEBYLEX lists by SCAN, as before', async () => {
  const { client, stats } = counted({ noLex: true });
  const storage = new RedisStorage({ client, keyPrefix: 'gnl:' });
  await tenCalls(storage, 'r1');
  stats.walks = 0;
  expect((await storage.runs!.readRun!('r1')).length).toBeGreaterThan(10);
  expect(stats.walks).toBeGreaterThan(0);
});

describe.skipIf(!process.env.GNL_REDIS_URL)('the key index on a real Redis', () => {
  it('a prefix spans every key that starts with it (UTF-8), and nothing else', async () => {
    const { default: Redis } = await import('ioredis');
    const client = new Redis(process.env.GNL_REDIS_URL!);
    try {
      const j = new RedisStorage({ client: client as never, keyPrefix: `kidx-${Date.now().toString(36)}:` }).runs!;
      for (const k of ['a', 'a:é', 'a:😀', 'a:\uFFFD', 'a;', 'b']) await j.put(k, 1);
      expect((await j.listKeys!('a:')).sort()).toEqual(['a:é', 'a:😀', 'a:\uFFFD'].sort());
      expect(await j.deletePrefix!('a:')).toBe(3);
      expect((await j.listKeys!('')).sort()).toEqual(['a', 'a;', 'b']);
    } finally { await client.quit(); }
  });
});
