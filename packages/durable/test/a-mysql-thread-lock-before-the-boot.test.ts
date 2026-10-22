// A MySQL store's first append to a thread takes the same lock as every later one.
//
// The thread's append lock is named from the database, which the boot reads (`SELECT DATABASE()`).
// The name was built as the transaction's argument, before the transaction waited for the boot: the
// first append of a fresh process locked `db = ''`, every other append the real name — two locks for
// one thread, so that append and another process's were not serialized. Postgres had the same shape
// of bug (a-store-just-started-reads-every-key.test.ts).
import { describe, it, expect, afterAll } from 'vitest';
import { MysqlStorage } from '../src/mysql-storage.js';
import { MYSQL_SERVERS, freshDatabase } from './real-backends.js';

const msg = (threadId: string, seq: number, text: string) =>
  ({ threadId, seq, role: 'user' as const, text, ts: seq, message: { role: 'user', content: text } });

describe.each(MYSQL_SERVERS.length ? MYSQL_SERVERS : [{ name: 'none', url: '' }])('$name: the thread lock before the boot', ({ url }) => {
  const opened: MysqlStorage[] = [];
  afterAll(async () => { for (const s of opened) await s.close().catch(() => {}); });

  it.skipIf(!url)('the first append (nothing booted yet) and the next one take the same lock name', async () => {
    const s = new MysqlStorage({ connectionString: await freshDatabase(url) });
    opened.push(s);
    // Every GET_LOCK the store asks for, in order (the boot's own lock aside).
    const locks: string[] = [];
    const pool = (s as unknown as { _pool: { getConnection(): Promise<{ query(sql: string, v?: unknown[]): Promise<unknown> }> } })._pool;
    const getConnection = pool.getConnection.bind(pool);
    pool.getConnection = async () => {
      const c = await getConnection();
      const query = c.query.bind(c);
      c.query = (sql: string, v?: unknown[]) => {
        if (/GET_LOCK/.test(sql) && typeof v?.[0] === 'string' && (v[0] as string).startsWith('gnlt_')) locks.push(v[0] as string);
        return query(sql, v);
      };
      return c;
    };
    await s.memory.appendMessages('T1', [msg('T1', 1, 'first')]);
    await s.memory.appendMessages('T1', [msg('T1', 2, 'second')]);
    expect(locks).toHaveLength(2);
    expect(locks[0]).toBe(locks[1]);
  });
});
