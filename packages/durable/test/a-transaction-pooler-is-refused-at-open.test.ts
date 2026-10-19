// A liveness session made through a transaction-mode pooler is refused when it is opened, never served.
//
// The process lock is a session-level advisory lock (process-liveness.ts). Behind a transaction-mode
// pooler (PgBouncer `pool_mode=transaction`, a managed "-pooler" endpoint) the lock belongs to the
// SERVER connection the statement happened to run on, and that connection outlives the client and is lent
// to the next one. Measured on a managed transaction pooler (2026-10-18):
//   · a holder SIGKILLed, then 5 s and 60 s later: still read alive from a direct session — every claim and
//     run lock it held is never taken over;
//   · a second, independent client re-takes the first one's lock (`pg_try_advisory_lock` → true) on the
//     same backend pid, 10 of 10 tries — two processes "hold" one lock.
// Nothing said so: `postgresLiveness` opened, `PostgresStorage.processLiveness()` opened, runs went on.
//
// The signature is decisive: on real sessions (direct, or a session-mode pooler) a second session can never
// take a session lock the first one holds, nor report the same backend pid while both are open.
//
// Runs when GNL_PG_TXPOOL_URL names a transaction-mode pooler; the harm check also needs GNL_PG_URL, a
// direct URL to the same database.
import { describe, it, expect, afterAll } from 'vitest';
import { PostgresStorage } from '../src/postgres-storage.js';
import { postgresLiveness, type PgProcessSession } from '../src/process-liveness.js';

const POOLER = process.env.GNL_PG_TXPOOL_URL;
const DIRECT = process.env.GNL_PG_URL;
const ends: Array<() => Promise<unknown>> = [];
afterAll(async () => { for (const e of ends.reverse()) await e().catch(() => undefined); });

describe.skipIf(!POOLER)('a transaction-mode pooler', () => {
  it('postgresLiveness refuses it at open, naming the pooler', async () => {
    const opened = await postgresLiveness({ connectionString: POOLER }).then((l) => { ends.push(() => l.close()); return 'opened'; }, (e: Error) => e.message);
    expect(opened).toMatch(/transaction-mode pooler/i);
  }, 60_000);

  it("PostgresStorage refuses its process liveness on it (what a direct runDurable binds)", async () => {
    const storage = new PostgresStorage({ connectionString: POOLER });
    ends.push(() => storage.close());
    const opened = await storage.processLiveness().then(() => 'opened', (e: Error) => e.message);
    expect(opened).toMatch(/transaction-mode pooler/i);
  }, 60_000);

  it.skipIf(!DIRECT)('a holder that opened on it anyway reads dead once it has closed', async () => {
    const held: PgProcessSession | undefined = await postgresLiveness({ connectionString: POOLER }).catch(() => undefined);
    if (!held) return; // refused at open: nothing was served, nothing to judge
    const observer = await postgresLiveness({ connectionString: DIRECT });
    ends.push(() => observer.close());
    const id = held.id;
    expect(await observer.isAlive(id), 'alive while it holds').toBe(true);
    await held.close();
    await new Promise((r) => setTimeout(r, 2_000));
    expect(await observer.isAlive(id), 'a closed holder still reads alive: its lock stayed on the pooled server connection').toBe(false);
  }, 60_000);
});
