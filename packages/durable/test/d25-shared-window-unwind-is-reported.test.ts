// d25 karar-1 (saga, A): compensateRun a wide-window ('thread' / 'cross-run') tool step is never skipped
// silently. It is reported under its OWN status (not one of the existing ones), carrying the identity of
// the shared record and whether THIS run executed it — and it is NOT auto-compensated (the hook is never
// called: another run may have answered from the same record).
//
// The exact status string and field names are NOT pinned: the status must differ from every existing
// status, the record's key must be findable in the entry, and "this run did it" must be a boolean that
// differs between the run that executed and the run that only answered.
import { describe, it, expect } from 'vitest';
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { InMemoryJournal } from '../src/journal.js';
import { providerIdOf } from '../src/call-identity.js';
import { runDurable } from '../src/run.js';
import { withOrg } from '../src/organization.js';
import { compensateRun } from '../src/compensation.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

const EXISTING = ['compensated', 'already-compensated', 'would-compensate', 'failed', 'busy', 'uncertain', 'not-attempted', 'skipped-no-hook', 'skipped-not-executed'];

function sagaTools(window: 'run' | 'thread' | 'cross-run', refunds: string[]) {
  const startRental = tool({ description: 'start', inputSchema: z.object({ id: z.string() }), execute: async () => ({ rental: 'r1' }) });
  (startRental as any).compensate = async () => void refunds.push('startRental');
  const withdrawDeposit = tool({ description: 'deposit', inputSchema: z.object({ id: z.string() }), execute: async () => ({ deposit: 'held' }) });
  (withdrawDeposit as any).idempotencyKey = (a: { id: string }) => `dep-${a.id}`;
  (withdrawDeposit as any).idempotencyWindow = window;
  (withdrawDeposit as any).compensate = async () => void refunds.push('withdrawDeposit');
  return { startRental, withdrawDeposit };
}
const sagaModel = () => createMockModel(async ({ prompt }: any) => {
  const done = countToolResults(prompt);
  if (done === 0) return toolCallResult('startRental', 'c-start', { id: 'k1' });
  if (done === 1) return toolCallResult('withdrawDeposit', 'c-dep', { id: 'k1' });
  return finalTextResult('Done.');
});

/** every boolean value anywhere inside an entry (field-name agnostic) */
const booleansOf = (v: unknown): boolean[] =>
  typeof v === 'boolean' ? [v] : v && typeof v === 'object' ? Object.values(v as object).flatMap(booleansOf) : [];
const dep = (r: { entries: any[] }) => r.entries.find((e) => e.toolName === 'withdrawDeposit');
const isReportedShared = (e: any) => !!e && !EXISTING.includes(e.status);

