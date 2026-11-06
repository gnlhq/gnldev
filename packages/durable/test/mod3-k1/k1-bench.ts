// mod3 k1 bench — takeover latency after an idle period. Usage (from packages/durable):
//   GNL_PG_URL=... node --import <tsx loader> test/mod3-k1/k1-bench.ts <reps> <idleSec> <start 0|1> <trigger 0|1>
// Each rep: fresh schema; B (root registry; `start` → calls start(); `trigger` → one root request at once)
// idles <idleSec>; then A starts a run and is SIGKILLed as soon as it executes; measured: ms from the kill
// until B's log shows the run executing under another owner. Prints one JSON line per rep and a summary.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const pg = require_('pg');
const tsxLoader = join(dirname(require_.resolve('tsx/package.json')), 'dist', 'loader.mjs');
const PG_URL = process.env.GNL_PG_URL!;
const [reps, idleSec, start, trigger] = process.argv.slice(2).map(Number) as [number, number, number, number];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : '');

const out: number[] = [];
for (let i = 0; i < reps; i++) {
  const admin = new pg.Client({ connectionString: PG_URL });
  await admin.connect();
  const schema = `k1b_${Date.now().toString(36)}_${i}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const u = new URL(PG_URL); u.searchParams.set('options', `-c search_path=${schema}`);
  const dir = mkdtempSync(join(tmpdir(), 'k1b-'));
  const runId = `b-${i}`;
  const proc = (cfg: object) => spawn(process.execPath, ['--import', tsxLoader, join(here, 'fixtures', 'k1-node.ts'), JSON.stringify(cfg)], { stdio: 'ignore' });
  const B = proc({ role: 'B', pg: u.toString(), runId, dir, start: start === 1, sweepMs: 1000 });
  while (!existsSync(join(dir, 'B.pid'))) await sleep(50);
  if (trigger) writeFileSync(join(dir, 'trigger'), '1');
  await sleep(idleSec * 1000);
  const A = proc({ role: 'A', pg: u.toString(), runId, dir, sweepMs: 1000 });
  while (!existsSync(join(dir, 'a.owner'))) await sleep(20);
  const aOwner = read(join(dir, 'a.owner'));
  const t0 = Date.now();
  A.kill('SIGKILL');
  let ms = -1;
  for (let k = 0; k < 400 && ms < 0; k++) {
    for (const l of read(join(dir, 'B.log')).split('\n')) {
      const [at, kind, , status, owner] = l.split(' ');
      if (kind === 'exec' && Number(at) >= t0 && status === 'running' && owner !== aOwner) { ms = Number(at) - t0; break; }
    }
    if (ms < 0) await sleep(100);
  }
  B.kill('SIGKILL');
  await sleep(300);
  await admin.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => {});
  await admin.end();
  out.push(ms);
  console.log(JSON.stringify({ rep: i, takeoverMs: ms }));
}
const ok = out.filter((x) => x >= 0).sort((a, b) => a - b);
const med = ok.length ? ok[Math.floor(ok.length / 2)] : -1;
const mean = ok.reduce((a, b) => a + b, 0) / (ok.length || 1);
const sd = Math.sqrt(ok.reduce((a, b) => a + (b - mean) ** 2, 0) / (ok.length || 1));
console.log(JSON.stringify({ summary: { reps, idleSec, start, trigger, taken: ok.length, medianMs: med, minMs: ok[0], maxMs: ok[ok.length - 1], sdMs: Math.round(sd) } }));
