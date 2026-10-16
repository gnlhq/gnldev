// MEASUREMENT (runs only with NP_MEASURE=1): a queue job's effect when the worker holding it is frozen
// and — on Postgres — every session it holds is terminated (what the server does to a partitioned host).
//
// Worker A takes the job and enters the handler; A is frozen (SIGSTOP); its sessions are cut; worker B
// starts. Then the `go` file is written and A is resumed (SIGCONT). Counted from the effects file:
//   raw  — `effect` lines (what a provider that ignores a key sees)
//   keys — distinct job ids among them (what a provider that dedups on `ctx.jobId` executes)
//
//   NP_MEASURE=1 GNL_PG_URL=… NP_KIND=postgres NP_MODE=cut NP_N=20 NP_OUT=<file.jsonl> vitest run test/partition-measure.test.ts
import { describe, it } from 'vitest';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type { Storage } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { enqueue, listJobs } from '../src/index.js';

const on = process.env.NP_MEASURE === '1';
const kind = (process.env.NP_KIND ?? 'sqlite') as 'sqlite' | 'postgres';
const mode = process.env.NP_MODE ?? 'cut';
const trials = Number(process.env.NP_N ?? 20);
const out = process.env.NP_OUT;
const freezeMs = Number(process.env.NP_FREEZE_MS ?? 8000);
const TTL = 1_000;

const here = dirname(fileURLToPath(import.meta.url));
const tsxLoader = join(dirname(createRequire(import.meta.url).resolve('tsx/package.json')), 'dist', 'loader.mjs');
const procScript = join(here, 'fixtures', 'partition-worker-proc.ts');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const psql = (sql: string) => execSync(`docker exec gnl-r7-pg psql -U postgres -Atc "${sql}"`, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const lines = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : []);

function start(kind: string, db: string, effects: string, go: string, name: string): { p: ChildProcess; exited: Promise<number | null> } {
  const p = spawn(process.execPath, ['--import', tsxLoader, procScript, kind, db, effects, go, name, String(TTL), String(process.pid)], { stdio: ['ignore', 'ignore', 'pipe'] });
  const exited = new Promise<number | null>((resolve) => p.on('close', (code) => resolve(code)));
  return { p, exited };
}

describe.skipIf(!on)(`queue partition measurement: ${kind} / ${mode}`, () => {
  it(`${trials} trials`, { timeout: trials * 60_000 }, async () => {
    for (let t = 0; t < trials; t++) {
      const dir = mkdtempSync(join(tmpdir(), 'gnl-q-np-'));
      const effects = join(dir, 'effects.txt');
      const go = join(dir, 'go');
      let db = join(dir, 'q.db');
      let dbName = '';
      if (kind === 'postgres') {
        dbName = `${process.env.NP_DB_PREFIX ?? 'np'}_q_${process.pid}_${t}`;
        psql(`CREATE DATABASE ${dbName}`);
        const u = new URL(process.env.GNL_PG_URL!);
        u.pathname = `/${dbName}`;
        db = u.toString();
      }
      const tagged = (tag: string) => { if (kind !== 'postgres') return db; const u = new URL(db); u.searchParams.set('application_name', tag); return u.toString(); };
      const tagA = `np_qa_${process.pid}_${t}`;
      const procs: Array<ReturnType<typeof start>> = [];
      try {
        const s: Storage = kind === 'postgres'
          ? new (await import('@gnldev/durable/postgres')).PostgresStorage({ connectionString: db }) as unknown as Storage
          : new SqliteStorage(db) as unknown as Storage;
        await s.init?.();
        await enqueue(s.work!, 't', {});
        await s.close?.();
        if (mode === 'cascade') {
          // NP_HOPS partitions in a row: each worker that took the job is frozen and cut in its turn.
          const hops = Number(process.env.NP_HOPS ?? 6);
          const tags: string[] = [];
          const frozen = new Set<string>();
          let hopsDone = 0;
          for (let h = 0; h <= hops; h++) {
            const name = `W${h}`;
            tags.push(`np_q${h}_${process.pid}_${t}`);
            procs.push(start(kind, tagged(tags[h]!), effects, go, name));
            const until = Date.now() + 10_000;
            while (!lines(effects).some((l) => l.startsWith(`enter ${name} `)) && Date.now() < until) await sleep(20);
            if (!lines(effects).some((l) => l.startsWith(`enter ${name} `))) break;
            if (h === hops) break;
            procs[h]!.p.kill('SIGSTOP');
            frozen.add(name);
            if (kind === 'postgres') psql(`SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE application_name = '${tags[h]}'`);
            hopsDone++;
          }
          writeFileSync(go, '');
          for (const x of procs) x.p.kill('SIGCONT');
          await Promise.race([Promise.all(procs.map((x) => x.exited)), sleep(30_000)]);
          const all = lines(effects);
          const eff = all.filter((l) => l.startsWith('effect '));
          // How the job ended, as the store says (the effect landed `keys` times).
          const s2: Storage = kind === 'postgres'
            ? new (await import('@gnldev/durable/postgres')).PostgresStorage({ connectionString: db }) as unknown as Storage
            : new SqliteStorage(db) as unknown as Storage;
          const status = (await listJobs(s2.work!)).map((j) => j.status).join(',');
          await s2.close?.();
          const row = { kind, scenario: 'queue', mode, trial: t, hops: hopsDone, entered: all.filter((l) => l.startsWith('enter ')).length, raw: eff.length, keys: new Set(eff.map((l) => l.split(' ')[2])).size, status };
          console.log(JSON.stringify(row));
          if (out) appendFileSync(out, `${JSON.stringify(row)}\n`);
          continue;
        }
        const a = start(kind, tagged(tagA), effects, go, 'A'); procs.push(a);
        const until = Date.now() + 20_000;
        while (!lines(effects).some((l) => l.startsWith('enter A')) && Date.now() < until) await sleep(20);
        a.p.kill('SIGSTOP');
        const frozenAt = Date.now();
        let cut = 0;
        if (mode === 'cut' && kind === 'postgres') cut = Number(psql(`SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE application_name = '${tagA}'`));
        const b = start(kind, tagged(`np_qb_${process.pid}_${t}`), effects, go, 'B'); procs.push(b);
        let takeoverMs: number | null = null;
        while (Date.now() < frozenAt + freezeMs) {
          if (takeoverMs === null && lines(effects).some((l) => l.startsWith('enter B'))) takeoverMs = Date.now() - frozenAt;
          await sleep(20);
        }
        writeFileSync(go, '');
        a.p.kill('SIGCONT');
        await Promise.race([Promise.all(procs.map((x) => x.exited)), sleep(30_000)]);
        const eff = lines(effects).filter((l) => l.startsWith('effect '));
        const row = { kind, scenario: 'queue', mode, trial: t, cut, raw: eff.length, keys: new Set(eff.map((l) => l.split(' ')[2])).size, byA: eff.filter((l) => l.startsWith('effect A')).length, byB: eff.filter((l) => l.startsWith('effect B')).length, takeoverMs };
        console.log(JSON.stringify(row));
        if (out) appendFileSync(out, `${JSON.stringify(row)}\n`);
      } catch (e: any) {
        const row = { kind, scenario: 'queue', mode, trial: t, error: String(e?.message ?? e) };
        if (out) appendFileSync(out, `${JSON.stringify(row)}\n`);
      } finally {
        for (const x of procs) { try { x.p.kill('SIGCONT'); x.p.kill('SIGKILL'); } catch { /* gone */ } }
        await Promise.all(procs.map((x) => x.exited));
        if (dbName) { try { psql(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`); } catch { /* best effort */ } }
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
