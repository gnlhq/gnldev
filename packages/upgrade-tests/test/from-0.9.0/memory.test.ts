// Upgrade from 0.9.0, memory: what 0.9.0's memories stored for one person (u1) — root threads, an
// organization thread written through withOrgStorage, two ROOT threads named `org:…` (0.9.0 allowed
// it), working memory (resource and thread scope), observations, and the journal-kept logs of
// BasicMemory and SemanticMemory in 0.9.0's bare-array shape — beside another person's (u2) thread.
import { describe, expect, it } from 'vitest';
import { BasicMemory, ReservedThreadIdError, eraseSubject, findReservedRootThreads, readJournalLog, sweepThreads, toJournal, withOrgStorage } from '@gnldev/durable';
import { AgentMemory, migrateReservedRootThreads } from '@gnldev/memory';
import { SemanticMemory } from '@gnldev/rag';
import * as S from '../../generate/shapes.mjs';
import { itMigrates, notes090, openFixture, rowsContaining } from '../support.js';

const M = S.MEMORY;
const mark = (what: string) => `${S.U1_MARK}-${what}`;
const text = (msgs: any[]) => msgs.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join(' | ');

describe('upgrade from 0.9.0 — memory', () => {
  itMigrates('memory.db');

  it('the fixture is what it claims: 0.9.0 listed the org-prefixed root threads and the organization thread as the root user\'s', () => {
    expect(notes090.memory.rootListThreads).toEqual(expect.arrayContaining([M.rootThread, ...M.orgPrefixedRootThreads, `org:${M.orgId}:${M.orgThread}`]));
    expect(notes090.memory.basicShape).toBe('array');
    expect(notes090.memory.observations).toEqual([`- ${mark('OBS')} prefers tea`]);
  });

  it('a root thread 0.9.0 wrote is read, listed and recalled as before', async () => {
    const { storage } = await openFixture('memory.db');
    const mem = new AgentMemory({ storage, embed: S.fixtureEmbed });
    expect(text(await mem.getMessages(M.rootThread))).toContain(mark('ROOT'));
    expect((await mem.listThreads({ resourceId: 'u1' })).map((t) => t.id)).toEqual(expect.arrayContaining([M.rootThread, M.wmThread, M.omThread]));
  });

  it('an organization thread 0.9.0 wrote is read through withOrgStorage, and no longer listed by the root', async () => {
    const { storage } = await openFixture('memory.db');
    const org = new AgentMemory({ storage: withOrgStorage(storage, M.orgId), embed: S.fixtureEmbed });
    expect(text(await org.getMessages(M.orgThread))).toContain(mark('ACME'));
    expect((await org.listThreads({ resourceId: 'u1' })).map((t) => t.id)).toContain(M.orgThread);
    const root = new AgentMemory({ storage, embed: S.fixtureEmbed });
    expect((await root.listThreads({ resourceId: 'u1' })).map((t) => t.id)).not.toContain(`org:${M.orgId}:${M.orgThread}`);
  });

  it('a 0.9.0 root thread named `org:…` is refused by the root memory with ReservedThreadIdError (documented)', async () => {
    const { storage } = await openFixture('memory.db');
    const mem = new AgentMemory({ storage, embed: S.fixtureEmbed });
    for (const id of M.orgPrefixedRootThreads) await expect(mem.getMessages(id)).rejects.toBeInstanceOf(ReservedThreadIdError);
  });

  it('a 0.9.0 root thread named `org:…` is found and moved by the documented way through, and the organization keeps its own', async () => {
    const { storage } = await openFixture('memory.db');
    const root = new AgentMemory({ storage, embed: S.fixtureEmbed });
    const acme = new AgentMemory({ storage: withOrgStorage(storage, M.orgId), embed: S.fixtureEmbed });
    // The root scans skip the reserved space (documented); the finder lists what is there for u1.
    expect((await root.listThreads({ resourceId: 'u1' })).map((t) => t.id)).not.toEqual(expect.arrayContaining(M.orgPrefixedRootThreads));
    const found = await findReservedRootThreads(storage, { resourceId: 'u1' });
    expect(found).toEqual([
      { id: 'org:123', resourceId: 'u1', rootOnly: true }, // no organization's view can produce it
      { id: `org:${M.orgId}:${M.orgThread}`, resourceId: 'u1', rootOnly: false }, // acme's own — no record either way
      { id: `org:${M.orgId}:${M.orgMemThread}`, resourceId: 'u1', rootOnly: false }, // acme's — only a BACKFILLED root record
      { id: 'org:legacy:notes', resourceId: 'u1', rootOnly: false }, // shaped like an organization's: undecided
    ]); // `org:acme:t-run` is not listed: acme's own record decides first
    // The default migration moves only what is certainly the root's.
    const r = await migrateReservedRootThreads(storage);
    expect(r.moved).toEqual([{ from: 'org:123', to: 'legacy-org:123' }]);
    expect(r.undecided).toEqual([`org:${M.orgId}:${M.orgThread}`, `org:${M.orgId}:${M.orgMemThread}`, 'org:legacy:notes']);
    expect(text(await root.getMessages('legacy-org:123'))).toContain(mark('ORGPREFIX'));
    expect(text(await acme.getMessages(M.orgThread))).toContain(mark('ACME'));
    // The operator names the undecided root one; acme's stays acme's.
    expect((await migrateReservedRootThreads(storage, { threadIds: ['org:legacy:notes'] })).moved).toEqual([{ from: 'org:legacy:notes', to: 'legacy-org:legacy:notes' }]);
    expect(text(await root.getMessages('legacy-org:legacy:notes'))).toContain(mark('ORGPREFIX'));
    expect((await acme.listThreads({ resourceId: 'u1' })).map((t) => t.id).sort()).toEqual([M.orgMemThread, M.orgRunThread, M.orgThread].sort());
  });

  // final-B M1: 0.9.0's gate backfilled a root owner record (`backfilled: true`, the store's resourceId —
  // acme's u1) for a ROOT request it refused. Read as "the root's", the default migration moved acme's
  // threads to `legacy-org:acme:*`, acme read nothing, and the root's u1 read them; the root erasure
  // deleted them.
  it("acme's threads a refused 0.9.0 root request named stay acme's: not moved, not erased by the root", async () => {
    expect(notes090.memory.intruderRefused).toEqual({ [M.orgRunThread]: 'ThreadOwnerMismatchError', [M.orgMemThread]: 'ThreadOwnerMismatchError' });
    expect(notes090.memory.ownerRecords[`thread:org:${M.orgId}:${M.orgRunThread}:owner`]).toMatchObject({ resourceId: 'u1', backfilled: true });
    expect(notes090.memory.ownerRecords[`thread:org:${M.orgId}:${M.orgMemThread}:owner`]).toMatchObject({ resourceId: 'u1', backfilled: true });
    const f = await openFixture('memory.db');
    const acme = new AgentMemory({ storage: withOrgStorage(f.storage, M.orgId), embed: S.fixtureEmbed });
    const r = await migrateReservedRootThreads(f.storage);
    expect(r.moved.map((x) => x.from)).not.toEqual(expect.arrayContaining([`org:${M.orgId}:${M.orgRunThread}`]));
    expect(r.moved.map((x) => x.from)).not.toEqual(expect.arrayContaining([`org:${M.orgId}:${M.orgMemThread}`]));
    // Named, the one acme's own record claims is refused with the reason; the undecided one would move (not done here).
    const named = await migrateReservedRootThreads(f.storage, { threadIds: [`org:${M.orgId}:${M.orgRunThread}`], dryRun: true });
    expect(named.moved).toEqual([]);
    expect(named.skipped[0]!.reason).toMatch(/organization's own/);
    const erased = await eraseSubject(f.storage, 'u1');
    expect(erased.unreachedThreads).toContain(`org:${M.orgId}:${M.orgMemThread}`);
    expect(erased.unreachedThreads).not.toContain(`org:${M.orgId}:${M.orgRunThread}`);
    expect(text(await acme.getMessages(M.orgRunThread))).toContain(mark('ACMERUN'));
    expect(text(await acme.getMessages(M.orgMemThread))).toContain(mark('ACMEMEM'));
    // acme's own erasure takes them.
    await eraseSubject(f.storage, 'u1', { orgId: M.orgId });
    expect(await acme.getMessages(M.orgRunThread)).toEqual([]);
    expect(await acme.getMessages(M.orgMemThread)).toEqual([]);
  });

  it('working memory 0.9.0 wrote (resource and thread scope) is read back', async () => {
    const { storage } = await openFixture('memory.db');
    const res = new AgentMemory({ storage, embed: S.fixtureEmbed, workingMemory: { scope: 'resource', template: '# Notes' } });
    expect(await res.getWorkingMemory(M.wmThread)).toContain(mark('WM'));
    const thr = new AgentMemory({ storage, embed: S.fixtureEmbed, workingMemory: { scope: 'thread', template: '# Notes' } });
    expect(await thr.getWorkingMemory(M.wmThread)).toContain(mark('WMTHREAD'));
  });

  it('observations 0.9.0 made are recalled, and loadContext still carries them', async () => {
    const { storage } = await openFixture('memory.db');
    const calls = { n: 0 };
    const om = new AgentMemory({
      storage,
      embed: S.fixtureEmbed,
      observationalMemory: { enabled: true, observerModel: S.textModel('- new observation', calls), observation: { messageThreshold: 4 } },
    });
    expect((await om.recallObservations(M.omThread, 'tea')).map((o: any) => o.text).join(' ')).toContain(mark('OBS'));
    const ctx = await om.loadContext(M.omThread, { resourceId: 'u1' });
    expect(text(ctx.messages)).toContain(mark('OBS'));
    expect(calls.n).toBe(0);
  });

  it("BasicMemory reads 0.9.0's array log, keeps it on the next append (converted), and loses nothing to concurrent appends", async () => {
    const { storage } = await openFixture('memory.db');
    const j = toJournal(storage.runs);
    const bm = new BasicMemory(j);
    const before = await bm.getMessages(M.basicThread);
    expect(text(before)).toContain(mark('BASIC'));
    expect(await readJournalLog(j, `mem:${M.basicThread}:messages`)).toEqual(before);
    await Promise.all([1, 2, 3].map((i) => bm.append(M.basicThread, [{ role: 'user', content: `after ${i}` }])));
    const after = await bm.getMessages(M.basicThread);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.map((m: any) => m.content).filter((c: unknown) => typeof c === 'string' && c.startsWith('after ')).sort()).toEqual(['after 1', 'after 2', 'after 3']);
    expect(await j.get(`mem:${M.basicThread}:messages`)).toMatchObject({ gnlLog: 1 });
  });

  it("SemanticMemory reads 0.9.0's array log and keeps it on the next append", async () => {
    const { storage } = await openFixture('memory.db');
    const j = toJournal(storage.runs);
    const sm = new SemanticMemory({ journal: j, embed: S.fixtureEmbed });
    const before = await sm.getMessages(M.semanticThread);
    expect(text(before)).toContain(mark('SEM'));
    await sm.append(M.semanticThread, [{ role: 'user', content: 'after' }]);
    const after = await sm.getMessages(M.semanticThread);
    expect(after).toHaveLength(before.length + 1);
    expect(text(after)).toContain(mark('SEM'));
  });

  it('the retention sweep removes a 0.9.0 BasicMemory array log older than the window, and keeps the recent one', async () => {
    const f = await openFixture('memory.db');
    const r = await sweepThreads(toJournal(f.storage.runs), { olderThanMs: 90 * 86_400_000, now: Date.UTC(2026, 9, 1) });
    expect(r.purged).toContain(M.basicOldThread);
    expect(r.purged).not.toContain(M.basicThread);
    expect(rowsContaining(f.path, 'old basic message')).toEqual([]);
  });

  // Not specific to 0.9.0 data: SemanticMemory keeps its log under `sem:<thread>:log`, and the sweep
  // finds threads by `mem:` keys, so a log written today is not swept either. Kept here because the
  // upgrade contract says retention leaves nothing behind, and this fixture is where it shows.
  it('the retention sweep removes a 0.9.0 SemanticMemory log older than the window', async () => {
    const f = await openFixture('memory.db');
    const r = await sweepThreads(toJournal(f.storage.runs), { olderThanMs: 90 * 86_400_000, now: Date.UTC(2026, 9, 1) });
    expect(r.purged).toContain(M.semanticOldThread);
    expect(rowsContaining(f.path, 'old semantic message')).toEqual([]);
  });

  /** Erases u1 in the root and in the organization; returns the rows still holding u1's text, and what the erasure reported. */
  async function eraseU1() {
    const f = await openFixture('memory.db');
    const root = await eraseSubject(f.storage, 'u1');
    const org = await eraseSubject(f.storage, 'u1', { orgId: M.orgId });
    const unreached = [...root.unreachedThreads, ...org.unreachedThreads];
    const left = rowsContaining(f.path, S.U1_MARK);
    return { f, left, unreached, unreported: left.filter((row) => !unreached.some((t) => row.includes(t))) };
  }

  it('erasing u1 leaves nothing of u1 the report does not name (root threads, organization thread, working memory, observations, BasicMemory), and keeps u2', async () => {
    const { f, unreported } = await eraseU1();
    expect(unreported.filter((r) => !r.includes(mark('ORGPREFIX')))).toEqual([]);
    expect(rowsContaining(f.path, 'U2-KEEP').length).toBeGreaterThan(0);
  });

  it('erasing u1 removes the 0.9.0 root threads named `org:…` too, or reports them in unreachedThreads', async () => {
    const { left, unreached } = await eraseU1();
    const unreported = M.orgPrefixedRootThreads.filter((id) => left.some((r) => r.includes(`in ${id}`)) && !unreached.includes(id));
    expect(unreported, `left behind and not reported: ${JSON.stringify(left)}; unreachedThreads: ${JSON.stringify(unreached)}`).toEqual([]);
  });

  // Not specific to 0.9.0 data either (see the sweep above): the erasure finds journal-kept threads by
  // `mem:` keys, so it names SemanticMemory's thread in unreachedThreads instead of erasing its log.
  it("erasing u1 removes SemanticMemory's journal log, not only reports it", async () => {
    const { left } = await eraseU1();
    expect(left.filter((r) => r.includes(mark('SEM')))).toEqual([]);
  });
});
