// A live process whose liveness session is lost SILENTLY is never read as dead before its bodies are told.
//
// A session can end on the server while its client hears nothing: a dropped NAT entry, a failover that
// moves an address, a firewall that drops. The server frees the process's lock; the process's heartbeat
// waits on an answer that never comes. Measured before (2026-10-19, raporlar/2026-10-19-silent-loss):
// another process read the live one as dead 5.0 s after the loss in 10 of 10 rounds on Postgres (3 of 3
// on MongoDB, 1 of 1 on MySQL); the process had not got its lock back after 60 s (MongoDB: 6.4–9.8 s,
// after the others read it dead), and its bodies were never told to stop — its calls could run twice.
//
// The rule (process-liveness.ts `sessionSignals`): the clock runs from the process's last PROOF of its
// session, which the lock cannot have outlived. A heartbeat that is not answered within one heartbeat is
// a loss; the bodies are told to stop half a grace after the last proof, the others read the process as
// dead no earlier than a whole grace after it.
import { describe, it, expect, afterAll } from 'vitest';
import { judgeAlive, postgresLiveness, type ProcessLiveness } from '../src/process-liveness.js';
import { mysqlLiveness } from '../src/mysql-storage.js';
import { mongoLiveness } from '../src/mongo-storage.js';
import { silentProxy, type SilentProxy } from './fixtures/silent-proxy.js';
import { MYSQL_SERVERS, MONGO_URL, freshDatabase, freshMongoDatabase } from './real-backends.js';

const PG_URL = process.env.GNL_PG_URL;
const stores: Array<[string, () => Promise<string>, (url: string) => Promise<ProcessLiveness>]> = [
  ...(PG_URL ? [['Postgres', async () => PG_URL, (url: string) => postgresLiveness({ connectionString: url })] as const] : []),
  ...MYSQL_SERVERS.map(({ name, url }) => [name, () => freshDatabase(url), (u: string) => mysqlLiveness({ connectionString: u })] as const),
  ...(MONGO_URL ? [['MongoDB', async () => freshMongoDatabase(), (url: string) => mongoLiveness({ connectionString: url })] as const] : []),
] as never;

const ends: Array<() => Promise<unknown> | void> = [];
afterAll(async () => { for (const e of ends.reverse()) await e()?.catch?.(() => undefined); });

/** Watches for `ms`: when B first reads A as dead (judgeAlive), and when A's session signal aborts. */
async function watch(a: ProcessLiveness, b: ProcessLiveness, ms: number) {
  const t0 = performance.now();
  let readDeadAt: number | undefined;
  let abortAt: number | undefined;
  const sig = a.sessionSignal!();
  sig.addEventListener('abort', () => { abortAt = performance.now() - t0; });
  while (performance.now() - t0 < ms && readDeadAt === undefined) {
    if ((await judgeAlive(b, a.id).catch(() => undefined)) === false) readDeadAt = performance.now() - t0;
    await new Promise((r) => setTimeout(r, 50));
  }
  return { readDeadAt, abortAt };
}

async function pair(make: () => Promise<string>, open: (url: string) => Promise<ProcessLiveness>) {
  const url = await make();
  const proxy: SilentProxy = await silentProxy(url);
  const a = await open(proxy.url);
  ends.push(() => a.close());
  const b = await open(url);
  ends.push(() => b.close());
  ends.push(() => proxy.close()); // first: a close on a mute session must not wait on it
  return { a, b, proxy };
}

describe.skipIf(stores.length > 0)('a liveness session lost silently', () => {
  it.skip('runs with GNL_PG_URL, GNL_MYSQL_URL or GNL_MONGO_URL', () => undefined);
});

for (const [name, make, open] of stores) {
  describe(`${name}: a liveness session lost silently`, () => {
    it('the process takes its lock back, and no one reads it as dead meanwhile', async () => {
      const { a, b, proxy } = await pair(make, open);
      await new Promise((r) => setTimeout(r, Math.random() * 1_000));
      proxy.cutSilently();
      const { readDeadAt } = await watch(a, b, 9_000);
      expect(readDeadAt, 'a live process read as dead (ms after the loss)').toBeUndefined();
      expect(await a.confirm(0), 'its session is back').toBe(true);
    }, 30_000);

    it('sibling: it cannot come back — its bodies are told to stop before anyone reads it as dead', async () => {
      const { a, b, proxy } = await pair(make, open);
      proxy.refuseNew = true;
      await new Promise((r) => setTimeout(r, Math.random() * 1_000));
      proxy.cutSilently();
      const { readDeadAt, abortAt } = await watch(a, b, 20_000);
      expect(abortAt, 'its bodies were told to stop').toBeDefined();
      expect(readDeadAt, 'it is read as dead in the end').toBeDefined();
      expect(abortAt!, 'told before it was read as dead').toBeLessThan(readDeadAt!);
    }, 40_000);
  });
}
