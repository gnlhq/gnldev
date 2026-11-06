// K2 sibling scenarios (detached executor): an execution's ending comes from positive evidence, and a lost
// right to execute (close/release, cancel) reaches the body with its reason.
//   S1  close() mid-run, a stream that ends SILENTLY on abort → no ending is written; another process
//       continues the run to its real end; the host is told once, by that process, `completed`.
//   S2  a stream that ends WITHOUT a finish part and WITHOUT any abort (a truncated provider stream) → the
//       run is not `completed`.
//   S3  cancel() mid-run, same silent stream → `canceled`, told once as `canceled` (cancel ≠ release).
import { describe, it, expect, afterEach } from 'vitest';
import pg from 'pg';
import { DetachedRuns, streamDurable, readRunEvents, postgresLiveness, installProcessLiveness, type Journal, type Launch } from '../src/index.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { streamingModel, textOf } from './detached/models.js';

const PG_URL = process.env.GNL_PG_URL;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
afterEach(() => installProcessLiveness(undefined));

const notices: string[] = [];
interface Proc { name: string; storage: PostgresStorage; journal: Journal; runs: DetachedRuns; liveness: any }
async function proc(name: string, url: string, launchFor: (runId: string, journal: Journal) => Launch): Promise<Proc> {
  const storage = new PostgresStorage({ connectionString: url });
  (storage as any).pool?.on?.('error', () => {});
  const journal = storage.runs as unknown as Journal;
  await storage.init();
  const liveness = await postgresLiveness({ connectionString: url, heartbeatMs: 500 });
  const runs = new DetachedRuns({ journal, liveness, sweepMs: 200, pollMs: 50, resume: (rec) => launchFor(rec.runId, journal), onComplete: async (c) => { notices.push(`${name} ${c.runId} ${c.state}`); } });
  return { name, storage, journal, runs, liveness };
}
async function stop(p: Proc) { await p.runs.close(); await p.liveness.close(); await p.storage.close(); }

async function withDb<T>(fn: (url: string) => Promise<T>): Promise<T> {
  const admin = new pg.Client({ connectionString: PG_URL });
  await admin.connect();
  const db = `k2s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  await admin.query(`CREATE DATABASE ${db}`);
  const url = new URL(PG_URL!); url.pathname = `/${db}`;
  try { return await fn(url.toString()); } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.end();
  }
}
const states = (evs: any[]) => evs.filter((e) => e.kind === 'status').map((e) => e.data.state);

const N = 40;
/** A launch with no AI SDK in it: on abort it ends SILENTLY; `finish: false` → it never sends a finish part. */
const rawLaunch = (opts: { finish: boolean; words?: number }) => (runId: string, journal: Journal): Launch => async (signal) => {
  const r: any = await streamDurable({ journal, runId, model: streamingModel({ words: ['x '], gapMs: 1 }), prompt: 'hi', resourceId: 'alice' } as any);
  for await (const _ of r.fullStream) { /* the owner record is written */ }
  const words = opts.words ?? N;
  return {
    steps: Promise.resolve([]),
    fullStream: (async function* () {
      yield { type: 'start' };
      yield { type: 'start-step' };
      yield { type: 'text-start', id: 't' };
      for (let i = 0; i < words; i++) {
        if (signal.aborted) return;
        yield { type: 'text-delta', id: 't', text: `y${i} ` };
        await sleep(40);
      }
      yield { type: 'text-end', id: 't' };
      if (!opts.finish) return; // truncated: no finish-step, no finish
      yield { type: 'finish-step', finishReason: 'stop', usage: {} };
      yield { type: 'finish', finishReason: 'stop', totalUsage: {} };
    })(),
  };
};
const firstText = async (a: Proc, runId: string) => {
  for (let i = 0; i < 200; i++) { if ((await readRunEvents(a.journal, runId)).some((e) => e.kind === 'text')) return; await sleep(25); }
  throw new Error('no text');
};
async function untilEnded(j: Journal, runId: string, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const s = states(await readRunEvents(j, runId));
    if (['completed', 'failed', 'canceled'].includes(s.at(-1))) return s;
    await sleep(50);
  }
  return states(await readRunEvents(j, runId));
}
const WHOLE = Array.from({ length: N }, (_, i) => `y${i} `).join('');

describe.skipIf(!PG_URL)('K2 siblings: detached execution ending', () => {
  it('S1 close() mid-run (silent stream): nothing ends it; another process ends it whole, told once', { timeout: 60_000 }, async () => {
    await withDb(async (url) => {
      const launchFor = rawLaunch({ finish: true });
      const runId = 'r-s1';
      const A = await proc('A', url, launchFor);
      await A.runs.start({ runId, launch: launchFor(runId, A.journal) });
      await firstText(A, runId);
      await A.runs.close();
      const afterClose = states(await readRunEvents(A.journal, runId));
      await A.liveness.close(); await A.storage.close();
      const noticesAfterClose = notices.filter((n) => n.includes(` ${runId} `));
      const B = await proc('B', url, launchFor);
      const final = await untilEnded(B.journal, runId, 20_000);
      const evs = await readRunEvents(B.journal, runId);
      await sleep(300);
      await stop(B);
      console.log('[K2-S1]', JSON.stringify({ afterClose, noticesAfterClose, final, text: textOf(evs as any).length, notices: notices.filter((n) => n.includes(` ${runId} `)) }));
      expect(afterClose, 'the close wrote an ending').toEqual(['running']);
      expect(noticesAfterClose, 'the host was told the run ended at the close').toEqual([]);
      expect(final.at(-1)).toBe('completed');
      expect(textOf(evs as any)).toBe(WHOLE);
      expect(notices.filter((n) => n.includes(` ${runId} `))).toEqual([`B ${runId} completed`]);
    });
  });

  it('S2 a stream that ends without a finish part (no abort) is not completed', { timeout: 60_000 }, async () => {
    await withDb(async (url) => {
      const launchFor = rawLaunch({ finish: false, words: 3 });
      const runId = 'r-s2';
      const A = await proc('A', url, launchFor);
      await A.runs.start({ runId, launch: launchFor(runId, A.journal) });
      const final = await untilEnded(A.journal, runId, 10_000);
      await sleep(200);
      await stop(A);
      console.log('[K2-S2]', JSON.stringify({ final, notices: notices.filter((n) => n.includes(` ${runId} `)) }));
      expect(final).not.toContain('completed');
      expect(notices.filter((n) => n.includes(` ${runId} completed`))).toEqual([]);
    });
  });

  it('S3 cancel() mid-run (silent stream) ends it canceled — a cancel is not a release', { timeout: 60_000 }, async () => {
    await withDb(async (url) => {
      const launchFor = rawLaunch({ finish: true });
      const runId = 'r-s3';
      const A = await proc('A', url, launchFor);
      await A.runs.start({ runId, launch: launchFor(runId, A.journal) });
      await firstText(A, runId);
      expect(await A.runs.cancel({ runId })).toBe('delivered');
      const final = await untilEnded(A.journal, runId, 10_000);
      await sleep(300);
      await stop(A);
      console.log('[K2-S3]', JSON.stringify({ final, notices: notices.filter((n) => n.includes(` ${runId} `)) }));
      expect(final.at(-1)).toBe('canceled');
      expect(notices.filter((n) => n.includes(` ${runId} `))).toEqual([`A ${runId} canceled`]);
    });
  });
});
