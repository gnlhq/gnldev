// Invariant: a thread 0.9 let the ROOT scope create under an `org:` id has a way back to its owner, and
// no organization reads it.
//
// 0.9's root AgentMemory accepted any thread id. 0.10 refuses a root-scope id under `org:`
// (`ReservedThreadIdError`), so such a thread became unreachable from the root — and one shaped like an
// organization's (`org:acme:support`) is READ by acme, whose view resolves `support` to the same physical
// id (review panel A "0.9 root thread", panel B a-orgthread.mjs: "org view acme: getMessages t1 -> [secret]").
// `migrateReservedRootThreads` moves them to a free id; `eraseSubject` lists the unmoved ones.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, withOrgStorage, eraseSubject, ReservedThreadIdError, threadOwnerKey, toJournal, ORG_RECORD_PRE, type Storage, type MemoryStore, findReservedRootThreads } from '@gnldev/durable';
import { SqliteStorage } from '../../durable/src/sqlite-storage.js';
import { AgentMemory, migrateReservedRootThreads } from '../src/index.js';

const E = [1, 0, 0];
const embed = async () => E;
async function seed(mem: MemoryStore, id: string, resourceId: string, text: string) {
  await mem.upsertThread({ id, resourceId, createdAt: 1, updatedAt: 1 });
  await mem.appendMessages(id, [{ threadId: id, role: 'user', text, message: { role: 'user', content: text }, embedding: E, ts: 1 }]);
}

const engines: [string, () => Storage][] = [
  ['InMemoryStorage', () => new InMemoryStorage()],
  ['SqliteStorage', () => new SqliteStorage(':memory:') as unknown as Storage],
];

