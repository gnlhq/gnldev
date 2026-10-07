// `storage.upgrade()`: one way to bring a store an earlier version wrote up to this one — every pending
// step, or the ones named in `only`, never one behind the caller's back.
import { describe, it, expect } from 'vitest';
import * as D from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { RedisStorage } from '../src/redis-storage.js';
import { makeFakeRedis } from './fake-redis.js';
import superjson from 'superjson';
import { threadOwnerKey, threadSeenKey, THREAD_RECORDS_KEY } from '../src/thread-owner.js';

const { InMemoryStorage, toJournal, threadOwnerOf, withOrg } = D as any;
const V = { _v: 1 };

/**
 * Threads as 0.10 and earlier left them — runs, no owner record, no mark: one user's, two users', an
 * anonymous one of 0.7–0.10 (versioned `unknown` inputs), an anonymous one of 0.6 (unversioned), and
 * runs with no thread at all. Written straight into the journal, as an earlier version would.
 */
async function seedOldThreads(j: any) {
  const run = async (id: string, input: object) => { await j.put(`${id}:input`, input); await j.put(`${id}:model:0`, { text: 'x' }); };
  for (let i = 0; i < 30; i++) await run(`one-${i}`, { ...V, threadId: `t-one-${i % 10}`, resourceId: `ayse-${i % 10}` });
  await run('mixed-1', { ...V, threadId: 't-mixed', resourceId: 'ayse' });
  await run('mixed-2', { ...V, threadId: 't-mixed', resourceId: 'bora' });
  await run('anon-1', { ...V, threadId: 't-anon', ownerKind: 'unknown' });
  await run('anon-2', { ...V, threadId: 't-anon', ownerKind: 'unknown' });
  await run('old-anon', { threadId: 't-old-anon' });
  await run('half-1', { ...V, threadId: 't-half', ownerKind: 'unknown' });
  await run('half-2', { threadId: 't-half' });
  for (let i = 0; i < 5; i++) await run(`nothread-${i}`, { ...V, resourceId: 'cem' });
}
const THREADS = [...Array.from({ length: 10 }, (_, i) => `t-one-${i}`), 't-mixed', 't-anon', 't-old-anon', 't-half'];

const stores: [string, () => any][] = [
  ['memory', () => new InMemoryStorage()],
  ['sqlite', () => new SqliteStorage()],
  ['redis (fake)', () => new RedisStorage({ client: makeFakeRedis(undefined, true) as never })],
];

for (const [name, make] of stores) {
  describe(`storage.upgrade() — ${name}`, () => {
    it('thread-records writes exactly what the gate would derive, thread by thread', async () => {
      // The same data twice: one store upgraded, the other asked thread by thread the old way.
      const a = make(); const b = make();
      await a.init?.(); await b.init?.();
      const ja = toJournal(a.runs); const jb = toJournal(b.runs);
      await seedOldThreads(ja); await seedOldThreads(jb);
      await a.upgrade();
      for (const t of THREADS) await threadOwnerOf(jb, undefined, t);
      for (const t of THREADS) {
        const strip = (r: any) => r && { resourceId: r.resourceId, ownerKind: r.ownerKind, underivable: r.underivable };
        expect(strip(await ja.get(threadOwnerKey(t))), `${t} owner record`).toEqual(strip(await jb.get(threadOwnerKey(t))));
        expect(!!(await ja.get(threadSeenKey(t))), `${t} mark`).toBe(!!(await jb.get(threadSeenKey(t))));
      }
      expect(await ja.get(THREAD_RECORDS_KEY)).toBeDefined();
    });

    it('dryRun lists what is pending and writes nothing; a second upgrade finds nothing to do', async () => {
      const s = make(); await s.init?.();
      const j = toJournal(s.runs);
      await seedOldThreads(j);
      const dry = await s.upgrade({ dryRun: true });
      expect(dry.dryRun).toBe(true);
      expect(dry.steps.find((x: any) => x.name === 'thread-records')).toMatchObject({ pending: true, ran: false });
      expect(await j.get(THREAD_RECORDS_KEY)).toBeUndefined();
      expect(await j.get(threadOwnerKey('t-one-0'))).toBeUndefined();
      const first = await s.upgrade();
      expect(first.steps.filter((x: any) => x.ran).map((x: any) => x.name)).toContain('thread-records');
      const second = await s.upgrade();
      expect(second.steps.every((x: any) => x.pending === false && !x.ran)).toBe(true);
    });

    it('only: runs the named step and no other; a step this store lacks, or a misspelled option, is refused', async () => {
      const s = make(); await s.init?.();
      await seedOldThreads(toJournal(s.runs));
      const names = (await s.upgrade({ dryRun: true })).steps.map((x: any) => x.name);
      const other = names.find((n: string) => n !== 'thread-records');
      if (other) {
        const r = await s.upgrade({ only: [other] });
        expect(r.steps.find((x: any) => x.name === 'thread-records').ran).toBe(false);
        expect(await toJournal(s.runs).get(THREAD_RECORDS_KEY)).toBeUndefined();
      }
      const missing = ['schema', 'key-index'].find((n) => !names.includes(n))!;
      await expect(s.upgrade({ only: [missing] })).rejects.toThrow(/is not a step of this store\. Its steps:/);
      await expect(s.upgrade({ olny: ['thread-records'] } as any)).rejects.toThrow(/only/);
    });

    it('a registered organization gets its own marks, and the root its own', async () => {
      const s = make(); await s.init?.();
      const root = toJournal(s.runs);
      await root.put('__org__:acme', { at: 1 });
      const acme = withOrg(root, 'acme');
      await acme.put('o-1:input', { ...V, threadId: 'org-t', resourceId: 'deniz' });
      await acme.put('o-1:model:0', { text: 'x' });
      await root.put('r-1:input', { ...V, threadId: 'root-t', resourceId: 'ayse' });
      await root.put('r-1:model:0', { text: 'x' });
      await s.upgrade();
      expect((await acme.get(threadOwnerKey('org-t')))?.resourceId).toBe('deniz');
      expect(await acme.get(THREAD_RECORDS_KEY)).toBeDefined();
      expect((await root.get(threadOwnerKey('root-t')))?.resourceId).toBe('ayse');
      expect(await root.get(threadOwnerKey('org-t'))).toBeUndefined(); // the organization's thread is not the root's
    });
  });
}

describe('storage.upgrade() — a step is never run behind the caller\'s back', () => {
  it('Redis: thread-records alone, while key-index is pending, is refused and says how to run both', async () => {
    const client = makeFakeRedis(undefined, true);
    // A store an earlier version wrote: its keys are there before this version's first contact.
    await client.set('u:rj:legacy:model:0', superjson.stringify({ v: { text: 'x' }, r: 'legacy', k: 'model', s: false, t: 1 }));
    const s = new RedisStorage({ client: client as never, keyPrefix: 'u:' });
    const dry = await s.upgrade({ dryRun: true });
    expect(dry.steps.find((x) => x.name === 'key-index')?.pending).toBe(true);
    await expect(s.upgrade({ only: ['thread-records'] })).rejects.toThrow(/'thread-records' needs 'key-index' first.*only: \['key-index', 'thread-records'\]/);
    const both = await s.upgrade({ only: ['key-index', 'thread-records'] });
    expect(both.steps.map((x) => [x.name, x.ran])).toEqual([['key-index', true], ['thread-records', true], ['subject-index', false]]);
  });
});
