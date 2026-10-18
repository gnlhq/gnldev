// Studio's reader is the store Studio's own writes go through — a regression replay, a fork, an
// approval. It used to forward four of the store's eight guarantees by hand: measured on Postgres, a
// replay through `POST /runs/:id/regression` wrote its records by read-then-put (no compare-and-set,
// no shared clock) and never reached the metrics, while the same replay run directly did both. Now the
// reader forwards every guarantee, and a reader that can write without them is refused.
// Postgres runs when GNL_PG_URL is set.
import { describe, it, expect, afterAll } from 'vitest';
import { InMemoryStorage, runDurable, toJournal, readMetricsSummary, JOURNAL_GUARANTEES, type Journal, type Storage } from '@gnldev/durable';
import { PostgresStorage } from '@gnldev/durable/postgres';
import { createStudioApi } from '../src/server.js';
import { call } from './call.js';

const ends: Array<() => Promise<unknown>> = [];
afterAll(async () => { for (const e of ends.reverse()) await e(); });
const STORES: Array<[string, () => Storage]> = [['in-memory', () => new InMemoryStorage()]];
if (process.env.GNL_PG_URL) STORES.push(['postgres (real)', () => { const s = new PostgresStorage({ connectionString: process.env.GNL_PG_URL! }); ends.push(() => s.close()); return s; }]);

const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } };
const model = () => ({ specificationVersion: 'v4', provider: 'm', modelId: 'm', supportedUrls: {}, doGenerate: async () => ({ content: [{ type: 'text', text: 'Hello' }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }) });

/** The store, counting how often each guarantee is used. */
function counted(j: Journal) {
  const n: Record<string, number> = {};
  const view = new Proxy(j, { get(t, k) { const v = Reflect.get(t, k, t); if (typeof v !== 'function') return v; return (...a: unknown[]) => { n[String(k)] = (n[String(k)] ?? 0) + 1; return v.apply(t, a); }; } });
  return { view, n };
}

describe.each(STORES)('a replay through Studio keeps the store\'s guarantees, %s', (_n, make) => {
  it('it writes by compare-and-set on the store\'s clock and is counted in the metrics, as a direct replay is', async () => {
    const s = make();
    const j = toJournal(s);
    const base = `sr-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    await runDurable({ runId: base, journal: s.runs, model: model(), prompt: 'x' } as never);
    const runs = async () => (await readMetricsSummary(j, { days: 0 })).all?.runs ?? 0;
    const before = await runs();
    const c = counted(j);
    const app = createStudioApi({ reader: c.view, regressionModel: () => model() } as never);
    const res = await call(app as never, `/runs/${base}/regression`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'mock/x', newRunId: `${base}-s` }) });
    expect(res.status).toBe(200);
    expect(c.n.putIfMatch ?? 0, 'the replay\'s verdicts and attempts were compared, not overwritten').toBeGreaterThan(0);
    expect(c.n.now ?? 0, 'dated by the store\'s clock').toBeGreaterThan(0);
    expect(c.n.applyBatch ?? 0, 'its metrics were recorded').toBeGreaterThan(0);
    expect((await runs()) - before, 'the replay is counted').toBe(1);
  });

  it('a reader that can write without the guarantees is refused, naming them; a read-only one is welcome', () => {
    const j = toJournal(make());
    const partial = { get: j.get.bind(j), put: j.put.bind(j), listRuns: j.listRuns.bind(j), readRun: j.readRun.bind(j) };
    expect(() => createStudioApi({ reader: partial } as never)).toThrow(new RegExp(JOURNAL_GUARANTEES.map((m) => `\`${m}\``).join(', ')));
    const readOnly = { get: j.get.bind(j), listRuns: j.listRuns.bind(j), readRun: j.readRun.bind(j) };
    expect(() => createStudioApi({ reader: readOnly } as never)).not.toThrow();
  });
});
