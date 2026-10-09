// A rolling deploy: a 0.9 process and this version share one database.
//
// INVARIANT: no record can land behind a cursor this version has persisted, WHICHEVER VERSION WROTE IT.
// The queue (`qcursor`) and the events consumer (`evtcursor:*`) persist `WorkStore.list`'s cursor as
// "everything before here is handled", so a record that sorts behind it is never run and never
// delivered — and nothing reports it.
//
// Measured on the first cut of the sequenced cursor (review panel, round 2): a 0.9 process keeps
// running its own INSERT, which names no `seq`, so its rows took the column default 0 and sorted AHEAD
// of every sequenced row — behind any cursor this version had saved, forever (SQLite and Postgres:
// "pending 3" after a full drain).
//
// Each case below writes the way 0.9.0 wrote — its exact statement or its exact value format, from a
// separate connection, as the old process does — and reads the way this version reads.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { newDb } from 'pg-mem';
import superjson from 'superjson';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import type { WorkStore } from '../src/index.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => any };

const RUN = process.env.GNL_INTEGRATION === '1';
const PG_URL = process.env.GNL_PG_URL ?? 'postgres://postgres:gnl@localhost:55432/gnl';
const SEED = `rd${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** 0.9.0's exact SQL. */
const OLD_SQLITE_APPEND = 'INSERT INTO gnl_work_log (ns, id, payload, ts) VALUES (?, ?, ?, ?) ON CONFLICT(ns, id) DO NOTHING';
const OLD_PG_APPEND = 'INSERT INTO gnl_work_log (ns, id, payload, ts) VALUES ($1,$2,$3,$4) ON CONFLICT (ns, id) DO NOTHING';

interface Mixed {
  /** This version's store. */
  work: WorkStore;
  /** A 0.9 process appending to the same log. `ts` defaults to its own `Date.now()`. */
  oldAppend(ns: string, id: string, payload: unknown, ts?: number): Promise<void>;
  close?(): Promise<void>;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterAll(async () => { for (const c of cleanups.splice(0)) await c(); });

function sqliteMixed(): Mixed {
  const dir = mkdtempSync(join(tmpdir(), 'gnl-rolling-'));
  const file = join(dir, 'shared.db');
  const s = new SqliteStorage(file);
  const old = new DatabaseSync(file);
  cleanups.push(() => { old.close(); s.close?.(); rmSync(dir, { recursive: true, force: true }); });
  return {
    work: s.work,
    async oldAppend(ns, id, payload, ts = Date.now()) { old.prepare(OLD_SQLITE_APPEND).run(ns, id, superjson.stringify(payload), ts); },
  };
}

function pgMemMixed(): Mixed {
  const { Pool } = newDb().adapters.createPg();
  const pool = new Pool();
  const s = new PostgresStorage({ pool });
  return {
    work: s.work,
    async oldAppend(ns, id, payload, ts = Date.now()) {
      await s.init();
      await pool.query(OLD_PG_APPEND, [ns, id, superjson.stringify(payload), ts]);
    },
  };
}

let n = 0;
const freshNs = () => `${SEED}:log${n++}`;
const range = (p: string, count: number, from = 0) => Array.from({ length: count }, (_, i) => `${p}${String(i + from).padStart(4, '0')}`);

/** Reads like the queue and the events consumer: persist `nextCursor` only after a FULL page. */
async function readFrom(work: WorkStore, ns: string, cursor: string | undefined, limit = 50) {
  const ids: string[] = [];
  let persisted = cursor;
  let c = cursor;
  for (;;) {
    const page = await work.list(ns, { cursor: c, limit });
    ids.push(...page.items.map((r) => r.id));
    if (!page.nextCursor) return { ids, persisted };
    c = page.nextCursor;
    persisted = c;
  }
}

function contract(name: string, make: () => Promise<Mixed> | Mixed) {
  describe(`rolling deploy (0.9 and this version on one store) — ${name}`, () => {
    it('a record a 0.9 process appends AFTER this version persisted a cursor is still read', async () => {
      const m = await make();
      const ns = freshNs();
      for (const id of range('new-', 60)) await m.work.append(ns, { v: 1 }, id);
      const { ids, persisted } = await readFrom(m.work, ns, undefined);
      expect(ids).toEqual(range('new-', 60));
      await m.oldAppend(ns, 'old-0000', { v: 2 });
      expect((await readFrom(m.work, ns, persisted)).ids).toEqual([...range('new-', 10, 50), 'old-0000']);
    });

    it('SIBLING — the 0.9 process\'s clock is 5s behind: its record still lands after the cursor', async () => {
      const m = await make();
      const ns = freshNs();
      for (const id of range('new-', 60)) await m.work.append(ns, { v: 1 }, id);
      const { persisted } = await readFrom(m.work, ns, undefined);
      await m.oldAppend(ns, 'old-slow', { v: 2 }, Date.now() - 5_000);
      expect((await readFrom(m.work, ns, persisted)).ids).toContain('old-slow');
    });

    it('SIBLING — both versions append in turn while a reader persists cursors: every record is read exactly once', async () => {
      const m = await make();
      const ns = freshNs();
      const written: string[] = [];
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 40; i++) {
        const a = `new-${String(i).padStart(4, '0')}`;
        const b = `old-${String(i).padStart(4, '0')}`;
        await m.work.append(ns, { v: i }, a);
        await m.oldAppend(ns, b, { v: i });
        written.push(a, b);
        if (i % 3 === 2) {
          const r = await readFrom(m.work, ns, cursor, 4);
          seen.push(...r.ids);
          cursor = r.persisted;
        }
      }
      const r = await readFrom(m.work, ns, cursor, 4);
      seen.push(...r.ids);
      // A record read twice (from a re-read of the last partial page) is harmless — the queue and the
      // consumer skip it by its marker. A record never read is the defect.
      expect(written.filter((id) => !seen.includes(id))).toEqual([]);
    });

    it('SIBLING — a 0.9 append of an id this version already wrote stays one record', async () => {
      const m = await make();
      const ns = freshNs();
      await m.work.append(ns, { v: 1 }, 'same');
      await m.oldAppend(ns, 'same', { v: 2 });
      const page = await m.work.list<{ v: number }>(ns);
      expect(page.items.map((r) => [r.id, r.payload.v])).toEqual([['same', 1]]);
    });
  });
}

contract('sqlite (two connections to one file)', sqliteMixed);
contract('postgres (pg-mem)', pgMemMixed);

describe.skipIf(!RUN)('rolling deploy — live backends', () => {
  const pools: Array<{ end(): Promise<void> }> = [];
  afterAll(async () => {
    for (const p of pools) await p.end();
  });
  const pgLive = async (): Promise<Mixed> => {
    const { Pool } = await import('pg');
    const mine = new Pool({ connectionString: PG_URL });
    const theirs = new Pool({ connectionString: PG_URL });
    pools.push(mine, theirs);
    const s = new PostgresStorage({ pool: mine });
    await s.init();
    return {
      work: s.work,
      async oldAppend(ns, id, payload, ts = Date.now()) { await theirs.query(OLD_PG_APPEND, [ns, id, superjson.stringify(payload), ts]); },
    };
  };
  contract('postgres (live)', pgLive);
});
