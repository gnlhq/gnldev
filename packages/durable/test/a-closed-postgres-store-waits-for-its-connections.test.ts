// `PostgresStorage.close()` resolves once its pool's connections have ENDED, not once they were asked to.
//
// pg-pool's `end()` resolves when it has asked its idle clients to end (`_remove` → `client.end()`, not
// awaited). Measured under load (framework-s0/ci-0171-flake): 101 of 300 `await pool.end()` still
// found the pool's backends on the server, and the queue's a-closed-store-holds-no-connection test read
// "1 connection left" on CI. A fake pool here reproduces the order deterministically: its client ends
// only when the test says so.
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { PostgresStorage } from '../src/postgres-storage.js';

/** A pool whose one client's goodbye is answered when `answer()` is called (or never). */
function fakePool() {
  const pool = new EventEmitter() as EventEmitter & Record<string, any>;
  const client = new EventEmitter() as EventEmitter & Record<string, any>;
  let destroyed = false;
  client.connection = { stream: { destroy: () => { destroyed = true; client.emit('end'); } } };
  pool.query = async () => ({ rows: [], rowCount: 0 });
  // Like pg-pool: resolves at once, the client's own end comes later.
  pool.end = async () => {};
  return { pool, client, answer: () => client.emit('end'), destroyed: () => destroyed };
}

describe('PostgresStorage.close() and its pool connections', () => {
  it('waits for a connection to end after the pool resolved its end()', async () => {
    const f = fakePool();
    const storage = new PostgresStorage({ pool: f.pool as any });
    f.pool.emit('connect', f.client);
    let closed = false;
    const closing = storage.close().then(() => { closed = true; });
    await new Promise((r) => setTimeout(r, 50));
    expect(closed, 'not closed while its connection is still open').toBe(false);
    f.answer();
    await closing;
    expect(closed).toBe(true);
    expect(f.destroyed(), 'an answered goodbye is not destroyed').toBe(false);
  });

  it('a connection already ended is not waited for', async () => {
    const f = fakePool();
    const storage = new PostgresStorage({ pool: f.pool as any });
    f.pool.emit('connect', f.client);
    f.answer();
    const t0 = Date.now();
    await storage.close();
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it('a goodbye never answered (a server gone silent) is destroyed after the wait, close() does not hang', async () => {
    const f = fakePool();
    const storage = new PostgresStorage({ pool: f.pool as any });
    f.pool.emit('connect', f.client);
    const t0 = Date.now();
    await storage.close();
    expect(f.destroyed()).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(4_900);
  }, 15_000);
});
