// d25 A12 (saga/KARAR-3, option A): the saga page's example `compensateRun(id, { journal: storage.runs })` must
// compile. Operator functions were typed `Journal & Partial<JournalReader>` (the old journal, list = array), and
// `storage.runs` is a `RunJournal` (list = pages): TS2322/TS2345 on the docs' own example, although it ran fine.
// Option A: ONE operator journal type that accepts the old journal OR `storage.runs`, used by every operator
// function the decision lists (compensation, retention, model, budget).
//
// Type-level, so it runs the compiler (vitest does not type-check): each snippet is compiled as a user's file
// against the published declarations (dist) — red = compile errors. Measured on release/0.17.1 before writing:
// compensateRun, sweepRuns, purgeRun, createRetentionSweeper, recordRunUsage refuse `storage.runs`; the rest of
// the retention family, cancelAgentRun, withOrg and assertNoRunsInFlight already accept it (kept as controls).
//
// Left out on purpose (not in the decision's list, see report): forkRun (`Journal & JournalReader`, time-travel.ts)
// also refuses `storage.runs`. Whether a whole `Storage` should be accepted too is also not tested.
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { typeDiagnostics, mutate, type TypeDiagnostic } from '../../../test/support/type-diagnostics.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { createGnl, sweepRuns, toJournal } from '../src/index.js';
import { createMockModel, finalTextResult } from './mock.js';

const COMPILE_TIMEOUT = 120_000;
const HEAD = `import * as d from '@gnldev/durable';
import { compensateRun, type Storage } from '@gnldev/durable';
declare const storage: Storage;
export async function main() {
`;
const snippet = (body: string) => `${HEAD}${body}\n}\n`;

const DOC_EXAMPLE = snippet(`  const r = await compensateRun('order-7', { journal: storage.runs, tools: {} });\n  return r.entries;`);

const MUST_ACCEPT: Record<string, string> = {
  docExample: DOC_EXAMPLE,
  sweepRuns: snippet(`  await d.sweepRuns(storage.runs, { olderThanMs: 1 });`),
  purgeRun: snippet(`  await d.purgeRun(storage.runs, 'r');`),
  createRetentionSweeper: snippet(`  d.createRetentionSweeper(storage.runs, {} as Parameters<typeof d.createRetentionSweeper>[1]);`),
  recordRunUsage: snippet(`  await d.recordRunUsage(storage.runs, 'r');`),
};
const CONTROLS: Record<string, string> = {
  cancelAgentRun: snippet(`  await d.cancelAgentRun(storage.runs, 'r');`),
  withOrg: snippet(`  d.withOrg(storage.runs, 'acme');`),
  purgeThreadState: snippet(`  await d.purgeThreadState(storage.runs, 't');`),
  assertNoRunsInFlight: snippet(`  await d.assertNoRunsInFlight(storage.runs);`),
  // the old journal type keeps working (the accepted type widens, nothing narrows)
  oldJournal: snippet(`  const j = new d.InMemoryJournal();\n  await compensateRun('r', { journal: j, tools: {} });\n  await d.sweepRuns(j, { olderThanMs: 1 });\n  await d.purgeRun(j, 'r');`),
  toJournalWrapper: snippet(`  const j = d.toJournal(storage.runs);\n  await compensateRun('r', { journal: j, tools: {} });`),
};
const NEGATIVE: Record<string, string> = {
  // not a journal at all: still refused, with an assignability error (not a missing import)
  notAJournal: mutate(DOC_EXAMPLE, 'journal: storage.runs', 'journal: { kind: "mysql" }'),
};

let d: Record<string, TypeDiagnostic[]>;
beforeAll(() => { d = typeDiagnostics(__dirname, { ...MUST_ACCEPT, ...CONTROLS, ...NEGATIVE }); }, COMPILE_TIMEOUT);
const fmt = (x: TypeDiagnostic[]) => x.map((e) => `TS${e.code}: ${e.message.split('\n')[0]}`);

describe('A12: operator functions accept storage.runs (compiled against dist)', () => {
  for (const k of Object.keys(MUST_ACCEPT)) it(`${k} compiles`, () => { expect(fmt(d[k]!)).toEqual([]); });
});
describe('A12 controls (green on 0.17.1)', () => {
  for (const k of Object.keys(CONTROLS)) it(`${k} compiles`, () => { expect(fmt(d[k]!)).toEqual([]); });
  it('a value that is not a journal is still refused (TS2322/TS2353)', () => {
    expect(d.notAJournal!.map((e) => e.code).some((c) => c === 2322 || c === 2353 || c === 2345), fmt(d.notAJournal!).join('\n')).toBe(true);
  });
});

describe('A12 runtime: storage.runs handed straight to an operator function does what toJournal(storage.runs) does', () => {
  afterEach(() => vi.restoreAllMocks());
  it('sweepRuns(storage.runs) purges the same old run as through toJournal', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const make = async () => {
      const storage = new SqliteStorage(':memory:');
      const gnl = createGnl({ storage, agents: { a: { model: createMockModel(async () => finalTextResult('ok')) } } } as any);
      await gnl.run('a', { runId: 'old-1', prompt: 'x' } as any);
      return storage;
    };
    const s1 = await make();
    const s2 = await make();
    const later = Date.now() + 60_000;
    const direct = await sweepRuns(s1.runs as any, { olderThanMs: 1, now: later } as any);
    const wrapped = await sweepRuns(toJournal(s2.runs), { olderThanMs: 1, now: later } as any);
    expect(wrapped.purged).toEqual(['old-1']); // control: the documented wrapper works
    expect(direct.purged).toEqual(wrapped.purged);
  });
});
