// A long call keeps the answer it is running on.
//
// A human may change an answer while the call it answers has not happened — and not once it is
// running: a "deny" landing while an approved call is in its body would leave the journal saying
// "denied" over a call that then succeeds. Whether the call is running is read off its claim, fresh or
// stale. The probe judged freshness by the run-wide threshold (30 s, or `timeouts.claimTtlMs`), while
// the call itself is held by ITS threshold — a tool that declares `timeoutMs: 120_000` holds its claim
// for two minutes. Measured: approved, executing for 40 s, a "deny" arrived; the probe read the claim as
// stale, the deny replaced the approval, the call finished — the journal recorded a refusal for a call
// that ran. The claim now carries its own threshold, and the probe reads it from there.
//
// Postgres runs when GNL_PG_URL is set.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { stepCountIs } from 'ai';
import { z } from 'zod';
import { InMemoryStorage, gnlTool, toJournal, type Storage } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { runDurable } from '../src/run.js';
import { runKeys, type Journal } from '../src/journal.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
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

/** The journal with a shared clock the test can move — every worker reads time from it. */
function clocked(inner: Journal) {
  let offset = 0;
  const journal = new Proxy(inner, {
    get(t, p) {
      if (p === 'now') return async () => Date.now() + offset;
      const v = (t as any)[p];
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  return { journal, advance: (ms: number) => { offset += ms; } };
}

describe.each(STORES)('a long call keeps the answer it runs on — %s', (_name, make) => {
  it('a deny arriving 40 s into an approved call that may run for 120 s does not replace the approval', async () => {
    const storage = await make();
    const { journal, advance } = clocked(toJournal(storage.runs));
    const runId = `r-long-${unique()}`;
    let executions = 0;
    const inBody = gate(); const finish = gate();
    const ship = gnlTool({
      description: 'ship', inputSchema: z.object({}).passthrough(),
      execute: async () => { executions++; inBody.open(); await finish.p; return { shipped: true }; },
    }, { sideEffect: true, confirm: true, timeoutMs: 120_000 } as any);
    const model = createMockModel(async ({ prompt }: any) => countToolResults(prompt) === 0 ? toolCallResult('ship', 'c1', {}) : finalTextResult('done'));
    const run = (approvals?: Record<string, boolean>) =>
      runDurable({ runId, journal, model, tools: { ship }, prompt: 'ship it', stopWhen: stepCountIs(4), ...(approvals ? { approvals } : {}) } as any);

    const asked: any = await run();
    expect(asked.interrupts?.[0]?.toolCallId).toBe('c1');
    const approved = run({ c1: true });
    await inBody.p;
    advance(40_000); // 40 s into a call that may take 120 s
    await run({ c1: false }).then((v) => v, (e) => e); // the operator's late "deny"
    finish.open();
    await approved;

    expect(executions).toBe(1);
    expect((await journal.get<{ status?: string }>(runKeys.tool(runId, 'c1')))?.status).toBe('succeeded');
    expect((await journal.get<{ decision?: boolean }>(runKeys.approval(runId, 'c1')))?.decision).toBe(true);
  });

  it('past its own threshold the claim reads as crashed, and the human may still change the answer', async () => {
    const storage = await make();
    const { journal, advance } = clocked(toJournal(storage.runs));
    const runId = `r-stale-${unique()}`;
    await journal.put(runKeys.approval(runId, 'c1'), { v: 1, decision: true, at: 1 });
    const now = await (journal as { now: () => Promise<number> }).now();
    await journal.put(runKeys.tool(runId, 'c1'), { status: 'running', startedAt: now, attempts: 1, claimTtlMs: 120_000, _v: 2 });
    const { resolveApprovals, hasRunProbe } = await import('../src/run.js');
    advance(40_000);
    expect(await hasRunProbe(journal, runId)('c1')).toBe(true); // live by its own 120 s
    advance(90_000);
    expect(await hasRunProbe(journal, runId)('c1')).toBe(false); // 130 s: crashed
    await resolveApprovals(journal, runId, { c1: false }, { hasRun: hasRunProbe(journal, runId) });
    expect((await journal.get<{ decision?: boolean }>(runKeys.approval(runId, 'c1')))?.decision).toBe(false);
  });
}, 60_000);
