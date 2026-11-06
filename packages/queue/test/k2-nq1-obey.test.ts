// Audit NQ1 — evidence for two claims (no fix here):
//  N4: when a worker loses its job's lease (partition → another process takes the job), the handler's
//      ctx.signal is NOT aborted; the old worker keeps doing its side effect → the effect runs twice.
//  N1: a handler that never returns holds its job forever (the heartbeat keeps the lease); there is no
//      job timeout option.
// Separate OS processes on one Postgres database. Worker A reaches Postgres through a TCP proxy in this
// test process; "partition" = the proxy drops every A connection and refuses new ones, while A's
// process itself keeps running (unlike SIGSTOP, A's handler can observe ctx.signal).
import { describe, it, expect, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, createWriteStream } from 'node:fs';
import { createServer, connect, type Socket, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type { Storage } from '@gnldev/durable';
import { createDatabaseSync, dropDatabaseSync } from '../../../test/support/pg-admin.js';
import { enqueue, listJobs, createWorker } from '../src/index.js';

const PG_URL = process.env.GNL_PG_URL;
const here = dirname(fileURLToPath(import.meta.url));
const tsxLoader = join(dirname(createRequire(import.meta.url).resolve('tsx/package.json')), 'dist', 'loader.mjs');
const procScript = join(here, 'fixtures', 'k2-nq1-obey-worker-proc.ts');
const TTL = 1_000;
const PROXY_PORT = 42212;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dirs: string[] = [];
const drops: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); for (const n of drops) dropDatabaseSync(n); });

let seq = 0;
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'gnl-q-nq1-')); dirs.push(dir);
  const name = `k2nq1o_${process.pid}_${seq++}`; drops.push(name);
  return { dir, db: createDatabaseSync(name), effects: join(dir, 'effects.txt'), go: join(dir, 'go') };
}
async function open(db: string): Promise<Storage> {
  const s = new (await import('@gnldev/durable/postgres')).PostgresStorage({ connectionString: db }) as unknown as Storage;
  await s.init?.(); return s;
}
function start(db: string, effects: string, go: string, name: string, dir: string): { p: ChildProcess; exited: Promise<number | null> } {
  const p = spawn(process.execPath, ['--import', tsxLoader, procScript, db, effects, go, name, String(TTL), String(process.pid)], { stdio: ['ignore', 'ignore', 'pipe'] });
  p.stderr!.pipe(createWriteStream(join(dir, `stderr-${name}.txt`)));
  return { p, exited: new Promise((r) => p.on('close', (c) => r(c))) };
}
const lines = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : []);
async function until(cond: () => boolean, ms: number) { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await sleep(20); } return cond(); }

/** A TCP proxy to the Postgres server that can be partitioned (drop + refuse) and healed. */
function proxy(target: URL): { server: Server; partition(): void; heal(): void; url(db: string): string } {
  let cut = false;
  const pairs = new Set<[Socket, Socket]>();
  const server = createServer((c) => {
    if (cut) { c.destroy(); return; }
    const u = connect(Number(target.port || 5432), target.hostname);
    const pair: [Socket, Socket] = [c, u]; pairs.add(pair);
    const end = () => { c.destroy(); u.destroy(); pairs.delete(pair); };
    c.on('error', end); u.on('error', end); c.on('close', end); u.on('close', end);
    c.pipe(u); u.pipe(c);
  }).listen(PROXY_PORT, '127.0.0.1');
  return {
    server,
    partition() { cut = true; for (const [a, b] of pairs) { a.destroy(); b.destroy(); } pairs.clear(); },
    heal() { cut = false; },
    url(db: string) { const u = new URL(db); u.hostname = '127.0.0.1'; u.port = String(PROXY_PORT); return u.toString(); },
  };
}

describe.skipIf(!PG_URL)('K2 NQ1-obey (handler checks ctx.signal before its effect) (Postgres, separate processes)', () => {
  it('N4: A loses the lease to B while its handler runs — A\'s ctx.signal must abort and A must not do the effect', async () => {
    const st = setup();
    const px = proxy(new URL(PG_URL!));
    const s = await open(st.db);
    await enqueue(s.work!, 't', {});
    await s.close?.();
    const a = start(px.url(st.db), st.effects, st.go, 'A', st.dir);
    expect(await until(() => lines(st.effects).some((l) => l.startsWith('enter A')), 20_000), 'A took the job').toBe(true);
    const tCut = Date.now();
    px.partition();
    const b = start(st.db, st.effects, st.go, 'B', st.dir);
    const tookOver = await until(() => lines(st.effects).some((l) => l.startsWith('enter B')), 30_000);
    const takeoverMs = Date.now() - tCut;
    px.heal();
    await sleep(3 * TTL); // several heartbeat ticks for A after the heal: its renew now answers (token mismatch)
    writeFileSync(st.go, '');
    await Promise.race([Promise.all([a.exited, b.exited]), sleep(60_000)]);
    a.p.kill('SIGKILL'); b.p.kill('SIGKILL');
    px.server.close();
    const s2 = await open(st.db);
    const status = (await listJobs(s2.work!)).items.map((j) => j.status);
    const lateA = await s2.work!.get(`qlate:${(await listJobs(s2.work!)).items[0]!.id}`);
    await s2.close?.();
    const all = lines(st.effects);
    const errA = existsSync(join(st.dir, 'stderr-A.txt')) ? readFileSync(join(st.dir, 'stderr-A.txt'), 'utf8') : '';
    const report = {
      takeoverMs, tookOver, lines: all, status, qlateWrittenByA: lateA !== undefined,
      aWarnedLockLost: /assuming lockLost=true/.test(errA),
      aRenewTransientWarnings: (errA.match(/renew transient error/g) ?? []).length,
    };
    console.log('NQ1-N4', JSON.stringify(report, null, 1));
    expect(tookOver, 'B took the job over from A (precondition)').toBe(true);
    const effects = all.filter((l) => l.startsWith('effect'));
    expect(all.filter((l) => l.startsWith('abort A')), 'A\'s ctx.signal aborted when it lost the lease').not.toEqual([]);
    expect(effects.filter((l) => l.startsWith('effect A')), 'A did no side effect after losing the job').toEqual([]);
    expect(effects).toHaveLength(1);
  }, 120_000);

});
