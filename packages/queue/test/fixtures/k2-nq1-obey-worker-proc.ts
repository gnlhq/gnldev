// Audit NQ1 (N4/N1): one queue worker in its own OS process. The handler writes `enter <name>`, logs
// `abort <name>` the moment ctx.signal aborts, waits until the `go` file exists, then writes
// `effect <name> aborted=<ctx.signal.aborted>` — the side effect, outside ctx.run.
import { appendFileSync, existsSync } from 'node:fs';
import type { Storage } from '@gnldev/durable';
import { createWorker, listJobs } from '../../src/index.js';

const [db, effects, go, name, ttl, runner] = process.argv.slice(2) as [string, string, string, string, string, string];
setInterval(() => { try { process.kill(Number(runner), 0); } catch { process.exit(1); } }, 500).unref();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const storage: Storage = new (await import('@gnldev/durable/postgres')).PostgresStorage({ connectionString: db }) as unknown as Storage;
(storage as any).pool?.on?.('error', () => {});
await storage.init?.();
const t0 = Date.now();
const worker = createWorker(storage, {
  t: async (_p: unknown, ctx: { jobId: string; signal: AbortSignal }) => {
    appendFileSync(effects, `enter ${name} t=${Date.now() - t0}\n`);
    ctx.signal.addEventListener('abort', () => appendFileSync(effects, `abort ${name} ${String(ctx.signal.reason)}\n`));
    while (!existsSync(go)) await sleep(10);
    if (!ctx.signal.aborted) appendFileSync(effects, `effect ${name} aborted=${ctx.signal.aborted}\n`);
  },
}, { owner: name, ttlMs: Number(ttl), pollMs: 20, backoff: false });

const allDone = async () => (await listJobs(storage.work!)).items.every((j) => j.status !== 'pending' && j.status !== 'in-doubt');
worker.start();
const deadline = Date.now() + 90_000;
while (Date.now() < deadline) {
  try { if (await allDone()) break; } catch { /* cut session: pool reconnects */ }
  await sleep(50);
}
worker.stop();
await storage.close?.().catch(() => undefined);
process.exit(0);
