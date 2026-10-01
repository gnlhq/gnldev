// An organization's thread carries the organization's owner record from the moment it exists, WHOEVER
// wrote it. The record is what tells it apart from a thread 0.9 let the root create under the same
// physical id (`findReservedRootThreads`, the root's `eraseSubject`).
//
// It used to be written by `AgentMemory` alone. A thread created through the organization's memory
// port by anything else — a host writing the store directly, an import, a migration — had no record:
// listed as undecided, and the root's erasure of a person with the same user id reported it as theirs
// (measured on in-memory, SQLite and Postgres). The record is now written where every writer passes:
// `withOrgStorage(...).memory.upsertThread`.
import { describe, it, expect, afterAll } from 'vitest';
import { InMemoryStorage, withOrgStorage, findReservedRootThreads, eraseSubject, threadOwnerKey, toJournal, type Storage } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { AgentMemory } from '../../memory/src/index.js';

const ends: Array<() => Promise<unknown>> = [];
afterAll(async () => { for (const e of ends.reverse()) await e(); });
const PG_URL = process.env.GNL_PG_URL;
const STORES: Array<[string, () => Promise<Storage>]> = [
  ['in-memory', async () => new InMemoryStorage()],
  ['sqlite', async () => new SqliteStorage(':memory:')],
];
// Postgres: real only — pg-mem has no advisory locks, so its memory store refuses to append.
if (PG_URL) {
  STORES.push(['postgres (real)', async () => {
    const pg = (await import('pg')).default;
    const admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    const db = `org_owner_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    await admin.query(`CREATE DATABASE ${db}`);
    const url = new URL(PG_URL); url.pathname = `/${db}`;
    const s = new PostgresStorage({ connectionString: url.toString() }); await s.init();
    ends.push(async () => { await s.close(); await admin.query(`DROP DATABASE IF EXISTS ${db}`); await admin.end(); });
    return s;
  }]);
}
const E = [1, 0, 0];
const embed = async () => E;

async function writeThroughPort(s: Storage, org: string, id: string, resourceId: string, text: string): Promise<void> {
  const mem = withOrgStorage(s, org).memory!;
  await mem.upsertThread({ id, resourceId, createdAt: 1, updatedAt: 1, title: text });
  await mem.appendMessages(id, [{ threadId: id, role: 'user', text, message: { role: 'user', content: text }, embedding: E, ts: 1 } as never]);
}

describe.each(STORES)("an organization's thread and its owner record — %s", (_name, make) => {
  it('a thread written through the organization\'s memory port is the organization\'s: not undecided, not the root person\'s on erasure', async () => {
    const s = await make();
    await writeThroughPort(s, 'acme', 'via-port', 'u1', 'ACME-PORT');
    expect(await toJournal(s.runs).get(`org:acme:${threadOwnerKey('via-port')}`)).toMatchObject({ resourceId: 'u1', created: true });
    expect(await findReservedRootThreads(s)).toEqual([]);
    const report = await eraseSubject(s, 'u1');
    expect((report as { unreachedThreads?: string[] }).unreachedThreads ?? []).not.toContain('org:acme:via-port');
    // The organization's thread is untouched by the ROOT's erasure.
    expect((await withOrgStorage(s, 'acme').memory!.getMessages('via-port', { limit: 10 })).items.map((m) => m.text)).toEqual(['ACME-PORT']);
  });

  it('SIBLING — AgentMemory on the organization still gets the record (now from the port it writes through), for a created and a cloned thread', async () => {
    const s = await make();
    const m = new AgentMemory({ storage: withOrgStorage(s, 'acme'), embed, recentN: 5 });
    await m.createThread({ id: 'fresh', resourceId: 'u1' });
    await m.append('fresh', [{ role: 'user', content: 'ACME' }]);
    await m.cloneThread('fresh', { newThreadId: 'copy' });
    const j = toJournal(s.runs);
    expect(await j.get(`org:acme:${threadOwnerKey('fresh')}`)).toMatchObject({ resourceId: 'u1', created: true });
    expect(await j.get(`org:acme:${threadOwnerKey('copy')}`)).toMatchObject({ resourceId: 'u1', created: true });
    expect(await findReservedRootThreads(s)).toEqual([]);
  });

  it('SIBLING — the record is first-write-wins: a later upsert naming another user does not move the thread', async () => {
    const s = await make();
    await writeThroughPort(s, 'acme', 't', 'u1', 'FIRST');
    await withOrgStorage(s, 'acme').memory!.upsertThread({ id: 't', resourceId: 'u2', createdAt: 1, updatedAt: 2 });
    expect(await toJournal(s.runs).get(`org:acme:${threadOwnerKey('t')}`)).toMatchObject({ resourceId: 'u1' });
  });

  it('SIBLING — the ROOT memory port writes no record (unchanged: the root decides at its first run)', async () => {
    const s = await make();
    await s.memory!.upsertThread({ id: 'root-t', resourceId: 'u1', createdAt: 1, updatedAt: 1 });
    expect(await toJournal(s.runs).get(threadOwnerKey('root-t'))).toBeUndefined();
  });
});
