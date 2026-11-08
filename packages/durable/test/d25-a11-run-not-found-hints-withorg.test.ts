// d25 A11 (saga/KARAR-4, option A): a run started under an organization (REST with orgId) lives under `org:<id>:`.
// Handing an operator call the plain root journal (`storage.runs`, as the docs show) answers
// "RunNotFoundError: run 'x' does not exist" with no word about organizations; users concluded the run was lost.
// Option A: the one error says, when the journal it was given is NOT organization-scoped, that a run started under
// an organization is reached with `withOrg(journal, orgId)`. NO automatic organization lookup (option B was
// rejected as an isolation risk) — so the root call still fails, and the hint is the same whether or not such a
// run exists in some organization (the message must not reveal another organization's runs).
import { describe, it, expect } from 'vitest';
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { compensateRun, cancelAgentRun, withOrg, RunNotFoundError } from '../src/index.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

const once = (toolName: string, args: unknown) => createMockModel(async ({ prompt }: any) =>
  countToolResults(prompt) === 0 ? toolCallResult(toolName, 'c' + Math.random().toString(36).slice(2), args) : finalTextResult('done'));
const book = () => {
  const t = tool({ description: 'book', inputSchema: z.object({ id: z.string() }), execute: async () => ({ ok: true }) });
  (t as any).compensate = async () => {};
  return t;
};
async function orgRun(root: InMemoryJournal, runId: string, org = 'yuva') {
  const tools = { book: book() };
  await runDurable({ runId, journal: withOrg(root, org), model: once('book', { id: 'x' }), tools, prompt: 'x', stopWhen: stepCountIs(4) });
  return tools;
}
const failure = (p: Promise<unknown>) => p.then(() => undefined, (e: Error) => e);

describe('A11: RunNotFoundError on a root journal hints at withOrg', () => {
  it('reported — compensateRun(root) on an org run: refused, names withOrg, nothing compensated', async () => {
    const root = new InMemoryJournal();
    const tools = await orgRun(root, 'org-1');
    const e = await failure(compensateRun('org-1', { journal: root, tools }));
    expect(e).toBeInstanceOf(RunNotFoundError);
    expect(e!.message).toMatch(/withOrg/);
    expect(e!.message).toMatch(/organi[sz]ation|orgId/i);
    // control: the org-scoped journal still finds and unwinds it
    const ok = await compensateRun('org-1', { journal: withOrg(root, 'yuva'), tools });
    expect(ok.entries.map((x) => x.status)).toEqual(['compensated']);
  });

  it('sibling — cancelAgentRun(root) on an org run: refused with the same hint, and the run is NOT canceled', async () => {
    const root = new InMemoryJournal();
    await orgRun(root, 'org-2');
    const before = (await root.listKeys('')).sort();
    const e = await failure(cancelAgentRun(root, 'org-2'));
    expect(e).toBeInstanceOf(RunNotFoundError);
    expect(e!.message).toMatch(/withOrg/);
    expect((await root.listKeys('')).sort(), 'no automatic org lookup: nothing written').toEqual(before);
  });

  it('sibling — a run that exists nowhere gets the very same message (no lookup, no existence oracle)', async () => {
    const root = new InMemoryJournal();
    await orgRun(root, 'org-3');
    const inOrg = await failure(compensateRun('org-3', { journal: root, tools: { book: book() } }));
    const nowhere = await failure(compensateRun('org-4', { journal: root, tools: { book: book() } }));
    expect(nowhere).toBeInstanceOf(RunNotFoundError);
    expect(nowhere!.message).toMatch(/withOrg/);
    expect(nowhere!.message.replace('org-4', 'X')).toBe(inOrg!.message.replace('org-3', 'X'));
  });

  it('negative — the journal is already organization-scoped: no withOrg hint (it would point the wrong way)', async () => {
    const root = new InMemoryJournal();
    await orgRun(root, 'org-5', 'yuva');
    const e = await failure(compensateRun('org-5', { journal: withOrg(root, 'other'), tools: { book: book() } }));
    expect(e).toBeInstanceOf(RunNotFoundError);
    expect(e!.message).not.toMatch(/withOrg/);
  });
});
