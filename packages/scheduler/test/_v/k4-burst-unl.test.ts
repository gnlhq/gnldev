// MOD3 k4 — BURST (all candidates, same file; only the wiring differs, chosen by K4_CAND = bp | c | d).
// 200 one-shot triggers on ONE slot, each a ~2 s run, + 1 short trigger every 500 ms, on real Postgres
// (fresh schema per repetition). Each run writes a start and an end record (a workflow step's worth of I/O).
//
// HYPOTHESIS (written before measuring):
//   H1  D keeps the short trigger's DECISION on time (dispatch count ≈ alone), but its EXECUTION waits
//       behind the 200 long jobs in the queue (FIFO): short runs in the 10 s window ≪ alone (≤ 2), and
//       its lateness ≈ 200·2 s / workerConcurrency ≈ 40 s. Max concurrent = worker concurrency (10).
//   H2  B' (concurrency 10, oldest-due first) behaves like D: the long slot is older than every later
//       short slot, so the short trigger waits for the longs too. Max concurrent 10.
//   H3  C (one loop per trigger, no limit) runs all 201 at once: max concurrent ≈ 201, short ≈ alone,
//       lateness ≈ one poll; PG connections and RSS highest of the three.
//   Refuted if: D's short runs in window ≥ alone−1 (median) — i.e. the queue does NOT hold it up; or
//   B' short ≥ alone−1; or C's max concurrent < 150.
import { it } from 'vitest';
import { createRequire } from 'node:module';
const pg = createRequire(new URL('../../../durable/package.json', import.meta.url))('pg');
import { PostgresStorage } from '@gnldev/durable/postgres';
import { toJournal } from '@gnldev/durable';
import * as sched from '../../src/index.js';

const CAND = process.env.K4_CAND!;
const BASE = process.env.GNL_PG_URL!;
const REPS = Number(process.env.K4_REPS ?? '5');
const N = Number(process.env.K4_N ?? '200');
const LONG_MS = 2000, PERIOD = 500, WINDOW = 10_000, CAP = 60_000, LEAD = 300;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const median = (xs: number[]) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };

async function once(rep: number, withLong: boolean) {
  const schema = `k4b_${CAND}_${process.pid}_${rep}_${withLong ? 'l' : 'a'}`;
  const admin = new pg.Client(BASE); await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const storage = new PostgresStorage({ connectionString: `${BASE}?options=-c%20search_path%3D${schema}` });
  await storage.runs.get('warm');
  const j = toJournal(storage.runs) as any;
  const t0 = Date.now();
  let inFlight = 0, maxInFlight = 0, longDone = 0;
  const short: Array<{ start: number; slot: number }> = [];
  const runner: sched.WorkflowRunner = {
    async runWorkflow(name, _i, o) {
      const start = Date.now();
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await storage.runs.put(`burst:${o!.runId}:start`, start);
        if (name === 'short') {
          const slot = (o as any)?.scheduledFor ?? (await (sched as any).scheduledForOf({ journal: j, runId: o!.runId }));
          short.push({ start, slot });
        } else await sleep(LONG_MS);
        await storage.runs.put(`burst:${o!.runId}:end`, Date.now());
        if (name !== 'short') longDone++;
      } finally { inFlight--; }
      return { runId: o!.runId! };
    },
  };
  if (withLong) for (let i = 0; i < N; i++) await sched.scheduleWorkflow(j, { id: `long-${i}`, name: 'long', at: t0 + LEAD }, t0);
  await sched.scheduleWorkflow(j, { id: 'short', name: 'short', every: PERIOD }, t0 + LEAD - PERIOD);
  let stop: () => Promise<void>;
  if (CAND === 'd') {
    const { dEnv } = await import('./d-harness.js');
    const env = dEnv(runner, { concurrency: 10 }, storage);
    const s = sched.createScheduler(j, env.dispatch as never, { pollMs: 20 });
    s.start(); env.worker.start();
    stop = async () => { s.stop(); env.worker.stop(); await env.worker.close(); };
  } else {
    const s = sched.createScheduler(j, runner as never, { pollMs: 20, ...(process.env.K4_CONC ? { concurrency: Number(process.env.K4_CONC) } : {}) });
    s.start();
    stop = async () => { s.stop(); };
  }
  let maxConn = 0, maxRss = 0;
  const rss0 = process.memoryUsage().rss;
  const sampler = setInterval(() => {
    maxRss = Math.max(maxRss, process.memoryUsage().rss);
    admin.query(`select count(*)::int n from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()`).then((r) => { maxConn = Math.max(maxConn, r.rows[0].n); }, () => {});
  }, 100);
  await sleep(WINDOW);
  const shortInWindow = short.filter((s) => s.start - t0 <= WINDOW).length;
  // keep going until the longs are done (or CAP), so lateness of every short run that waited is seen
  while (withLong && longDone < N && Date.now() - t0 < CAP) await sleep(100);
  const wallLong = Date.now() - t0;
  await stop!();
  clearInterval(sampler);
  await sleep(200);
  const late = short.map((s) => s.start - s.slot);
  const res = { rep, withLong, shortInWindow, shortTotal: short.length, lateMed: median(late), lateMax: late.length ? Math.max(...late) : NaN, maxInFlight, longDone, wallLong, maxConn, rssMB: Math.round(maxRss / 1e6), rssDeltaMB: Math.round((maxRss - rss0) / 1e6) };
  await storage.close();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  return res;
}

// A candidate measurement (K4_CAND names the build to measure, on a real Postgres): skipped unless asked for.
it.skipIf(!CAND || !BASE)(`burst ${CAND}`, async () => {
  const alone = await once(0, false);
  console.log(`[k4 BURST ${CAND}] ALONE ${JSON.stringify(alone)}`);
  const rs = [];
  for (let r = 1; r <= REPS; r++) { const x = await once(r, true); rs.push(x); console.log(`[k4 BURST ${CAND}] ${JSON.stringify(x)}`); }
  const f = (k: keyof (typeof rs)[0]) => { const v = rs.map((x) => x[k] as number); return `${median(v)} [${Math.min(...v)}–${Math.max(...v)}]`; };
  console.log(`[k4 BURST ${CAND}] SUMMARY n=${REPS} shortInWindow=${f('shortInWindow')} (alone ${alone.shortInWindow}) lateMed=${f('lateMed')} lateMax=${f('lateMax')} maxInFlight=${f('maxInFlight')} maxConn=${f('maxConn')} rssMB=${f('rssMB')} rssDeltaMB=${f('rssDeltaMB')} wallLong=${f('wallLong')} longDone=${f('longDone')}`);
}, 600_000);
