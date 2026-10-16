// An attempt that no longer owns its call writes nothing over it and starts nothing for it.
//
// A call is owned by the attempt whose 'running' stamp its record holds. Thirteen fixes defended that
// rule one write site at a time, and the sites they had not reached still acted for an attempt that had
// lost its call (release audit e-exactly-once, 11 Oct 2026):
//
//   E1  a worker paused between its claim and its body was taken over (the takeover ran the effect), then
//       woke up and ran the body too — 2 executions with no human; under approvalScope 'attempt', one
//       approval and two charges. The heartbeat noticed the loss and only printed a warning.
//   E3  the same paused worker, losing its duplicate marker to the takeover's success, wrote 'suspended'
//       over that success; the result was gone, and approving the question ran the effect again.
//   E4  staleness was judged with the READER's claimTtl, not the one the claim was stamped with: a
//       worker configured with a shorter TTL took over a live, renewed claim — 2 landings.
//   E7  the approval probe read only the run's own tool key; a call under an idempotency window claims
//       under the window's key, so a late "deny" replaced the approval of a call already in its body.
//
// The call's records are now written only through the attempt that holds the claim (compare-and-set over
// its own stamp), the attempt proves it still holds the claim immediately before the body, and one rule
// reads a claim's liveness off the claim's own stamp — for durable-tool and the approval probe alike.
//
// E6 — a pause INSIDE the body longer than the claim TTL — is the lease's residual: no client can stop a
// body that is already running. Pinned below for what CAN be guaranteed: the takeover's record is not
// overwritten by the late attempt, and both bodies saw the same provider idempotencyKey.
//
// Postgres runs when GNL_PG_URL is set.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { durableTool } from '../src/durable-tool.js';
import { InMemoryStorage, type Storage } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { hasRunProbe, resolveApprovals } from '../src/run.js';
import { runKeys } from '../src/journal.js';
import type { DurableCtx, Journal } from '../src/journal.js';

const warns: string[] = [];
beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.map(String).join(' ')); }); });
const ends: Array<() => Promise<unknown>> = [];
afterAll(async () => { for (const e of ends.reverse()) await e(); });

const PG_URL = process.env.GNL_PG_URL;
const STORES: Array<[string, () => Promise<Storage>]> = [
  ['in-memory', async () => new InMemoryStorage()],
  ['sqlite', async () => new SqliteStorage(':memory:')],
];
if (PG_URL) {
  STORES.push(['postgres (real)', async () => {
    const s = new PostgresStorage({ connectionString: PG_URL });
    ends.push(() => s.close());
    return s;
  }]);
}
const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settled = <T>(p: Promise<T>) => p.then((v) => v, (e) => e);
const recordOf = async (journal: Journal, key: string) => (await journal.get(key)) as { status?: string; output?: unknown } | undefined;

/**
 * The journal as ONE worker sees it. `cut()`: that worker is paused or partitioned from the store — every
 * call it makes from then on waits (none fails, none lands) until `heal()`. Other workers are unaffected.
 * `cutAfter(pred)` cuts right after a matching call returns.
 */
function partitioned(journal: Journal) {
  let down: ReturnType<typeof gate> | undefined;
  let after: ((m: string, a: unknown[]) => boolean) | undefined;
  const j = new Proxy(journal as any, {
    get(t, p) {
      const v = t[p];
      if (typeof v !== 'function') return v;
      return async (...a: unknown[]) => {
        while (down) await down.p;
        const r = await v.apply(t, a);
        if (after && after(String(p), a)) { after = undefined; down = gate(); }
        return r;
      };
    },
  }) as Journal;
  return {
    journal: j,
    cut() { down = gate(); },
    cutAfter(pred: (m: string, a: unknown[]) => boolean) { after = pred; },
    heal() { const d = down; down = undefined; d?.open(); },
  };
}

const TTL = 150;
const ctxOf = (journal: Journal, runId: string, more: Record<string, unknown> = {}) => ({ journal, runId, ...more }) as unknown as DurableCtx;
const charge = (tool: object, ctx: DurableCtx, args: object = { amount: 1 }, toolCallId = 'c1') =>
  durableTool(tool as any, ctx, 'charge').execute!(args, { toolCallId } as any);

