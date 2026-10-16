// S5 — 4 app processes, 200 concurrent runs on one Postgres: throughput, statements per run, and what
// following costs (statements per event per observer) by polling and by LISTEN/NOTIFY.
import { describe, it, expect, afterEach } from 'vitest';
import { newStore, startNode, post, readEvents, stopNode, PG_BASE, type Node, type Store } from './detached/harness.js';

const live: Node[] = [];
const stores: Store[] = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map(stopNode));
  stores.splice(0).forEach((s) => s.drop());
});

const RUNS = 200;
const stats = async (n: Node) => (await fetch(n.url('/stats'))).json();

describe.skipIf(!PG_BASE)('S5 scale on postgres', () => {
  for (const mode of ['baseline-in-request', 'in-process', 'poll', 'notify'] as const) {
    it(`S5 ${mode}: 4 processes, ${RUNS} concurrent runs, one observer each`, { timeout: 300_000 }, async () => {
      const s = newStore('postgres');
      stores.push(s);
      const env: Record<string, string> = { DN_TOOL_MS: '200', DN_WORDS: 'one two three four five six seven eight nine ten', DN_GAP_MS: '5', DN_POLL_MS: '100', DN_SWEEP_MS: '1000', ...(mode === 'notify' ? { DN_SIGNAL: 'notify' } : {}) };
      const nodes = await Promise.all([0, 1, 2, 3].map(() => startNode(s, env)));
      live.push(...nodes);
      const before = await Promise.all(nodes.map(stats));
      const t0 = performance.now();
      const results = await Promise.all(Array.from({ length: RUNS }, async (_, i) => {
        const starter = nodes[i % 4]!;
        // The observer is on another process (cross-process delivery), except in-process mode.
        const observer = mode !== 'poll' && mode !== 'notify' ? starter : nodes[(i + 1) % 4]!;
        if (mode === 'baseline-in-request') return readEvents(await post(starter, '/direct-stream', { runId: `s5-${i}` }));
        if (mode === 'in-process') return readEvents(await post(starter, '/start?stream=1', { runId: `s5-${i}` }));
        await post(starter, '/start', { runId: `s5-${i}` });
        return readEvents(await fetch(observer.url(`/events?runId=s5-${i}`)));
      }));
      const wall = performance.now() - t0;
      const after = await Promise.all(nodes.map(stats));
      const sum = (k: string) => after.reduce((a, x, i) => a + (x[k] ?? 0) - (before[i][k] ?? 0), 0);
      const completed = results.filter((evs) => evs.some((e) => (e.kind === 'status' && e.data.state === 'completed') || (mode === 'baseline-in-request' && e.kind === 'done'))).length;
      const events = results.reduce((a, evs) => a + evs.length, 0);
      const storeStmts = sum('store');
      const followerReads = sum('reads'); // each read = 2 statements (key range + values)
      const line = {
        mode, runs: RUNS, completed, wallMs: Math.round(wall), runsPerSec: +(RUNS / (wall / 1000)).toFixed(1),
        storeStatements: storeStmts, statementsPerRun: +(storeStmts / RUNS).toFixed(1),
        eventsAppended: sum('appends'), eventsDelivered: events,
        followerStatements: followerReads * 2, followerStatementsPerEventPerObserver: +((followerReads * 2) / events).toFixed(3),
        execWrites: sum('execWrites'), notifies: sum('notifies'), livenessStatements: sum('liveness'),
      };
      console.log(`[S5] ${JSON.stringify(line)}`);
      expect(completed).toBe(RUNS);
    });
  }
});
