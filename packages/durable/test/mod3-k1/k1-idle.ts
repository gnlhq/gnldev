// mod3 k1 (from the audit's a8-idle.ts): queries an idle createGnl process sends to Postgres. Usage: tsx a8-idle.ts <preIdleSec> <idleSec>
// Phase 0: createGnl built, nothing run (preIdleSec). Phase 1: one run, then idle (idleSec).
// Counted client-side (every pg Client.query, tagged by SQL) and server-side (pg_stat_database.xact_commit
// for THIS database only, read from a client connected to another database).
import pg from 'pg';
import { createGnl, STAFF } from '../../src/index.js';
import { PostgresStorage } from '../../src/postgres-storage.js';
import { createMockModel, finalTextResult } from '../mock.js';

const [preS, idleS] = process.argv.slice(2).map(Number);
const URL_ = process.env.GNL_PG_URL!;
const DB = new URL(URL_).pathname.slice(1);
const sched = process.env.K1_SCHEMA;
const URL_S = sched ? (() => { const u = new URL(URL_); u.searchParams.set('options', `-c search_path=${sched}`); return u.toString(); })() : URL_;
const log: Array<{ t: number; sql: string }> = [];
let counting = false;
let sweepParams: unknown;
const origQuery = (pg as any).Client.prototype.query;
(pg as any).Client.prototype.query = function (this: any, cfg: any, ...rest: any[]) {
  if (counting && !this.__a78admin && /gnl_run_journal/.test(String(cfg?.text ?? cfg)) && !sweepParams) sweepParams = rest[0] ?? cfg?.values;
  if (counting && !this.__a78admin) log.push({ t: performance.now(), sql: typeof cfg === 'string' ? cfg : cfg?.text ?? String(cfg) });
  return origQuery.call(this, cfg, ...rest);
};
const adminUrl = new URL(URL_); adminUrl.pathname = '/postgres';
const admin = new pg.Client({ connectionString: adminUrl.toString() }); (admin as any).__a78admin = true;
await admin.connect();
const xact = async () => Number((await admin.query('select xact_commit + xact_rollback as n from pg_stat_database where datname = $1', [DB])).rows[0].n);

function classify(sql: string): string {
  const s = sql.replace(/\s+/g, ' ');
  if (/FROM pg_locks .*pid = pg_backend_pid\(\)/.test(s)) return 'liveness heartbeat (holdsOwn)';
  if (/pg_notify|LISTEN/.test(s)) return 'notify/listen';
  if (/FROM pg_locks/.test(s)) return 'liveness isAlive (other proc)';
  if (/__exec__|exec/i.test(s) && /gnl_run_journal/.test(s)) return 'detached sweep (listKeys/getMany EXEC_PREFIX)';
  if (/gnl_run_journal/.test(s)) return 'journal other: ' + s.slice(0, 90);
  return 'other: ' + s.slice(0, 90);
}
function report(name: string, from: number, to: number, x0: number, x1: number) {
  const ev = log.filter((e) => e.t >= from && e.t < to);
  const by = new Map<string, number>();
  for (const e of ev) by.set(classify(e.sql), (by.get(classify(e.sql)) ?? 0) + 1);
  let gap = 0; let prev = from;
  for (const e of ev) { gap = Math.max(gap, e.t - prev); prev = e.t; }
  gap = Math.max(gap, to - prev);
  const sec = (to - from) / 1000;
  console.log(`\n== ${name}: ${sec.toFixed(1)} s, client queries ${ev.length} (${(ev.length / sec).toFixed(2)}/s, x300s ≈ ${Math.round(ev.length / sec * 300)}), longest silence ${Math.round(gap)} ms, server xact (${DB}) ${x1 - x0}`);
  for (const [k, v] of [...by].sort((a, b) => b[1] - a[1])) console.log(`   ${String(v).padStart(5)}  ${k}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const storage = new PostgresStorage({ connectionString: URL_S });
const model = createMockModel(async () => finalTextResult('ok'));
const gnl = createGnl({ storage, agents: { a: { model } } } as any);
if (process.env.K1_START === '1') await (gnl as any).start?.();
await storage.runs.get('warm');
await sleep(1500);
counting = true;
let x0 = await xact(); let t0 = performance.now();
await sleep(preS * 1000);
let t1 = performance.now(); let x1 = await xact();
report('phase 0: createGnl built, nothing run', t0, t1, x0, x1);
x0 = await xact(); t0 = performance.now(); await sleep(preS * 1000); t1 = performance.now(); x1 = await xact();
report('phase 0b: second window, still nothing run', t0, t1, x0, x1);

counting = false;
await gnl.run('a', { runId: 'a8-1', prompt: 'go', caller: STAFF } as any);
await sleep(3000); // let the run settle
counting = true;
x0 = await xact(); t0 = performance.now();
await sleep(idleS * 1000);
t1 = performance.now(); x1 = await xact();
report('phase 1: idle after one run', t0, t1, x0, x1);
// sample of distinct SQL texts seen in phase 1
const seen = new Map<string, number>();
for (const e of log.filter((e) => e.t >= t0)) seen.set(e.sql.replace(/\s+/g, ' ').slice(0, 160), (seen.get(e.sql.replace(/\s+/g, ' ').slice(0, 160)) ?? 0) + 1);
console.log('\nsweep listKeys params sample:', JSON.stringify(sweepParams)); console.log('\ndistinct SQL in phase 1:'); for (const [k, v] of seen) console.log(`   ${v}  ${k}`);
counting = false;
await storage.close(); await admin.end();
process.exit(0);
