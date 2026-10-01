// A deleted thread keeps no one's words. `deleteThread` is a soft delete of the thread record (its
// messages go), and the record kept its `title` — `AgentMemory` titles an implicit thread with the
// person's first message — and `metadata`. Measured on the 0.9.0 memory fixture: after both erasures of
// u1, `gnl_threads[org:acme:t-run].title` still held u1's first message.
import { describe, it, expect } from 'vitest';
import { newDb } from 'pg-mem';
import { InMemoryStorage, type Storage } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';

type Raw = (id: string) => Promise<Record<string, unknown> | undefined>;
const engines: Array<[string, () => Promise<{ s: Storage; raw: Raw }>]> = [
  ['InMemoryStorage', async () => {
    const s = new InMemoryStorage();
    return { s, raw: async (id) => (s.memory as unknown as { threads: Map<string, Record<string, unknown>> }).threads.get(id) };
  }],
  ['SqliteStorage', async () => {
    const s = new SqliteStorage(':memory:');
    return { s: s as unknown as Storage, raw: async (id) => (s as unknown as { db: { prepare(q: string): { get(...a: unknown[]): Record<string, unknown> | undefined } } }).db.prepare('SELECT * FROM gnl_threads WHERE id = ?').get(id) };
  }],
  ['PostgresStorage (pg-mem)', async () => {
    const { Pool } = newDb().adapters.createPg();
    const pool = new Pool();
    const s = new PostgresStorage({ pool } as never);
    await (s as unknown as { init?: () => Promise<void> }).init?.();
    return { s: s as unknown as Storage, raw: async (id) => (await pool.query('SELECT * FROM gnl_threads WHERE id = $1', [id])).rows[0] };
  }],
];

describe.each(engines)('deleteThread leaves no title or metadata behind (%s)', (_n, make) => {
  it('the record a soft delete keeps names nothing the person wrote', async () => {
    const { s, raw } = await make();
    await s.memory!.upsertThread({ id: 't1', resourceId: 'u1', title: 'SECRET first message', metadata: { note: 'SECRET' }, createdAt: 1, updatedAt: 1 });
    await s.memory!.deleteThread('t1');
    expect(await s.memory!.getThread('t1')).toBeUndefined();
    expect(JSON.stringify(await raw('t1') ?? {})).not.toContain('SECRET');
  });
});
