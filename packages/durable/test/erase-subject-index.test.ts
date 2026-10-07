// An erasure that lists a person's index (subject-index.ts) leaves exactly what the full walk leaves —
// on the same world, with the index trusted on one store and the walk forced on its twin. And it reads
// what that person owns, not what the store holds.
import { describe, it, expect } from 'vitest';
import * as D from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { RedisStorage } from '../src/redis-storage.js';
import { makeFakeRedis } from './fake-redis.js';
import { SUBJECT_INDEX_KEY, subjectKey, subjectPrefix } from '../src/subject-index.js';
import { claimRunOwner, user } from '../src/run-identity.js';

const { InMemoryStorage, toJournal, eraseSubject, purgeRun, purgeThread, assignThreadOwner, admitThreadRun, threadOwnerKey } = D as any;
const V = { _v: 1 };

const stores: [string, () => any][] = [
  ['memory', () => new InMemoryStorage()],
  ['sqlite', () => new SqliteStorage()],
  ['redis (fake)', () => new RedisStorage({ client: makeFakeRedis(undefined, true) as never })],
];

/** Every key of a journal and its value, as text — what survives an erasure. */
async function dump(j: any): Promise<string[]> {
  const keys: string[] = await j.listKeys('');
  // Write times differ between the twins by a millisecond or two; what survives is compared, not when.
  return (await Promise.all(keys.map(async (k) => `${k}=${JSON.stringify(await j.get(k)).replace(/"at":\d+/g, '"at":0')}`))).sort();
}

/**
 * The world, written the way this version writes it (births through claimRunOwner, threads through the
 * gate), plus one run and one thread an earlier version left with no index entry.
 */
async function world(j: any) {
  const born = async (runId: string, who: string, threadId?: string) => {
    if (threadId) await admitThreadRun(j, undefined, threadId, user(who));
    await claimRunOwner(j, runId, user(who), threadId ? { threadId } : {});
    await j.put(`${runId}:model:0`, { text: `${who} said something` });
  };
  for (let i = 0; i < 6; i++) await born(`ay-t-${i}`, 'ayse', `ay-thread-${i % 2}`);
  await born('ay-nothread', 'ayse');                    // a run with no thread: an API call, a batch item
  await born('bob-1', 'bob', 'bob-thread');
  await born('evil-1', 'bob:evil', 'evil-thread');      // a namesake whose id starts with 'bob:'
  await born('cem-1', 'cem', 'cem-thread');
  // A thread whose owner record names ayse but that no memory store holds: reported, not erased.
  await j.put(threadOwnerKey('ay-record-only'), { at: 1, resourceId: 'ayse' });
  await j.put(subjectKey('thread', 'ayse', 'ay-record-only'), { at: 1 });
  // An entry pointing at a run someone else won: must not erase cem's run.
  await j.put(subjectKey('run', 'ayse', 'cem-1'), { at: 1 });
}

for (const [name, make] of stores) {
  describe(`erasure through the subject index — ${name}`, () => {
    it('leaves exactly what the full walk leaves', async () => {
      const a = make(); const b = make();
      await a.init?.(); await b.init?.();
      const ja = toJournal(a.runs); const jb = toJournal(b.runs);
      await world(ja); await world(jb);
      expect(await ja.get(SUBJECT_INDEX_KEY)).toBeDefined();          // fresh store: complete from its first birth
      await jb.deletePrefix(SUBJECT_INDEX_KEY);                       // its twin walks, as before the index
      const ra = await eraseSubject(a, 'ayse');
      const rb = await eraseSubject(b, 'ayse');
      // The thread only its owner record knows is not erased but reported, on both paths alike.
      expect([...ra.unreachedThreads].sort()).toEqual([...rb.unreachedThreads].sort());
      expect(ra.unreachedThreads).toContain('ay-record-only');
      expect({ ...ra, unreachedThreads: [] }).toEqual({ ...rb, unreachedThreads: [] });
      const strip = (rows: string[]) => rows.filter((r) => !r.startsWith(SUBJECT_INDEX_KEY));
      expect(strip(await dump(ja))).toEqual(strip(await dump(jb)));
      const left = (await dump(ja)).join('\n');
      expect(left).not.toMatch(/ay-t-|ay-nothread|ay-thread/);
      expect(left).not.toContain(subjectPrefix('ayse'));             // the index named her: it goes too
      expect(left).toMatch(/bob-1/); expect(left).toMatch(/evil-1/); expect(left).toMatch(/cem-1/);
      expect(left).toContain(subjectPrefix('bob:evil'));              // the namesake keeps his index
    });

    it('a run from before the index is still erased: the walk until the store is upgraded, the index after', async () => {
      const s = make(); await s.init?.();
      const j = toJournal(s.runs);
      await j.put('old-1:input', { ...V, resourceId: 'ayse' }); // written by an earlier version: no entry
      await j.put('old-1:model:0', { text: 'x' });
      await claimRunOwner(j, 'new-1', user('ayse'));
      expect(await j.get(SUBJECT_INDEX_KEY)).toBeUndefined();        // the store held runs: not complete
      const t = make(); await t.init?.();
      const k = toJournal(t.runs);
      await k.put('old-1:input', { ...V, resourceId: 'ayse' });
      await k.put('old-1:model:0', { text: 'x' });
      await t.upgrade({ only: ['subject-index'] });
      expect(await k.get(SUBJECT_INDEX_KEY)).toBeDefined();
      expect(await k.get(subjectKey('run', 'ayse', 'old-1'))).toBeDefined();
      await eraseSubject(s, 'ayse'); await eraseSubject(t, 'ayse');
      expect((await dump(j)).join('\n')).not.toMatch(/old-1|new-1/);
      expect((await dump(k)).join('\n')).not.toMatch(/old-1/);
    });

    it('a birth that loses its run to another owner takes its entry back', async () => {
      const s = make(); await s.init?.();
      const j = toJournal(s.runs);
      await claimRunOwner(j, 'r-shared', user('cem'));
      await claimRunOwner(j, 'r-shared', user('ayse'));            // the run is cem's: ayse's birth loses
      expect(await j.get(subjectKey('run', 'cem', 'r-shared'))).toBeDefined();
      expect(await j.get(subjectKey('run', 'ayse', 'r-shared'))).toBeUndefined();
    });

    it('an entry goes with what it points at: a purged run, a purged thread, a thread given to someone else', async () => {
      const s = make(); await s.init?.();
      const j = toJournal(s.runs);
      await admitThreadRun(j, undefined, 'th', user('ayse'));
      await claimRunOwner(j, 'r1', user('ayse'), { threadId: 'th' });
      await claimRunOwner(j, 'r10', user('ayse'));
      expect(await j.get(subjectKey('run', 'ayse', 'r1'))).toBeDefined();
      await purgeRun(j, 'r1');
      expect(await j.get(subjectKey('run', 'ayse', 'r1'))).toBeUndefined();
      expect(await j.get(subjectKey('run', 'ayse', 'r10'))).toBeDefined(); // `r1` is not a prefix of `r10`'s key
      await assignThreadOwner(j, 'th', 'bora');
      expect(await j.get(subjectKey('thread', 'ayse', 'th'))).toBeUndefined();
      expect(await j.get(subjectKey('thread', 'bora', 'th'))).toBeDefined();
      await purgeThread(j, 'th');
      expect(await j.get(subjectKey('thread', 'bora', 'th'))).toBeUndefined();
    });
  });
}
