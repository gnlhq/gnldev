// Audit NQ1 — the two claims it was written to prove, as they stand after k2 (execution grant, decisions
// 2a and 2c). The fixture's handler does NOT check ctx.signal before its side effect, which it does
// outside ctx.run: what a handler that ignores the signal gets, by design.
//  N4: a worker that loses its job's lease (partition → another process takes the job) has its handler's
//      ctx.signal aborted (`lease-lost`); a handler that runs on is warned once, ttlMs after the loss, and
//      its side effect is NOT forbidden (2a: the framework cannot stop code that ignores the signal). The
//      handler that obeys the signal does no effect: k2-nq1-obey.test.ts (same set-up, the fixture checks
//      ctx.signal first) — what this case used to expect of this fixture.
//  N1: with no `maxHoldMs` (the default: no limit, as in events) a handler that never returns holds its
//      job; no other worker takes it. The limit is an option now (2c): an obeying handler stopped at
//      `maxHoldMs`, its attempt counted and dead-lettered at maxAttempts — k2-sib-queue.test.ts Q1. This
//      case used to also prove that no such option existed.
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
const procScript = join(here, 'fixtures', 'audit-nq1-worker-proc.ts');
const TTL = 1_000;
const PROXY_PORT = 42202;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dirs: string[] = [];
const drops: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); for (const n of drops) dropDatabaseSync(n); });

let seq = 0;
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'gnl-q-nq1-')); dirs.push(dir);
  const name = `nq1_${process.pid}_${seq++}`; drops.push(name);
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

describe.skipIf(!PG_URL)('audit NQ1 (Postgres, separate processes)', () => {
  it('N4: A loses the lease to B while its handler runs — A\'s ctx.signal aborts (lease-lost) and A, ignoring it, is warned once', async () => {
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
      aUnheededWarnings: (errA.match(/its lease was lost and the work moved to another holder, but the handler is still running/g) ?? []).length,
      aRenewTransientWarnings: (errA.match(/renew transient error/g) ?? []).length,
    };
    console.log('NQ1-N4', JSON.stringify(report, null, 1));
    expect(tookOver, 'B took the job over from A (precondition)').toBe(true);
    const effects = all.filter((l) => l.startsWith('effect'));
    expect(all.filter((l) => l.startsWith('abort A')), 'A\'s ctx.signal aborted when it lost the lease').not.toEqual([]);
    expect(all.find((l) => l.startsWith('abort A')), 'aborted as lease-lost').toMatch(/ExecutionRevokedError: .*its lease (was lost|could not be renewed)/);
    expect(report.aUnheededWarnings, 'A, still running ttlMs after the loss, was warned once').toBe(1);
    // B ran it; A's effect, outside ctx.run and after its signal aborted, is the cost 2a names, not forbidden.
    expect(effects.filter((l) => l.startsWith('effect B'))).toHaveLength(1);
    expect(effects.filter((l) => l.startsWith('effect A')).every((l) => l.endsWith('aborted=true')), 'whatever A did, it did after it was told').toBe(true);
    expect(status).toEqual(['done']);
  }, 120_000);

  it('N1: with no maxHoldMs, a handler that never returns keeps its job held; no other worker takes it — and maxHoldMs is an option', async () => {
    const st = setup();
    const s = await open(st.db);
    const id = await enqueue(s.work!, 't', {});
    const a = start(st.db, st.effects, st.go, 'A', st.dir);
    expect(await until(() => lines(st.effects).some((l) => l.startsWith('enter A')), 20_000)).toBe(true);
    const b = start(st.db, st.effects, st.go, 'B', st.dir);
    const HOLD = 15 * TTL;
    await sleep(HOLD);
    const jobs = (await listJobs(s.work!)).items;
    const report = { heldForMs: HOLD, ttlMs: TTL, lines: lines(st.effects), job: jobs.find((j) => j.id === id) };
    console.log('NQ1-N1', JSON.stringify(report, null, 1));
    writeFileSync(st.go, '');
    await Promise.race([Promise.all([a.exited, b.exited]), sleep(30_000)]);
    a.p.kill('SIGKILL'); b.p.kill('SIGKILL');
    // `timeoutMs` is not a name the worker knows (refused); `maxHoldMs` is (2c) — its stop: k2-sib-queue Q1.
    let refused = '';
    try { createWorker(s, {}, { timeoutMs: 1000 } as any); } catch (e: any) { refused = e.message; }
    let refused2 = '';
    try { createWorker(s, {}, { maxHoldMs: 1000 } as any); } catch (e: any) { refused2 = e.message; }
    console.log('NQ1-N1 options', JSON.stringify({ timeoutMs: refused, maxHoldMs: refused2 }));
    await s.close?.();
    // Evidence assertions (green = the claim holds).
    expect(report.lines.filter((l) => l.startsWith('enter B'))).toEqual([]);
    expect(report.job?.status).toBe('pending');
    expect(report.lines.filter((l) => l.startsWith('abort A'))).toEqual([]);
    expect(refused).not.toBe('');
    expect(refused2).toBe('');
  }, 120_000);
});
