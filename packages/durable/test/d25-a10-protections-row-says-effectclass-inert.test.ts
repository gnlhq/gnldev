// d25 A10 (saga/KARAR-7, option A): without a preset the startup protections table said
// `dedup profile: none — declarations inert`. A reader took that to mean every duplicate declaration does nothing
// (03-seyahat switched to `critical` for it). Measured: `semanticIdentity` + `resourceId` without a preset DOES ask
// on a repeat from another thread (pinned below as the evidence the new wording rests on). Only `effectClass` is
// inert without a profile — the row's own note already says so. Option A narrows the value to say exactly that.
//
// The exact wording is the code's to choose ("`none — effectClass inert` gibi"); the test requires the row to name
// `effectClass` as the inert thing and to stop saying "declarations inert".
import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { InMemoryJournal, createGnl, describeProtections, formatProtections } from '../src/index.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

afterEach(() => vi.restoreAllMocks());
const dedupRow = (rows: any[]) => rows.find((r) => r.id === 'dedup');

describe('A10: the no-preset dedup row names only effectClass as inert', () => {
  it('describeProtections: the row value', () => {
    const row = dedupRow(describeProtections({ journal: new InMemoryJournal() }) as any[]);
    expect(row.mark).toBe('off');
    expect(row.value).toMatch(/effectClass/);
    expect(row.value).toMatch(/inert/);
    expect(row.value).not.toMatch(/declarations inert/);
  });
  it('sibling — the printed table (formatProtections) says the same', () => {
    const text = String(formatProtections(describeProtections({ journal: new InMemoryJournal() })));
    expect(text).not.toMatch(/declarations inert/);
    expect(text).toMatch(/effectClass inert|effectClass[^\n]*inert/);
  });
  it('control — with a preset the row is unchanged', () => {
    expect(dedupRow(describeProtections({ journal: new InMemoryJournal(), preset: 'assistant' }) as any[])).toMatchObject({ mark: 'on', value: 'assistant' });
  });
});

describe('A10 evidence (green on 0.17.1): semanticIdentity is NOT inert without a preset', () => {
  it('no preset + semanticIdentity + resourceId: the same order from another thread is asked, not run again', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ran: number[] = [];
    const model = createMockModel(async ({ prompt }: any) => countToolResults(prompt) === 0 ? toolCallResult('createOrder', 'c' + Math.random().toString(36).slice(2), { ref: 'INV-1' }) : finalTextResult('done'));
    const gnl = createGnl({ journal: new InMemoryJournal(), agents: { shop: { model, tools: { createOrder: { sideEffect: true, semanticIdentity: { keys: ['ref'] }, inputSchema: z.any(), execute: async () => { ran.push(1); return { ok: true }; } } } } as any } } as any);
    await gnl.run('shop', { runId: 'a10-1', threadId: 'T1', resourceId: 'u', prompt: 'order' } as any);
    const r2: any = await gnl.run('shop', { runId: 'a10-2', threadId: 'T2', resourceId: 'u', prompt: 'order' } as any);
    expect(ran.length).toBe(1);
    expect((r2.interrupts ?? []).length).toBe(1);
  });
});
