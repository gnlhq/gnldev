// AUDIT A4 (cross-process part) — two real scheduler processes on one real Postgres.
//   freeze: A fires, is SIGSTOPped inside the workflow, its lock TTL passes, B polls, A is SIGCONTed.
//   skew:   A fires and is working; B starts with its wall clock +10 s and polls.
// Each with and without the store's process liveness bound at start (createGnl's executor binds it;
// a bare createScheduler + custom runner does not, until a durable primitive first runs).
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_URL, scopeUrl } from '../../../durable/test/_v/backends.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const tsxLoader = join(dirname(createRequire(import.meta.url).resolve('tsx/package.json')), 'dist', 'loader.mjs');
const PG_URL = BASE_URL!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ends: Array<() => Promise<unknown> | unknown> = [];
afterAll(async () => { for (const e of ends.reverse()) await e(); });
// One shared database: a test's processes must be gone before the next test's trigger is due.
const live: ChildProcess[] = [];
afterEach(async () => { for (const p of live.splice(0)) { try { p.kill('SIGCONT'); p.kill('SIGKILL'); } catch { /* gone */ } } await sleep(300); });

async function freshDb(): Promise<string> { return scopeUrl('two_processes', { isolate: true }); }
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
function proc(cfg: object): ChildProcess {
  const p = spawn(process.execPath, ['--import', tsxLoader, join(here, 'fixtures', 'sch-proc.ts'), JSON.stringify(cfg)], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  p.stderr!.on('data', (d) => { err += String(d); });
  live.push(p);
  (p as any).err = () => err;
  return p;
}
const lines = (log: string) => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
async function waitFor(log: string, pred: (l: string) => boolean, ms = 20_000) {
  for (let i = 0; i < ms / 50; i++) { if (lines(log).some(pred)) return; await sleep(50); }
  throw new Error(`timeout waiting in ${log}: ${lines(log).join(' | ')}`);
}
const count = (ls: string[], kind: string, runId: string) => ls.filter((l) => l.startsWith(`${kind} `) && l.endsWith(runId) || (kind === 'end' && l.startsWith('end ') && l.includes(runId))).length;

describe.skipIf(!PG_URL)('k3 R4 A4 two processes', () => {
  for (const bindLiveness of [false, true]) {
    it(`freeze (SIGSTOP past lock TTL) — liveness bound at start: ${bindLiveness}`, async () => {
      const url = await freshDb();
      const fz = 'fz' + uid();
      const log = join(mkdtempSync(join(tmpdir(), 'a4f-')), 'log');
      const base = { url, offsetMs: 0, bindLiveness, lockTtlMs: 1000, log, lifeMs: 40_000 };
      const A = proc({ ...base, tag: 'A', preludeMs: 3000, schedule: { id: fz, atInMs: 300 } });
      await waitFor(log, (l) => l === `start A sched:${fz}:0`);
      A.kill('SIGSTOP');
      const B = proc({ ...base, tag: 'B', preludeMs: 300 });
      await sleep(6000); // > 4 lock TTLs while A is frozen; B polls every 100 ms
      A.kill('SIGCONT');
      await sleep(6000);
      const ls = lines(log);
      const r = { starts: count(ls, 'start', `sched:${fz}:0`), effects: count(ls, 'effect', `sched:${fz}:0`) };
      console.log(`[k3 R4] freeze bind=${bindLiveness}: starts=${r.starts} effects=${r.effects}\n  ${ls.join('\n  ')}\n  A.err=${(A as any).err().slice(0, 400)} B.err=${(B as any).err().slice(0, 400)}`);
      expect(r.effects).toBe(1);
    }, 60_000);

    it(`skew (B clock +10 s, lock TTL 2 s) — liveness bound at start: ${bindLiveness}`, async () => {
      const url = await freshDb();
      const sk = 'sk' + uid();
      const log = join(mkdtempSync(join(tmpdir(), 'a4s-')), 'log');
      const base = { url, bindLiveness, lockTtlMs: 2000, log, lifeMs: 40_000 };
      proc({ ...base, tag: 'A', offsetMs: 0, preludeMs: 5000, schedule: { id: sk, atInMs: 300 } });
      await waitFor(log, (l) => l === `start A sched:${sk}:0`);
      proc({ ...base, tag: 'B', offsetMs: 10_000, preludeMs: 300 });
      await sleep(9000);
      const ls = lines(log);
      const r = { starts: count(ls, 'start', `sched:${sk}:0`), effects: count(ls, 'effect', `sched:${sk}:0`) };
      console.log(`[k3 R4] skew bind=${bindLiveness}: starts=${r.starts} effects=${r.effects}\n  ${ls.join('\n  ')}`);
      expect(r.effects).toBe(1);
      expect(r.starts).toBe(1); // the clock is the store's: a skewed B does not start the run again
    }, 60_000);
  }
});
