// Invariant: a thread 0.9 let the ROOT scope create under an `org:` id has a way back to its owner, and
// no organization reads it.
//
// 0.9's root AgentMemory accepted any thread id. 0.10 refuses a root-scope id under `org:`
// (`ReservedThreadIdError`), so such a thread became unreachable from the root — and one shaped like an
// organization's (`org:acme:support`) is READ by acme, whose view resolves `support` to the same physical
// id (review panel A "0.9 root thread", panel B a-orgthread.mjs: "org view acme: getMessages t1 -> [secret]").
// `migrateReservedRootThreads` moves them to a free id; `eraseSubject` lists the unmoved ones.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, withOrgStorage, withOrg, eraseSubject, ReservedThreadIdError, threadOwnerKey, toJournal, ORG_RECORD_PRE, type Storage, type MemoryStore, findReservedRootThreads } from '@gnldev/durable';
import { SqliteStorage } from '../../durable/src/sqlite-storage.js';
import { AgentMemory, migrateReservedRootThreads } from '../src/index.js';

const E = [1, 0, 0];
const embed = async () => E;
async function seed(mem: MemoryStore, id: string, resourceId: string, text: string) {
  await mem.upsertThread({ id, resourceId, createdAt: 1, updatedAt: 1 });
  await mem.appendMessages(id, [{ threadId: id, role: 'user', text, message: { role: 'user', content: text }, embedding: E, ts: 1 }]);
}

/**
 * An organization's thread as 0.9 left it: the same physical rows its view writes (`org:<id>:<t>`), but
 * no owner record. Written through the root port on purpose — this version's organization view writes
 * the owner record with the thread (`withOrgStorage(...).memory.upsertThread`), which 0.9 did not.
 */
