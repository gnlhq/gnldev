// A run's outcome is the verdict of its newest attempt. Measured on 0.11.1 with Postgres: worker A's
// model call fails (401), A frees the run, and its 'failed' write is slow; worker B runs the same run
// meanwhile and completes it — then A's write lands and the run reads 'failed', permanently. The
// verdict was dated by the store's clock at the moment it was WRITTEN, so the older attempt's late
// write looked like the newest news. In-memory and Sqlite stores, which have no shared clock, dated
// it when it was decided and were right by accident.
//
// Each verdict now carries the instant its attempt began, on the same clock; an older attempt's
// verdict never replaces a newer attempt's record. Postgres runs when GNL_PG_URL is set.
import { describe, it, expect, afterAll } from 'vitest';
import { InMemoryStorage, runDurable, streamDurable, readRunOutcome, recordRunOutcome, type Storage } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { claimRunOwner, STAFF } from '../src/run-identity.js';
import { createMockModel, finalTextResult } from './mock.js';

const ends: Array<() => Promise<unknown>> = [];
afterAll(async () => { for (const e of ends.reverse()) await e(); });

const PG_URL = process.env.GNL_PG_URL;
const STORES: Array<[string, () => Promise<Storage>]> = [
  ['in-memory', async () => new InMemoryStorage()],
  ['sqlite', async () => new SqliteStorage(':memory:')],
];
if (PG_URL) {
  let shared: PostgresStorage | undefined;
  STORES.push(['postgres (real)', async () => {
    if (!shared) { shared = new PostgresStorage({ connectionString: PG_URL }); const s = shared; ends.push(() => s.close()); }
    return shared;
  }]);
}
const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const status = async (s: Storage, runId: string) => (await readRunOutcome(s.runs as never, runId))?.status;
const unauthorized = () => Object.assign(new Error('401 Unauthorized'), { name: 'AI_APICallError', statusCode: 401, isRetryable: false });

/** Worker A's view of the store: once A has failed, its outcome write waits until `release` opens (a slow write, a stall). */
function slowAfterFailure(journal: object, release: Promise<void>) {
  const state = { failed: false };
  const view = new Proxy(journal, {
    get(t: any, k) {
      const v = Reflect.get(t, k, t);
      if (typeof v !== 'function') return v;
      return async (...a: any[]) => {
        if (state.failed && (k === 'now' || (typeof a[0] === 'string' && a[0].endsWith(':outcome')))) await release;
        return v.apply(t, a);
      };
    },
  });
  return { view, state };
}

describe.each(STORES)('an older attempt\'s verdict does not replace a newer one, %s', (_n, make) => {
  it('A fails and writes late; B completes the run meanwhile — the run reads completed', async () => {
    const s = await make();
    const runId = `v1-${unique()}`;
    const bDone = gate();
    const a = slowAfterFailure(s.runs, bDone.p);
    const aRun = runDurable({ runId, journal: a.view, model: createMockModel(async () => { a.state.failed = true; throw unauthorized(); }), prompt: 'x', maxRetries: 0 } as never).catch((e: Error) => e);
    await sleep(200);
    await runDurable({ runId, journal: s.runs, model: createMockModel(async () => finalTextResult('ok')), prompt: 'x' } as never);
    expect(await status(s, runId)).toBe('completed');
    bDone.open();
    expect(await aRun).toBeInstanceOf(Error);
    expect(await status(s, runId)).toBe('completed');
  });

  it('A fails and writes late while B is still running — the run reads running, then completed', async () => {
    const s = await make();
    const runId = `v2-${unique()}`;
    const aWrites = gate(); const bMayFinish = gate();
    const a = slowAfterFailure(s.runs, aWrites.p);
    const aRun = runDurable({ runId, journal: a.view, model: createMockModel(async () => { a.state.failed = true; throw unauthorized(); }), prompt: 'x', maxRetries: 0 } as never).catch((e: Error) => e);
    await sleep(200);
    const bRun = runDurable({ runId, journal: s.runs, model: createMockModel(async () => { await bMayFinish.p; return finalTextResult('ok'); }), prompt: 'x' } as never);
    await sleep(200);
    expect(await status(s, runId)).toBe('running');
    aWrites.open();
    await aRun;
    expect(await status(s, runId), "the older attempt's failure does not end the newer attempt").toBe('running');
    bMayFinish.open();
    await bRun;
    expect(await status(s, runId)).toBe('completed');
  });

  it('the stream path: A\'s stream fails and writes late; B completes — the run reads completed', async () => {
    const s = await make();
    const runId = `v3-${unique()}`;
    const bDone = gate();
    const a = slowAfterFailure(s.runs, bDone.p);
    const aStream = await streamDurable({ runId, journal: a.view, model: createMockModel(async () => { a.state.failed = true; throw unauthorized(); }), prompt: 'x', maxRetries: 0 } as never);
    const aRead = (async () => { try { for await (const _ of aStream.fullStream) { /* drain */ } } catch { /* the failure */ } })();
    await sleep(200);
    await runDurable({ runId, journal: s.runs, model: createMockModel(async () => finalTextResult('ok')), prompt: 'x' } as never);
    bDone.open();
    await aRead;
    await sleep(100);
    expect(await status(s, runId)).toBe('completed');
  });

  it('control: a newer attempt that fails replaces an older completion; an older completion does not replace a newer failure', async () => {
    const s = await make();
    const runId = `v4-${unique()}`;
    const j = s.runs as never;
    await claimRunOwner(j, runId, STAFF);
    await recordRunOutcome(j, runId, { status: 'completed', at: 1_000, attempt: 1_000 } as never);
    await recordRunOutcome(j, runId, { status: 'failed', at: 3_000, attempt: 2_000, error: 'x' } as never);
    expect(await status(s, runId)).toBe('failed');
    await recordRunOutcome(j, runId, { status: 'completed', at: 4_000, attempt: 1_500 } as never);
    expect(await status(s, runId), 'the completion belongs to an older attempt').toBe('failed');
  });

  it('control: a run that failed is resumed and succeeds — it reads completed', async () => {
    const s = await make();
    const runId = `v5-${unique()}`;
    await runDurable({ runId, journal: s.runs, model: createMockModel(async () => { throw unauthorized(); }), prompt: 'x', maxRetries: 0 } as never).catch(() => undefined);
    expect(await status(s, runId)).toBe('failed');
    await runDurable({ runId, journal: s.runs, model: createMockModel(async () => finalTextResult('ok')), prompt: 'x' } as never);
    expect(await status(s, runId)).toBe('completed');
  });
});
