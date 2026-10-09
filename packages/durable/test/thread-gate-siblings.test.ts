// The thread gate (thread-owner.ts) decides who owns a thread from point reads — the owner record and
// the anonymous thread's `seen` marker — never from the store's other runs. These are the same eight
// cases on every store: who may claim a new, an anonymous and an older thread, a race between users,
// a journal with only the required methods, and the cost of a new thread (S7: 1000 unrelated runs,
// fewer than 10 summaries and 20 calls; before, every run was read: 70 s at 30 000 runs on Postgres).
import { describe, it, expect } from 'vitest';
import { newDb } from 'pg-mem';
import * as D from '../src/index.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { STAFF, UNKNOWN, user } from '../src/run-identity.js';

const { InMemoryStorage, toJournal, admitThreadRun } = D as any;
/** Each journal's storage, so a test upgrades the store the way a host does: `storage.upgrade()`. */
const storageOf = new WeakMap<object, any>();
const journalOf = (s: any) => { const j = toJournal(s.runs); storageOf.set(j, s); return j; };
// Only the step this gate needs: the relation columns have their own tests (erase-relations), and a second
// pass over 1000 runs on pg-mem ran past the timeout under a loaded full suite.
const upgrade = async (j: any) => { const s = storageOf.get(j); await s.init?.(); await s.upgrade({ only: ['thread-records'] }); };

const stores: [string, () => any][] = [
  ['memory', () => new InMemoryStorage()],
  ['sqlite', () => new SqliteStorage()],
  ['postgres (pg-mem)', () => new PostgresStorage({ pool: new (newDb().adapters.createPg().Pool)() })],
];

const admit = (j: any, t: string, caller: any) => admitThreadRun(j, undefined, t, caller).then((o: any) => o, (e: Error) => `REFUSED:${e.name}`);

/** A journal with only what the Journal contract requires: no putIfMatch, no applyBatch. */
function minimal(j: any) {
  const m = { get: (k: string) => j.get(k), put: (k: string, v: unknown) => j.put(k, v), putIfAbsent: (k: string, v: unknown) => j.putIfAbsent(k, v), listRuns: (q?: unknown) => j.listRuns(q), delete: j.delete && ((k: string) => j.delete(k)) };
  storageOf.set(m, storageOf.get(j));
  return m;
}

/** Counts every read and every run summary handed back. */
function counted(j: any) {
  const n = { calls: 0, items: 0 };
  const p = new Proxy(j, {
    get(t, prop) {
      const v = t[prop];
      if (typeof v !== 'function') return v;
      return async (...a: unknown[]) => {
        n.calls++;
        const r = await v.apply(t, a);
        if (prop === 'listRuns') n.items += Array.isArray(r) ? r.length : (r?.items?.length ?? 0);
        if (prop === 'getMany') n.items += (r as unknown[]).length;
        return r;
      };
    },
  });
  return { j: p, n };
}

