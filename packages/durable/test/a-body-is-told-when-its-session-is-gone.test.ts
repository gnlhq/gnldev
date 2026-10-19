// A tool body is told to stop when its process's liveness session is gone and not back in time.
//
// A process whose session is cut keeps what it holds for `reconnectGraceMs` (a-cut-session-keeps-its-
// call.test.ts). Past that, the others read it as dead and may take its call over — while its body still
// runs: measured, 2 effects (raporlar/2026-10-18-session-cut S1). So half a grace after the process last
// proved its session, the bodies it started get an aborted `abortSignal` (process-liveness.ts
// `sessionSignal`). A body that honours it stops; one that ignores it keeps running — what a client
// library cannot stop, and why a side-effect tool carries the provider's idempotencyKey.
//
// Postgres: the end-to-end cases run when GNL_PG_URL is set.
import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import pg from 'pg';
import { durableTool } from '../src/durable-tool.js';
import { LivenessUnavailableError } from '../src/index.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { bindLiveness, postgresLiveness, procLockKey, sessionSignals, unbindLiveness } from '../src/process-liveness.js';
import type { DurableCtx, Journal } from '../src/journal.js';

const PG_URL = process.env.GNL_PG_URL;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settled = <T>(p: Promise<T>) => p.then((v) => v, (e) => e);
const ends: Array<() => Promise<unknown>> = [];
beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => undefined); });
afterAll(async () => { for (const e of ends.reverse()) await e().catch(() => undefined); });

describe('the session signal', () => {
  it('is aborted half a grace after the last proof, with a retryable reason, and stays so until the next', async () => {
    const s = sessionSignals(200);
    const first = s.signal();
    await sleep(60);
    expect(first.aborted, 'not before half the grace').toBe(false);
    await sleep(80);
    expect(first.aborted).toBe(true);
    expect(first.reason).toBeInstanceOf(LivenessUnavailableError);
    expect(s.signal().aborted, 'a body started while the session is still unproven is told at once').toBe(true);
    s.proven();
    expect(s.signal().aborted, 'a fresh one once it is proven again').toBe(false);
    s.close();
  });

  it('sibling: proofs within half the grace abort nothing', async () => {
    const s = sessionSignals(200);
    const sig = s.signal();
    for (let i = 0; i < 5; i++) { await sleep(50); s.proven(); }
    expect(sig.aborted).toBe(false);
    s.close();
  });
});

describe.skipIf(!PG_URL)('a body whose process cannot get its session back', () => {
  let admin: pg.Client;
  let url: string;
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    ends.push(() => admin.end());
    const db = `sesscutfix_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    await admin.query(`CREATE DATABASE ${db}`);
    ends.push(() => admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`));
    const u = new URL(PG_URL!); u.pathname = `/${db}`; url = u.toString();
  });

  /** A process held off its database: every session that takes its lock is terminated, until `stop()`. */
  const holdOff = (id: string) => {
    let on = true;
    const done = (async () => {
      while (on) {
        await admin.query(
          `SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype = 'advisory' AND ((classid::bigint << 32) | objid::bigint) = $1::bigint AND granted`,
          [procLockKey(id)],
        ).catch(() => undefined);
        await sleep(10);
      }
    })();
    return async () => { on = false; await done; };
  };

  const scenario = async (honours: boolean) => {
    const storage = new PostgresStorage({ connectionString: url });
    ends.push(() => storage.close());
    const liv = await postgresLiveness({ connectionString: url, reconnectGraceMs: 600, heartbeatMs: 150 });
    ends.push(() => liv.close());
    bindLiveness(storage.runs, liv);
    ends.push(async () => unbindLiveness(storage.runs));
    let entered!: () => void;
    const inBody = new Promise<void>((r) => { entered = r; });
    let finished = false;
    const tool = {
      sideEffect: true,
      execute: async (_: unknown, opts: { abortSignal?: AbortSignal }) => {
        entered();
        if (honours) {
          await new Promise((_r, reject) => opts.abortSignal?.addEventListener('abort', () => reject(opts.abortSignal!.reason)));
        } else {
          await sleep(1_500);
        }
        finished = true;
        return { ok: true };
      },
    };
    const ctx = { journal: storage.runs as Journal, runId: `r-sig-${Date.now().toString(36)}` } as unknown as DurableCtx;
    const call = settled(durableTool(tool as any, ctx, 'charge').execute!({}, { toolCallId: 'c1' } as any));
    await inBody;
    const stop = holdOff(liv.id);
    const t0 = performance.now();
    const out = await call;
    const took = performance.now() - t0;
    await stop();
    return { out, took, finished };
  };

  it('a body that honours its abortSignal stops before the grace is out — before anyone may read the process dead', async () => {
    const { out, took, finished } = await scenario(true);
    expect(finished).toBe(false);
    expect(out).toBeInstanceOf(Error);
    // Half a grace after the last proof, which is before the session went: within the 600 ms grace.
    expect(took, 'told within the grace (ms after the session went)').toBeLessThan(600);
  }, 30_000);

  it('sibling: a body that ignores it runs to its end (what no client can stop)', async () => {
    const { out, finished } = await scenario(false);
    expect(finished).toBe(true);
    expect(out).toEqual({ ok: true });
  }, 30_000);
});