describe('d25/saga-1 — a shared-window step is reported, never silent, never auto-undone', () => {
  for (const window of ['thread', 'cross-run'] as const) {
    it(`'${window}': the deposit step is IN the report under a new status, with the record's key and executed-here=true`, async () => {
      const journal = new InMemoryJournal(); const refunds: string[] = [];
      const tools = sagaTools(window, refunds);
      await runDurable({ runId: `s-${window}`, threadId: 't-1', journal, model: sagaModel(), tools, prompt: 'x', stopWhen: stepCountIs(6) });
      const report = await compensateRun(`s-${window}`, { journal, tools });
      const e = dep(report);
      expect(e, JSON.stringify(report.entries)).toBeDefined();
      expect(isReportedShared(e), `status '${e?.status}' is one of the existing ones`).toBe(true);
      expect(providerIdOf(e.toolCallId)).toBe('c-dep');
      expect(JSON.stringify(e), 'the shared record identity is not in the entry').toMatch(window === 'thread' ? /xthr:t-1:[^"]*withdrawDeposit/ : /xrun:[^"]*withdrawDeposit/);
      expect(booleansOf(e)).toContain(true);
      // negative control: the hook is NOT called for the shared step; the 'run'-scoped step is undone as before.
      expect(refunds).toEqual(['startRental']);
      expect(report.entries.find((x) => x.toolName === 'startRental')?.status).toBe('compensated');
    });
  }

  it('the report is the same on a second call, and still no auto-refund (idempotent)', async () => {
    const journal = new InMemoryJournal(); const refunds: string[] = [];
    const tools = sagaTools('cross-run', refunds);
    await runDurable({ runId: 'again', journal, model: sagaModel(), tools, prompt: 'x', stopWhen: stepCountIs(6) });
    await compensateRun('again', { journal, tools });
    const second = await compensateRun('again', { journal, tools });
    expect(isReportedShared(dep(second)), JSON.stringify(second.entries)).toBe(true);
    expect(refunds).toEqual(['startRental']);
  });

  it('dryRun previews the shared step too, and calls no hook', async () => {
    const journal = new InMemoryJournal(); const refunds: string[] = [];
    const tools = sagaTools('thread', refunds);
    await runDurable({ runId: 'dry', threadId: 't-1', journal, model: sagaModel(), tools, prompt: 'x', stopWhen: stepCountIs(6) });
    const report = await compensateRun('dry', { journal, tools, dryRun: true });
    expect(isReportedShared(dep(report)), JSON.stringify(report.entries)).toBe(true);
    expect(report.entries.find((x) => x.toolName === 'startRental')?.status).toBe('would-compensate');
    expect(refunds).toEqual([]);
  });

  it('an organization-scoped journal (withOrg) reports it the same way', async () => {
    const journal = withOrg(new InMemoryJournal(), 'yuva'); const refunds: string[] = [];
    const tools = sagaTools('thread', refunds);
    await runDurable({ runId: 'orgrun', threadId: 't-9', journal, model: sagaModel(), tools, prompt: 'x', stopWhen: stepCountIs(6) });
    const report = await compensateRun('orgrun', { journal, tools });
    expect(isReportedShared(dep(report)), JSON.stringify(report.entries)).toBe(true);
    expect(refunds).toEqual(['startRental']);
  });

  it("a run that only ANSWERED from another run's record is told apart (executed-here=false), identity still present", async () => {
    const journal = new InMemoryJournal(); const refunds: string[] = [];
    const tools = sagaTools('cross-run', refunds);
    let executions = 0;
    const orig = (tools.withdrawDeposit as any).execute;
    (tools.withdrawDeposit as any).execute = async (...a: unknown[]) => { executions++; return orig(...a); };
    await runDurable({ runId: 'a', journal, model: sagaModel(), tools, prompt: 'x', stopWhen: stepCountIs(6) });
    await runDurable({ runId: 'b', journal, model: sagaModel(), tools, prompt: 'x', stopWhen: stepCountIs(6) });
    expect(executions).toBe(1);
    const ea = dep(await compensateRun('a', { journal, tools: sagaTools('cross-run', []) }));
    const eb = dep(await compensateRun('b', { journal, tools }));
    expect(isReportedShared(eb), JSON.stringify(eb)).toBe(true);
    expect(JSON.stringify(eb)).toMatch(/xrun:[^"]*withdrawDeposit/);
    expect(booleansOf(eb)).toContain(false);
    expect(booleansOf(eb)).not.toContain(true);
    expect(booleansOf(ea)).toContain(true);
    expect(refunds).toEqual(['startRental']);
  });
});

describe("d25/saga-1 — sibling: a 'run'-window step is undone exactly as before (regression)", () => {
  it("'run' window: compensated normally, hook called, no shared status", async () => {
    const journal = new InMemoryJournal(); const refunds: string[] = [];
    const tools = sagaTools('run', refunds);
    await runDurable({ runId: 'r', threadId: 't-1', journal, model: sagaModel(), tools, prompt: 'x', stopWhen: stepCountIs(6) });
    const report = await compensateRun('r', { journal, tools });
    expect(dep(report)?.status).toBe('compensated');
    expect(refunds.sort()).toEqual(['startRental', 'withdrawDeposit']);
  });
});