describe.each(engines)('threads 0.9 let the root create under org: (%s)', (_n, make) => {
  /**
   * A store as 0.9 left it, in a deployment where acme is a registered organization: the root's
   * `org:123` and `org:acme:support` (its owner record at the root), the root's `org:acme:ambiguous`
   * (no record anywhere — written by a memory alone), and acme's own `t-acme` (also no record).
   */
  async function store09() {
    const s = make();
    await toJournal(s.runs).put(ORG_RECORD_PRE + 'acme', { label: 'Acme' });
    await seed(s.memory!, 'org:123', 'u1', 'ROOT-SECRET-123');
    await seed(s.memory!, 'org:acme:support', 'u1', 'ROOT-SECRET-SUPPORT');
    await toJournal(s.runs).put(threadOwnerKey('org:acme:support'), { resourceId: 'u1', at: 1 });
    await seed(s.memory!, 'org:acme:ambiguous', 'u1', 'WHOSE');
    const acme = new AgentMemory({ storage: withOrgStorage(s, 'acme'), embed, recentN: 5 });
    await acme.createThread({ id: 't-acme', resourceId: 'u1' });
    await acme.append('t-acme', [{ role: 'user', content: 'ACME-OWN' }]);
    return { s, acme, root: new AgentMemory({ storage: s, embed, recentN: 5 }) };
  }

  it('BEFORE: the root cannot name them, acme reads the root\'s support thread, and the root erasure lists them', async () => {
    const { s, acme, root } = await store09();
    await expect(root.getMessages('org:acme:support')).rejects.toBeInstanceOf(ReservedThreadIdError);
    expect(JSON.stringify(await acme.getMessages('support'))).toContain('ROOT-SECRET-SUPPORT');
    // The erasure reaches the one whose owner record the root holds, and lists every other one of u1's
    // in that space: the one that is certainly the root's and the two it cannot tell apart (one of them
    // IS acme's `t-acme` — this erasure did not reach it; acme's own, `{ orgId: 'acme' }`, does).
    const r = await eraseSubject(s, 'u1');
    expect(r.unreachedThreads).toEqual(['org:123', 'org:acme:ambiguous', 'org:acme:t-acme']);
  });

  it('migrateReservedRootThreads moves the root\'s, leaves the undecided one unless named, and acme no longer reads the root\'s', async () => {
    const { s, acme, root } = await store09();
    const dry = await migrateReservedRootThreads(s, { dryRun: true });
    expect(dry.moved).toEqual([{ from: 'org:123', to: 'legacy-org:123' }, { from: 'org:acme:support', to: 'legacy-org:acme:support' }]);
    expect(await s.memory!.getThread('org:acme:support')).toBeDefined();
    expect(await s.memory!.getThread('org:123')).toBeDefined();

    const r = await migrateReservedRootThreads(s);
    expect(r.moved.map((m) => m.from)).toEqual(['org:123', 'org:acme:support']);
    // Shaped like a thread of acme, which exists, and no owner record either way: not guessed.
    expect(r.undecided).toEqual(['org:acme:ambiguous', 'org:acme:t-acme']);
    expect((await root.getMessages('legacy-org:acme:support')).map((m: { content: string }) => m.content)).toEqual(['ROOT-SECRET-SUPPORT']);
    expect((await root.getMessages('legacy-org:123')).map((m: { content: string }) => m.content)).toEqual(['ROOT-SECRET-123']);
    expect(await toJournal(s.runs).get(threadOwnerKey('legacy-org:acme:support'))).toMatchObject({ resourceId: 'u1' });
    expect(JSON.stringify(await acme.getMessages('support'))).not.toContain('ROOT-SECRET');
    // acme's own thread is untouched.
    expect((await acme.getMessages('t-acme')).map((m: { content: string }) => m.content)).toEqual(['ACME-OWN']);

    // Named, the undecided one moves too; a second run finds nothing.
    expect((await migrateReservedRootThreads(s, { threadIds: ['org:acme:ambiguous'] })).moved).toEqual([{ from: 'org:acme:ambiguous', to: 'legacy-org:acme:ambiguous' }]);
    expect(await migrateReservedRootThreads(s)).toEqual({ moved: [], undecided: ['org:acme:t-acme'], skipped: [] });
    // And the erasure now reaches all of the root's; acme's own is still reported as not reached here.
    const erased = await eraseSubject(s, 'u1');
    expect(erased.unreachedThreads).toEqual(['org:acme:t-acme']);
    expect(erased.memoryThreads).toBe(3);
  });

  it('an organization 0.9 never registered (the common case): its own thread is undecided, never moved, and it keeps reading it', async () => {
    // 0.9's withOrgStorage wrote no `__org__:` record, and a memory-only thread leaves no owner record,
    // so the journal says nothing about acme at all. Guessing "no such organization → the root's" moved
    // acme's thread out from under it (measured on the 0.9.0 fixture); it must be undecided.
    const s = make();
    await seed(s.memory!, 'org:123', 'u1', 'ROOT-SECRET-123');
    const acme = new AgentMemory({ storage: withOrgStorage(s, 'acme'), embed, recentN: 5 });
    await acme.createThread({ id: 't-acme', resourceId: 'u1' });
    await acme.append('t-acme', [{ role: 'user', content: 'ACME-OWN' }]);

    expect(await findReservedRootThreads(s)).toEqual([
      { id: 'org:123', resourceId: 'u1', rootOnly: true },
      { id: 'org:acme:t-acme', resourceId: 'u1', rootOnly: false },
    ]);
    const r = await migrateReservedRootThreads(s);
    expect(r).toEqual({ moved: [{ from: 'org:123', to: 'legacy-org:123' }], undecided: ['org:acme:t-acme'], skipped: [] });
    expect((await acme.getMessages('t-acme')).map((m: { content: string }) => m.content)).toEqual(['ACME-OWN']);
    expect((await acme.listThreads({ resourceId: 'u1' })).map((t) => t.id)).toEqual(['t-acme']);
    // Named explicitly it moves — the operator's decision, not a guess.
    expect((await migrateReservedRootThreads(s, { threadIds: ['org:acme:t-acme'] })).moved).toEqual([{ from: 'org:acme:t-acme', to: 'legacy-org:acme:t-acme' }]);
    expect(await acme.listThreads({ resourceId: 'u1' })).toEqual([]);
  });

  it('refuses a new id that is taken, or still in the reserved space, and names why', async () => {
    const { s } = await store09();
    await seed(s.memory!, 'legacy-org:123', 'u2', 'TAKEN');
    const r = await migrateReservedRootThreads(s, { rename: (id) => (id === 'org:123' ? 'legacy-org:123' : `org:x:${id}`) });
    expect(r.moved).toEqual([]);
    expect(r.skipped.map((x) => x.id)).toEqual(['org:123', 'org:acme:support']);
    expect(r.skipped[0]!.reason).toMatch(/already exists/);
    expect(r.skipped[1]!.reason).toMatch(/reserved space/);
  });
});