async function seed09Org(s: Storage, org: string, id: string, resourceId: string, text: string) {
  await seed(s.memory!, `org:${org}:${id}`, resourceId, text);
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
    // acme's own, as 0.9's AgentMemory left it: a thread and a message, no owner record.
    await seed09Org(s, 'acme', 't-acme', 'u1', 'ACME-OWN');
    const acme = new AgentMemory({ storage: withOrgStorage(s, 'acme'), embed, recentN: 5 });
    return { s, acme, root: new AgentMemory({ storage: s, embed, recentN: 5 }) };
  }

  it('BEFORE: the root cannot name them, acme reads the root\'s support thread, and the root erasure lists them', async () => {
    const { s, acme, root } = await store09();
    await expect(root.getMessages('org:acme:support')).rejects.toBeInstanceOf(ReservedThreadIdError);
    expect(JSON.stringify(await acme.getMessages('support'))).toContain('ROOT-SECRET-SUPPORT');
    // The erasure erases the two that are certainly the root's (`org:123`, which no organization can
    // name, and `support`, whose owner record the root wrote) and lists the two it cannot tell apart
    // (one of them IS acme's `t-acme` — this erasure did not take it; acme's own, `{ orgId: 'acme' }`, does).
    const r = await eraseSubject(s, 'u1');
    expect(r.memoryThreads).toBe(2);
    expect(r.unreachedThreads).toEqual(['org:acme:ambiguous', 'org:acme:t-acme']);
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
    await seed09Org(s, 'acme', 't-acme', 'u1', 'ACME-OWN');
    const acme = new AgentMemory({ storage: withOrgStorage(s, 'acme'), embed, recentN: 5 });

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

  /**
   * 0.9's thread gate BACKFILLED a root owner record for a root request that named an organization's
   * thread — refused, but the record stayed: `thread:org:acme:t-run:owner = { resourceId, backfilled }`,
   * copied from the store's resourceId (acme's own). That record is not evidence the thread is the
   * root's (final-B M1: the default migration moved acme's `t-run` and the root user read its secret).
   */
  async function backfilled09(orgSide: boolean) {
    const s = make();
    await seed09Org(s, 'acme', 't-run', 'u1', 'ACME-TRUN-SECRET');
    if (orgSide) await withOrg(toJournal(s.runs), 'acme').put(threadOwnerKey('t-run'), { resourceId: 'u1', at: 1 });
    await toJournal(s.runs).put(threadOwnerKey('org:acme:t-run'), { resourceId: 'u1', at: 2, backfilled: true });
    return { s, acme: new AgentMemory({ storage: withOrgStorage(s, 'acme'), embed, recentN: 5 }) };
  }
  const acmeReads = async (acme: AgentMemory) => (await acme.getMessages('t-run')).map((m: { content: string }) => m.content);

  it('a backfilled root record AND an org-side record: the organization\'s — not listed, not moved, not erased by the root', async () => {
    const { s, acme } = await backfilled09(true);
    expect(await findReservedRootThreads(s)).toEqual([]);
    expect(await migrateReservedRootThreads(s)).toEqual({ moved: [], undecided: [], skipped: [] });
    const r = await eraseSubject(s, 'u1');
    expect(r.memoryThreads).toBe(0);
    expect(r.unreachedThreads).toEqual([]);
    expect(await acmeReads(acme)).toEqual(['ACME-TRUN-SECRET']);
  });

  it('a backfilled root record alone: undecided — not moved unless named, and the root erasure reports it instead of deleting it', async () => {
    const { s, acme } = await backfilled09(false);
    expect(await findReservedRootThreads(s)).toEqual([{ id: 'org:acme:t-run', resourceId: 'u1', rootOnly: false }]);
    expect(await migrateReservedRootThreads(s)).toEqual({ moved: [], undecided: ['org:acme:t-run'], skipped: [] });
    const r = await eraseSubject(s, 'u1');
    expect(r.memoryThreads).toBe(0);
    expect(r.unreachedThreads).toEqual(['org:acme:t-run']);
    expect(await acmeReads(acme)).toEqual(['ACME-TRUN-SECRET']);
  });

  it('an org-side record decides first, even against a root record that is not backfilled', async () => {
    const s = make();
    await seed(withOrgStorage(s, 'acme').memory!, 'support', 'u1', 'ACME-OWN');
    await withOrg(toJournal(s.runs), 'acme').put(threadOwnerKey('support'), { resourceId: 'u1', at: 1 });
    await toJournal(s.runs).put(threadOwnerKey('org:acme:support'), { resourceId: 'root-u', at: 1 });
    expect(await findReservedRootThreads(s)).toEqual([]);
    expect((await migrateReservedRootThreads(s)).moved).toEqual([]);
    expect((await eraseSubject(s, 'root-u')).memoryThreads).toBe(0);
    expect(JSON.stringify(await new AgentMemory({ storage: withOrgStorage(s, 'acme'), embed }).getMessages('support'))).toContain('ACME-OWN');
  });

  it('root erasure deletes the person\'s threads that are certainly the root\'s, and only those', async () => {
    const { s } = await store09();
    const r = await eraseSubject(s, 'u1');
    expect(r.memoryThreads).toBe(2); // org:123 (no organization can name it), org:acme:support (root record, not backfilled)
    expect(await s.memory!.getThread('org:123')).toBeUndefined();
    expect(await s.memory!.getThread('org:acme:support')).toBeUndefined();
    expect(await s.memory!.getThread('org:acme:ambiguous')).toBeDefined();
    expect(await s.memory!.getThread('org:acme:t-acme')).toBeDefined();
  });

  it('a thread an organization\'s AgentMemory creates today carries its owner record, so it is never listed', async () => {
    const s = make();
    const acme = new AgentMemory({ storage: withOrgStorage(s, 'acme'), embed, recentN: 5 });
    await acme.createThread({ id: 'fresh', resourceId: 'u1' });
    await acme.append('fresh', [{ role: 'user', content: 'x' }]);
    await acme.cloneThread('fresh', { newThreadId: 'copy' });
    expect(await withOrg(toJournal(s.runs), 'acme').get(threadOwnerKey('fresh'))).toMatchObject({ resourceId: 'u1' });
    expect(await findReservedRootThreads(s)).toEqual([]);
  });

  it('resourceId filter: only that person\'s, only the reserved space, organizations\' recorded threads excluded', async () => {
    const s = make();
    await seed(s.memory!, 'org:1', 'u1', 'A');
    await seed(s.memory!, 'org:2', 'u2', 'B');
    await seed(s.memory!, 'plain', 'u1', 'C');
    await new AgentMemory({ storage: withOrgStorage(s, 'acme'), embed }).createThread({ id: 't', resourceId: 'u1' });
    await seed09Org(s, 'globex', 'g', 'u1', 'D'); // 0.9-shaped: no record — undecided
    expect(await findReservedRootThreads(s, { resourceId: 'u1' })).toEqual([
      { id: 'org:1', resourceId: 'u1', rootOnly: true },
      { id: 'org:globex:g', resourceId: 'u1', rootOnly: false },
    ]);
  });
});
