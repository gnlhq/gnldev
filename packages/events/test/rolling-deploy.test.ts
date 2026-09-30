// A rolling deploy: a 0.9 process keeps emitting into the log this version's consumer reads.
//
// INVARIANT: an event is delivered whichever version emitted it. The consumer persists
// `evtcursor:<topic>:<name>` as "every event before here is delivered"; an event sorted behind it is
// never delivered. Measured on the first cut of the sequenced cursor (review panel, round 2): events
// appended by 0.9.0's INSERT (no `seq`, so the default 0) sorted ahead of every sequenced event.
//
// The 0.9 producer is this version's `emit` over a WorkStore whose `append` is 0.9.0's exact
// statement on its own connection (the record shape `emit` writes did not change between versions).
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { serialize, type Storage, type WorkStore } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { emit, createConsumer } from '../src/index.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => any };
const OLD_APPEND = 'INSERT INTO gnl_work_log (ns, id, payload, ts) VALUES (?, ?, ?, ?) ON CONFLICT(ns, id) DO NOTHING';

const cleanups: Array<() => void> = [];
afterAll(() => { for (const c of cleanups.splice(0)) c(); });

function shared() {
  const dir = mkdtempSync(join(tmpdir(), 'gnl-ev-rolling-'));
  const file = join(dir, 'shared.db');
  const storage = new SqliteStorage(file) as unknown as Storage;
  const db = new DatabaseSync(file);
  cleanups.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const old09: WorkStore = Object.assign(Object.create(storage.work!), {
    async append(ns: string, payload: unknown, id?: string) {
      const eid = id ?? `${ns}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      db.prepare(OLD_APPEND).run(ns, eid, serialize(payload), Date.now());
      return eid;
    },
  });
  const got: string[] = [];
  const consumer = () => createConsumer(storage.work!, 'tp', async (p: any) => { got.push(p.n); }, { name: 'c' });
  return { storage, old09, got, consumer };
}

describe('events — a 0.9 producer and this version\'s consumer on one SQLite file', () => {
  it('events a 0.9 process emits after the consumer persisted its cursor are delivered', async () => {
    const { storage, old09, got, consumer } = shared();
    const c = consumer();
    for (let i = 0; i < 60; i++) await emit(storage.work!, 'tp', { n: `new${i}` });
    await c.poll();
    expect(await storage.work!.get('evtcursor:tp:c')).toBeTruthy();
    for (let i = 0; i < 3; i++) await emit(old09, 'tp', { n: `old${i}` });
    await c.poll();
    await c.poll();
    expect(got.filter((x) => x.startsWith('old'))).toEqual(['old0', 'old1', 'old2']);
    expect(got).toHaveLength(63);
  });

  it('SIBLING — a restarted consumer (same name) delivers them from the persisted cursor', async () => {
    const { storage, old09, got, consumer } = shared();
    for (let i = 0; i < 60; i++) await emit(storage.work!, 'tp', { n: `new${i}` });
    await consumer().poll();
    for (let i = 0; i < 3; i++) await emit(old09, 'tp', { n: `old${i}` });
    const again = consumer();
    await again.poll();
    await again.poll();
    expect(got.filter((x) => x.startsWith('old'))).toEqual(['old0', 'old1', 'old2']);
  });
});