for (const [name, make] of stores) {
  describe(`thread gate siblings (${name})`, () => {
    it('S1 new thread: the first named user owns it, another is refused', async () => {
      const j = journalOf(make());
      await upgrade(j);
      expect((await admit(j, 't', user('ayse'))).owner).toBe('ayse');
      expect(await admit(j, 't', user('mallory'))).toBe('REFUSED:ThreadOwnerMismatchError');
    });

    it('S2 anonymous first turn, then a named user claims it, then a stranger is refused', async () => {
      const j = journalOf(make());
      await upgrade(j);
      const a = await admit(j, 't', UNKNOWN);
      expect(typeof a).not.toBe('string');
      await j.put('anon-run:input', { threadId: 't', ownerKind: 'unknown', _v: 1 });
      expect((await admit(j, 't', user('ayse'))).owner).toBe('ayse');
      expect(await admit(j, 't', user('mallory'))).toBe('REFUSED:ThreadOwnerMismatchError');
      expect(await admit(j, 't', UNKNOWN)).toBe('REFUSED:ThreadOwnerMismatchError');
    });

    it('S3 two named users race for an anonymous thread: exactly one owns it', async () => {
      const j = journalOf(make());
      await upgrade(j);
      await admit(j, 't', UNKNOWN);
      const res = await Promise.all(['ayse', 'bora', 'cem', 'deniz'].map((u) => admit(j, 't', user(u))));
      const owners = new Set((await Promise.all(['ayse', 'bora', 'cem', 'deniz'].map((u) => admit(j, 't', user(u))))).filter((r) => typeof r !== 'string').map((r: any) => r.owner));
      expect(owners.size).toBe(1);
      expect(res.filter((r) => typeof r !== 'string').length).toBeGreaterThanOrEqual(1);
    });

    it('S4 a thread from before owner records (0.6): its owner comes from its runs, a stranger is refused', async () => {
      const j = journalOf(make());
      await j.put('old-1:input', { threadId: 'legacy', resourceId: 'ayse' });
      await j.put('old-1:model:0', { text: 'x' });
      await upgrade(j);
      expect(await admit(j, 'legacy', user('mallory'))).toBe('REFUSED:ThreadOwnerMismatchError');
      expect((await admit(j, 'legacy', user('ayse'))).owner).toBe('ayse');
    });

    it('S5 an anonymous thread from 0.6 stays closed to a named user', async () => {
      const j = journalOf(make());
      await j.put('old-2:input', { threadId: 'legacy-anon' });
      await j.put('old-2:model:0', { text: 'x' });
      await upgrade(j);
      expect(await admit(j, 'legacy-anon', user('ayse'))).toBe('REFUSED:ThreadOwnerMismatchError');
    });

    it('S6 a journal with only the required methods keeps S2 and S3', async () => {
      const j = minimal(journalOf(make()));
      await upgrade(j);
      await admit(j, 't', UNKNOWN);
      const res = await Promise.all(['ayse', 'bora', 'cem'].map((u) => admit(j, 't', user(u))));
      const owners = new Set((await Promise.all(['ayse', 'bora', 'cem'].map((u) => admit(j, 't', user(u))))).filter((r) => typeof r !== 'string').map((r: any) => r.owner));
      expect(owners.size).toBe(1);
      expect(res.some((r) => typeof r !== 'string')).toBe(true);
    });

    // What S7 measures is reads, not time; seeding 1000 runs into pg-mem took 6.6 s alone and past 30 s
    // in a loaded full suite, so its time limit is its own.
    it('S7 a new thread does not read the store\'s other runs (1000 unrelated runs)', { timeout: 120_000 }, async () => {
      const raw = journalOf(make());
      await upgrade(raw);
      for (let i = 0; i < 1000; i += 100) await Promise.all(Array.from({ length: 100 }, (_, k) => raw.put(`u-${i + k}:model:0`, { text: 'x' })));
      const { j, n } = counted(raw);
      await admit(j, `fresh-${Math.random()}`, user('ayse'));
      expect(n.items).toBeLessThan(10);
      expect(n.calls).toBeLessThan(20);
    });

    // An older process (0.10) still writing after the store was upgraded: it writes the owner record
    // for a named user (records exist since 0.7) but no `seen` marker for an anonymous turn. The gate
    // then reads that anonymous thread as new. Nobody reaches another user's thread either way.
    it('S9 an older process writing after the upgrade: a named user\'s thread stays theirs', async () => {
      const j = journalOf(make());
      await upgrade(j);
      await D.claim(j, D.threadOwnerKey('late-owned'), { at: 1, resourceId: 'ayse' }); // what 0.10 writes
      await j.put('old-n:input', { _v: 1, threadId: 'late-owned', resourceId: 'ayse' });
      expect(await admit(j, 'late-owned', user('mallory'))).toBe('REFUSED:ThreadOwnerMismatchError');
      expect(await admit(j, 'late-owned', UNKNOWN)).toBe('REFUSED:ThreadOwnerMismatchError');
      expect((await admit(j, 'late-owned', user('ayse'))).owner).toBe('ayse');
    });

    it('S10 an older process\'s anonymous turn after the upgrade: the first named user claims it, as before; a stranger after is refused', async () => {
      const j = journalOf(make());
      await upgrade(j);
      await j.put('old-a:input', { _v: 1, threadId: 'late-anon', ownerKind: 'unknown' }); // 0.10: no marker
      expect((await admit(j, 'late-anon', user('ayse'))).owner).toBe('ayse');
      expect(await admit(j, 'late-anon', user('mallory'))).toBe('REFUSED:ThreadOwnerMismatchError');
    });

    it('S8 staff opening a new thread claims it closed; a user is refused', async () => {
      const j = journalOf(make());
      await upgrade(j);
      await admit(j, 's', STAFF);
      expect(await admit(j, 's', user('ayse'))).toBe('REFUSED:ThreadOwnerMismatchError');
    });
  });
}
