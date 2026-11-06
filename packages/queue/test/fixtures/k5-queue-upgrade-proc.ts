// One process running the queue's upgrade step (`queueUpgrade`) on a store, killed by the test half-way
// (k5-queue-upgrade.test.ts). Prints `m` after each job it has moved, and waits a moment, so the kill
// lands between two moves of a store of any speed.
import type { Storage } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { queueUpgrade } from '../../src/index.js';

const [kind, target] = process.argv.slice(2) as [string, string];
const storage: Storage =
  kind === 'postgres' ? new (await import('@gnldev/durable/postgres')).PostgresStorage({ connectionString: target }) as unknown as Storage
  : kind === 'mysql' ? new (await import('@gnldev/durable/mysql')).MysqlStorage({ connectionString: target }) as unknown as Storage
  : kind === 'mongo' ? new (await import('@gnldev/durable/mongo')).MongoStorage({ connectionString: target }) as unknown as Storage
  : new SqliteStorage(target) as unknown as Storage;
await (storage as { init?: () => Promise<void> }).init?.();
const work = storage.work as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
for (const m of ['append', 'appendReady']) {
  const f = work[m]!.bind(work);
  work[m] = async (...a: unknown[]) => {
    const r = await f(...a);
    if (a[0] !== 'qjob' && !String(a[0]).endsWith('qdepth')) { process.stdout.write('m'); await new Promise((res) => setTimeout(res, 5)); }
    return r;
  };
}
const step = [queueUpgrade(storage)].flat()[0]!;
await step.run();
process.exit(0);
