// MOD3 k4 — performance of the loop (A3), 10 repetitions per configuration.
// H: in the serial loop (A) the short trigger's fires in the window fall as long triggers are added
// (1 long → a few of 12; 10 long → ≤ 1). In B (concurrency ≥ long+1) and C they stay ≈ 12 whatever the
// number of long triggers, with lateness ≈ one poll interval. Refuted if: B/C with 10 long triggers fire
// the short one fewer than alone−1 times (median); or A with 10 long triggers keeps a median ≥ 6.
// Env: K4_LONG (number of long triggers), K4_CONC (createScheduler concurrency; candidate B only).
import { it } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { scheduleWorkflow, createScheduler, type WorkflowRunner } from '../../src/index.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LONG = Number(process.env.K4_LONG ?? '1');
const CONC = process.env.K4_CONC === undefined ? undefined : Number(process.env.K4_CONC);
const REPS = Number(process.env.K4_REPS ?? '10');
const WINDOW = 2500, PERIOD = 200, LONG_MS = 1000;

async function once() {
  const j = new InMemoryJournal();
  const t0 = Date.now();
  const short: number[] = [];
  const runner: WorkflowRunner = {
    async runWorkflow(name, _i, o) {
      if (name === 'short') short.push(Date.now() - t0);
      else await sleep(LONG_MS);
      return { runId: o!.runId! };
    },
  };
  for (let i = 0; i < LONG; i++) await scheduleWorkflow(j, { id: `a-long-${i}`, name: 'long', every: LONG_MS }, t0 - LONG_MS + 100);
  await scheduleWorkflow(j, { id: 'short', name: 'short', every: PERIOD }, t0);
  const s = createScheduler(j, runner, { pollMs: 20, ...(CONC !== undefined ? { concurrency: CONC } : {}) } as never);
  s.start();
  await sleep(WINDOW);
  s.stop();
  await sleep(LONG_MS + 100);
  const inW = short.filter((t) => t <= WINDOW);
  const late = inW.map((t) => t % PERIOD); // time past the slot it fired for (≥ the slot, < the next one)
  return { fires: inW.length, lateMed: median(late) };
}
const median = (xs: number[]) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };
const sd = (xs: number[]) => { const m = xs.reduce((a, b) => a + b, 0) / xs.length; return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length); };

it(`bench long=${LONG} conc=${CONC ?? 'default'}`, async () => {
  const r: Array<{ fires: number; lateMed: number }> = [];
  await once(); // warm-up
  for (let i = 0; i < REPS; i++) r.push(await once());
  const f = r.map((x) => x.fires), l = r.map((x) => x.lateMed).filter((x) => !Number.isNaN(x));
  console.log(`[k4 BENCH] long=${LONG} conc=${CONC ?? 'default'} n=${REPS} shortFires median=${median(f)} sd=${sd(f).toFixed(2)} min=${Math.min(...f)} max=${Math.max(...f)} | lateness median-of-medians=${median(l)} ms sd=${l.length ? sd(l).toFixed(1) : 'n/a'} | raw=${JSON.stringify(f)}`);
}, 120_000);
