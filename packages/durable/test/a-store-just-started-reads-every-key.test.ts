// A Postgres store's FIRST call, made before anything booted it, answers as a booted store does.
//
// The boot settles what some statements are built from: the collation key ranges need (`COLLATE "C"`
// on a linguistic database) and whether the relation guards hold. A statement built before the boot was
// built without it, and on an en_US.utf8 database — the default of nearly every managed Postgres — a
// prefix range without `COLLATE "C"` matches nothing: no error, an empty answer. So a process's first
// lookup by prefix answered "none": an erasure that came first in a fresh process erased the run and
// the owner record but not the person's thread (measured: 1 in ~10 runs of the background-tool D4
// scenario, where the erasing process had just started). Each case below is one fresh store whose
// first call is the one named.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PostgresStorage } from '../src/postgres-storage.js';
import { eraseSubject } from '../src/erase.js';
import { threadOwnerKey } from '../src/thread-owner.js';
import { createRequire } from 'node:module';

const URL0 = process.env.GNL_PG_URL;
const NAME = `pgfirst_${process.pid}_${Date.now().toString(36)}`;
const require = createRequire(import.meta.url);

async function admin(sql: string) {
  const pg = require('pg');
  const c = new pg.Client({ connectionString: URL0 });
  await c.connect();
  try { await c.query(sql); } finally { await c.end(); }
}

const msg = (threadId: string, seq: number, text: string) =>
  ({ threadId, seq, role: 'user' as const, text, ts: seq, message: { role: 'user', content: text } });

describe.skipIf(!URL0)('a Postgres store just started: its first call answers as a booted one', () => {
  let url = '';
  let writer: PostgresStorage;
  const opened: PostgresStorage[] = [];
  /** A store over the same database that nothing has booted: no init, no call yet. */
  const fresh = () => { const s = new PostgresStorage({ connectionString: url }); opened.push(s); return s; };

  beforeAll(async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A linguistic collation, whatever the server's default: this is the database the bug lives on.
    await admin(`CREATE DATABASE ${NAME} ENCODING 'UTF8' LC_COLLATE 'en_US.utf8' LC_CTYPE 'en_US.utf8' TEMPLATE template0`);
    const u = new URL(URL0!); u.pathname = `/${NAME}`; url = u.toString();
    writer = new PostgresStorage({ connectionString: url });
    await writer.init();
    const j = writer.runs as any;
    for (const id of ['pfx-r1', 'pfx-r2', 'other-r3']) await j.put(`${id}:input`, { _v: 1, prompt: 'p', resourceId: 'alice' });
    await j.put('pfx-r1:ev:0001', { e: 1 });
    await j.put('pfx-r1:ev:0002', { e: 2 });
    await j.put(threadOwnerKey('T1'), { resourceId: 'alice', at: 1 });
    await writer.memory!.appendMessages('T1', [msg('T1', 1, 'hello'), msg('T1', 2, 'again')]);
    await writer.work!.append('nspfx:a', { x: 1 }, 'jobpfx-1');
    await writer.work!.append('nspfx:b', { x: 2 }, 'jobpfx-2');
  });
  afterAll(async () => {
    for (const s of [...opened, writer]) await s?.close().catch(() => {});
    await admin(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
  });

  it('the booted writer sees what it wrote (the baseline every case compares with)', async () => {
    const j = writer.runs as any;
    expect((await j.listKeys('pfx-')).length).toBe(4);
    expect(await j.countRuns({ runIdPrefix: 'pfx-' })).toBe(2);
  });

  it('listKeys', async () => {
    expect(await (fresh().runs as any).listKeys('pfx-r1:')).toEqual(await (writer.runs as any).listKeys('pfx-r1:'));
  });

  it('readRange', async () => {
    expect((await (fresh().runs as any).readRange('pfx-r1:ev:', { limit: 10 })).length).toBe(2);
  });

  it('listOwnerRecords', async () => {
    expect(await (fresh().runs as any).listOwnerRecords('alice', { prefix: 'thread:' })).toEqual([threadOwnerKey('T1')]);
  });

  it('countRuns by id prefix', async () => {
    expect(await (fresh().runs as any).countRuns({ runIdPrefix: 'pfx-' })).toBe(2);
  });

  it('listRuns by id prefix', async () => {
    const page = await (fresh().runs as any).listRuns({ runIdPrefix: 'pfx-', limit: 10 });
    expect(page.items.map((r: { runId: string }) => r.runId).sort()).toEqual(['pfx-r1', 'pfx-r2']);
  });

  it('listRunsChangedSince by id prefix', async () => {
    const page = await (fresh().runs as any).listRunsChangedSince(undefined, { runIdPrefix: 'pfx-' });
    expect(page.items.map((r: { runId: string }) => r.runId).sort()).toEqual(['pfx-r1', 'pfx-r2']);
  });

  it('the work store: deleteIdPrefix, then deletePrefix', async () => {
    expect(await fresh().work!.deleteIdPrefix!('jobpfx-1')).toBe(1);
    expect(await fresh().work!.deletePrefix!('nspfx:')).toBe(1);
  });

  it('deletePrefix on the journal, inside a run (a key range, not a run id)', async () => {
    expect(await (fresh().runs as any).deletePrefix('pfx-r1:ev:')).toBe(2);
    expect(await (writer.runs as any).get('pfx-r1:ev:0001')).toBeUndefined();
  });

  it('eraseSubject as the first thing a process does: the person\'s thread goes', async () => {
    await eraseSubject(fresh(), 'alice');
    expect((await writer.memory!.getMessages('T1')).items).toEqual([]);
    expect(await (writer.runs as any).get(threadOwnerKey('T1'))).toBeUndefined();
  });
});
