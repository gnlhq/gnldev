// d25 P2 madde 6 (identity/KARAR-2): 'cross-run' stays GLOBAL inside an org by default — the person is NOT
// in the key (two people, same input, same org: the work runs once). A developer who wants "person + thing"
// builds it in the key function from the call context (needs madde 5: identityOf in idempotencyKey).
//
// Controls (green before and after) pin the default; the developer-key tests are red until the key
// function can see the caller.
import { describe, it, expect } from 'vitest';
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import * as durable from '../src/index.js';
import { InMemoryJournal } from '../src/journal.js';
import { withOrg } from '../src/organization.js';
import { runDurable } from '../src/run.js';
import { identityOf, userIdOf } from '../src/run-identity.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

const callsOnce = (id: string) => createMockModel(async ({ prompt }: any) => {
  const lastUser = prompt.map((m: any) => m.role).lastIndexOf('user');
  return countToolResults(prompt.slice(lastUser)) === 0 ? toolCallResult('book', id, { slot: 'sat' }) : finalTextResult('done');
});

function bookTool(state: { runs: number; keys: string[] }, key?: (i: any, o?: unknown) => string) {
  return durable.gnlTool(tool({
    description: 'b', inputSchema: z.object({ slot: z.string() }),
    execute: async (_i, o) => { state.runs++; state.keys.push((o as any).idempotencyKey); return { ok: true }; },
  }), { sideEffect: true, idempotencyWindow: 'cross-run', idempotencyKey: key ?? ((i: any) => i.slot) } as any);
}
const go = (journal: InMemoryJournal, org: string, who: string, runId: string, book: unknown, id: string) =>
  runDurable({ runId, journal: withOrg(journal, org), model: callsOnce(id), tools: { book } as any, prompt: 'x', stopWhen: stepCountIs(4), resourceId: who } as any).catch((e) => e);

describe('P2-6 default scope (control: unchanged by the fix)', () => {
  it('inside one org, two people with the same business key: the work runs ONCE', async () => {
    const state = { runs: 0, keys: [] as string[] };
    const book = bookTool(state); const j = new InMemoryJournal();
    await go(j, 'org-1', 'ayse', 'r-ayse', book, 'a1');
    await go(j, 'org-1', 'mehmet', 'r-mehmet', book, 'a2');
    expect(state.runs).toBe(1);
  });

  it('the provider key does not carry the person (same org, two people: identical key if it ran twice)', async () => {
    const state = { runs: 0, keys: [] as string[] };
    const book = bookTool(state); const j = new InMemoryJournal();
    await go(j, 'org-1', 'ayse', 'r-ayse', book, 'a1');
    await go(new InMemoryJournal(), 'org-1', 'mehmet', 'r-mehmet', book, 'a2');
    expect(state.keys).toHaveLength(2);
    expect(state.keys[0]).toBe(state.keys[1]);
    expect(state.keys.join('|')).not.toMatch(/ayse|mehmet/);
  });

  it('two ORGS with the same business key both run (the org is in the scope)', async () => {
    const state = { runs: 0, keys: [] as string[] };
    const book = bookTool(state); const j = new InMemoryJournal();
    await go(j, 'org-1', 'ayse', 'r1', book, 'a1');
    await go(j, 'org-2', 'ayse', 'r2', book, 'a2');
    expect(state.runs).toBe(2);
    expect(state.keys[0]).not.toBe(state.keys[1]);
  });
});

describe('P2-6 opt-in: the developer adds the person in the key function', () => {
  const personKey = (i: any, o?: unknown) => `${userIdOf(identityOf(o)) ?? 'nobody'}:${i.slot}`;

  it('person+slot: Ayse and Mehmet (same org, same slot) both book', async () => {
    const state = { runs: 0, keys: [] as string[] };
    const book = bookTool(state, personKey); const j = new InMemoryJournal();
    await go(j, 'org-1', 'ayse', 'r-ayse', book, 'a1');
    await go(j, 'org-1', 'mehmet', 'r-mehmet', book, 'a2');
    expect(state.runs).toBe(2);
    expect(state.keys[0]).not.toBe(state.keys[1]);
  });

  it('person+slot: the same person asking again in a new run is still deduplicated', async () => {
    const state = { runs: 0, keys: [] as string[] };
    const book = bookTool(state, personKey); const j = new InMemoryJournal();
    await go(j, 'org-1', 'ayse', 'r-1', book, 'a1');
    await go(j, 'org-1', 'ayse', 'r-2', book, 'a2');
    expect(state.runs).toBe(1);
    // behaviour, not key format: the same person on a fresh journal gets the SAME provider key, another person a DIFFERENT one
    const probe = { runs: 0, keys: [] as string[] };
    await go(new InMemoryJournal(), 'org-1', 'ayse', 'r-3', bookTool(probe, personKey), 'a3');
    await go(new InMemoryJournal(), 'org-1', 'mehmet', 'r-4', bookTool(probe, personKey), 'a4');
    expect(probe.keys[0]).toBe(state.keys[0]);
    expect(probe.keys[1]).not.toBe(state.keys[0]);
  });

  it('person+slot: a different org is still separate (the key function sees the person there too)', async () => {
    const state = { runs: 0, keys: [] as string[] };
    const book = bookTool(state, personKey);
    const j = new InMemoryJournal();
    await go(j, 'org-1', 'ayse', 'r1', book, 'a1');
    await go(j, 'org-2', 'ayse', 'r2', book, 'a2');
    expect(state.runs).toBe(2);
    expect(state.keys[0]).not.toBe(state.keys[1]);
    // the person is in the key: another person in the same org gets a different provider key
    const probe = { runs: 0, keys: [] as string[] };
    await go(new InMemoryJournal(), 'org-1', 'mehmet', 'r3', bookTool(probe, personKey), 'a3');
    expect(probe.keys[0]).not.toBe(state.keys[0]);
  });
});