describe.each(STORES)('an attempt that lost its call writes and starts nothing — %s', (_name, make) => {
  it('E3: a worker paused right after its claim does not write a question over the takeover\'s success', async () => {
    const storage = await make();
    const runId = `r-lost-e3-${unique()}`;
    const key = runKeys.tool(runId, 'c1');
    let executions = 0;
    let landed = false;
    const tool = {
      sideEffect: true, claimTtlMs: TTL,
      recover: async () => (landed ? { done: true as const, output: { chargeId: 'ch_1' } } : { done: false as const }),
      execute: async () => { executions++; landed = true; return { chargeId: `ch_${executions}` }; },
    };
    const A = partitioned(storage.runs);
    A.cutAfter((m, a) => m === 'putIfAbsent' && a[0] === key);
    const a = settled(charge(tool, ctxOf(A.journal, runId)));
    await vi.waitFor(async () => expect((await recordOf(storage.runs, key))?.status).toBe('running'));
    await sleep(TTL * 3);
    // B: a resume of the same run on another worker. The claim is stale; recover() truthfully says "not done".
    const b = await settled(charge(tool, ctxOf(storage.runs, runId)));
    expect(b).toEqual({ chargeId: 'ch_1' });
    A.heal();
    const aOut = await a;
    // A answers from the record the takeover wrote — it neither ran nor asked.
    expect(aOut).toEqual({ chargeId: 'ch_1' });
    expect(await recordOf(storage.runs, key)).toMatchObject({ status: 'succeeded', output: { chargeId: 'ch_1' } });
    // A later resume carrying an approval for c1 replays the success.
    expect(await charge(tool, ctxOf(storage.runs, runId, { approvals: { c1: true } }))).toEqual({ chargeId: 'ch_1' });
    expect(executions).toBe(1);
  });

  it.each([
    ['warn', { limits: { sideEffectDuplicates: 'warn' } }, (k: string) => (m: string, a: unknown[]) => m === 'putIfAbsent' && a[0] === k, false],
    ['approvalScope attempt (approved resume)', { approvals: { c1: true }, limits: { approvalScope: 'attempt' } }, (k: string) => (m: string, a: unknown[]) => m === 'putIfMatch' && a[0] === k, true],
  ] as const)('E1 (%s): a worker paused between its claim and its body never runs the body once the call was taken over', async (_label, extra, cutPred, confirm) => {
    const storage = await make();
    const runId = `r-lost-e1-${unique()}`;
    const key = runKeys.tool(runId, 'c1');
    let executions = 0;
    let landed = false;
    const tool = {
      sideEffect: true, claimTtlMs: TTL, ...(confirm ? { confirm: true } : {}),
      recover: async () => (landed ? { done: true as const, output: { chargeId: 'ch_1' } } : { done: false as const }),
      execute: async () => { executions++; landed = true; return { chargeId: `ch_${executions}` }; },
    };
    if (confirm) {
      await charge(tool, ctxOf(storage.runs, runId));
      expect((await recordOf(storage.runs, key))?.status).toBe('suspended');
    }
    const A = partitioned(storage.runs);
    A.cutAfter(cutPred(key));
    const a = settled(charge(tool, ctxOf(A.journal, runId, extra)));
    await vi.waitFor(async () => expect((await recordOf(storage.runs, key))?.status).toBe('running'));
    await sleep(TTL * 3);
    const b = await settled(charge(tool, ctxOf(storage.runs, runId, extra)));
    expect(b).toEqual({ chargeId: 'ch_1' });
    A.heal();
    expect(await a).toEqual({ chargeId: 'ch_1' });
    expect(executions).toBe(1);
    expect(await recordOf(storage.runs, key)).toMatchObject({ status: 'succeeded', output: { chargeId: 'ch_1' } });
  });

  it("E1 sibling ('args' mode, approved resume): the paused worker meets the window record the takeover finished", async () => {
    const storage = await make();
    const runId = `r-lost-e1a-${unique()}`;
    const key = runKeys.toolRequest(runId, 'charge', '');
    let executions = 0;
    let landed = false;
    const tool = {
      sideEffect: true, idempotency: 'args' as const, confirm: true, claimTtlMs: TTL,
      recover: async () => (landed ? { done: true as const, output: { chargeId: 'ch_1' } } : { done: false as const }),
      execute: async () => { executions++; landed = true; return { chargeId: `ch_${executions}` }; },
    };
    const extra = { approvals: { c1: true }, limits: { approvalScope: 'attempt' } };
    expect(((await charge(tool, ctxOf(storage.runs, runId))) as any)?.__gnl_suspend?.kind).toBe('confirm');
    const A = partitioned(storage.runs);
    A.cutAfter((m, a) => m === 'putIfMatch' && String(a[0]).startsWith(key));
    const a = settled(charge(tool, ctxOf(A.journal, runId, extra)));
    await sleep(TTL * 3);
    expect(await settled(charge(tool, ctxOf(storage.runs, runId, extra)))).toEqual({ chargeId: 'ch_1' });
    A.heal();
    expect(await a).toEqual({ chargeId: 'ch_1' });
    expect(executions).toBe(1);
  });

  it('E1 sibling (lookup): a worker paused inside lookup() past the claim TTL does not start the body afterwards', async () => {
    const storage = await make();
    const runId = `r-lost-e1l-${unique()}`;
    let executions = 0;
    let lookups = 0;
    let landed = false;
    const inLookup = gate();
    const leaveLookup = gate();
    const tool = {
      sideEffect: true, claimTtlMs: TTL,
      recover: async () => (landed ? { done: true as const, output: { chargeId: 'ch_1' } } : { done: false as const }),
      lookup: async () => { if (++lookups === 1) { inLookup.open(); await leaveLookup.p; } return { exists: false as const }; },
      execute: async () => { executions++; landed = true; return { chargeId: `ch_${executions}` }; },
    };
    const A = partitioned(storage.runs);
    const a = settled(charge(tool, ctxOf(A.journal, runId)));
    await inLookup.p;
    A.cut(); // the process stalls: its renewals stop reaching the store
    await sleep(TTL * 3);
    expect(await settled(charge(tool, ctxOf(storage.runs, runId)))).toEqual({ chargeId: 'ch_1' });
    A.heal();
    leaveLookup.open();
    expect(await a).toEqual({ chargeId: 'ch_1' });
    expect(executions).toBe(1);
  });

  it('E3 sibling (a body that returns a question): written only over its own claim', async () => {
    const storage = await make();
    const runId = `r-lost-e3s-${unique()}`;
    const key = runKeys.tool(runId, 'c1');
    let entries = 0;
    const inBodyA = gate();
    const resumeA = gate();
    const tool = {
      sideEffect: true, claimTtlMs: TTL,
      recover: async () => ({ done: false as const }),
      execute: async () => {
        const me = ++entries;
        if (me === 1) { inBodyA.open(); await resumeA.p; return { __gnl_suspend: { toolCallId: 'c1', toolName: 'charge', reason: 'child asks', kind: 'nested' } }; }
        return { chargeId: 'ch_2' };
      },
    };
    const A = partitioned(storage.runs);
    const a = settled(charge(tool, ctxOf(A.journal, runId)));
    await inBodyA.p;
    A.cut();
    await sleep(TTL * 3);
    expect(await settled(charge(tool, ctxOf(storage.runs, runId)))).toEqual({ chargeId: 'ch_2' });
    A.heal();
    resumeA.open();
    await a;
    expect(await recordOf(storage.runs, key)).toMatchObject({ status: 'succeeded', output: { chargeId: 'ch_2' } });
  });

  it('E6 (the lease residual): a worker paused IN its body past the TTL lands too — but never overwrites the takeover\'s record, and both carried one idempotencyKey', async () => {
    const storage = await make();
    const runId = `r-lost-e6-${unique()}`;
    const key = runKeys.tool(runId, 'c1');
    let entries = 0;
    let landings = 0;
    const keys = new Set<string>();
    const inBodyA = gate();
    const resumeA = gate();
    const tool = {
      sideEffect: true, claimTtlMs: TTL,
      recover: async () => (landings > 0 ? { done: true as const, output: { chargeId: 'ch_x' } } : { done: false as const }),
      execute: async (_: unknown, opts: { idempotencyKey: string }) => {
        keys.add(opts.idempotencyKey);
        const me = ++entries;
        if (me === 1) { inBodyA.open(); await resumeA.p; }
        landings++;
        return { chargeId: `ch_${me}` };
      },
    };
    const A = partitioned(storage.runs);
    const a = settled(charge(tool, ctxOf(A.journal, runId)));
    await inBodyA.p;
    A.cut();
    await sleep(TTL * 3);
    const b = await settled(charge(tool, ctxOf(storage.runs, runId)));
    A.heal();
    resumeA.open();
    await a;
    // What a client library cannot prevent: the body was already running.
    expect(landings).toBe(2);
    // What it can: one provider key for both (the downstream fence), and the record keeps the takeover's result.
    expect(keys.size).toBe(1);
    expect(b).toEqual({ chargeId: 'ch_2' });
    expect(await recordOf(storage.runs, key)).toMatchObject({ status: 'succeeded', output: { chargeId: 'ch_2' } });
  });

  it('E4: a worker configured with a shorter claimTtl does not take over a live claim stamped with a longer one', async () => {
    const storage = await make();
    const runId = `r-lost-e4-${unique()}`;
    const key = runKeys.tool(runId, 'c1');
    let entries = 0;
    let landings = 0;
    const finishA = gate();
    const inBodyA = gate();
    const mk = (claimTtlMs: number) => ({
      sideEffect: true, claimTtlMs,
      recover: async () => (landings > 0 ? { done: true as const, output: { chargeId: 'ch_x' } } : { done: false as const }),
      execute: async () => { const me = ++entries; if (me === 1) { inBodyA.open(); await finishA.p; } landings++; return { chargeId: `ch_${me}` }; },
    });
    // v1 (A): claimTtlMs 900, renewed every 300 ms. v2 (B, a rolling deploy): claimTtlMs 100.
    const a = settled(charge(mk(900), ctxOf(storage.runs, runId)));
    await inBodyA.p;
    await sleep(200);
    expect(((await storage.runs.get(key)) as { claimTtlMs?: number }).claimTtlMs).toBe(900);
    const b = await settled(charge(mk(100), ctxOf(storage.runs, runId)));
    expect((b as Error).name).toBe('RunBusyError');
    finishA.open();
    expect(await a).toEqual({ chargeId: 'ch_1' });
    expect(landings).toBe(1);
  });

  it('E4 sibling: the approval probe reads the same stamp — a claim stamped 900 ms is live at 200 ms whatever the run-wide TTL', async () => {
    const storage = await make();
    const runId = `r-lost-e4p-${unique()}`;
    const now = storage.runs.now ? await storage.runs.now() : Date.now();
    await storage.runs.put(runKeys.tool(runId, 'c1'), { status: 'running', startedAt: now - 200, attempts: 1, claimTtlMs: 900, _v: 2 });
    expect(await hasRunProbe(storage.runs, runId, 100)('c1')).toBe(true);
    await storage.runs.put(runKeys.tool(runId, 'c2'), { status: 'running', startedAt: now - 1_000, attempts: 1, claimTtlMs: 900, _v: 2 });
    expect(await hasRunProbe(storage.runs, runId, 60_000)('c2')).toBe(false);
  });

  it("E7: 'args' mode — a late deny arriving while the approved call is in its body does not replace the approval", async () => {
    const storage = await make();
    const runId = `r-lost-e7-${unique()}`;
    let executions = 0;
    const inBody = gate();
    const finish = gate();
    const tool = {
      sideEffect: true, idempotency: 'args' as const, confirm: true, claimTtlMs: 5_000,
      execute: async () => { executions++; inBody.open(); await finish.p; return { ok: executions }; },
    };
    const call = (approvals?: Record<string, boolean>) => charge(tool, ctxOf(storage.runs, runId, { approvals }));
    expect(((await call()) as any)?.__gnl_suspend?.kind).toBe('confirm');
    const approvals1 = await resolveApprovals(storage.runs, runId, { c1: true }, { hasRun: hasRunProbe(storage.runs, runId) });
    const a = settled(call(approvals1));
    await inBody.p;
    expect(await hasRunProbe(storage.runs, runId)('c1')).toBe(true);
    await resolveApprovals(storage.runs, runId, { c1: false }, { hasRun: hasRunProbe(storage.runs, runId) });
    expect(((await storage.runs.get(runKeys.approval(runId, 'c1'))) as { decision?: boolean }).decision).toBe(true);
    finish.open();
    expect(await a).toEqual({ ok: 1 });
    expect(executions).toBe(1);
  });
}, 60_000);
