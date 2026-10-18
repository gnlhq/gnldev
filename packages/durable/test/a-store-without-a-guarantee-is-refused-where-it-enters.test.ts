// Every promise a run keeps rests on its store's guarantees (journal.ts JOURNAL_GUARANTEES). Before, a
// store without one was accepted everywhere and run on a weaker fallback: with no compare-and-set, 20
// workers taking over one expired run lock all won, in 10 of 10 rounds. Now each entry a store is handed
// in through refuses it, naming what it lacks — for every guarantee, at every entry, including a store
// that lacks only that one.
import { describe, it, expect } from 'vitest';
import {
  InMemoryJournal, JOURNAL_GUARANTEES, createGnl, runDurable, streamDurable, toJournal, withOrg, purgeRun, purgeThread,
  sweepRuns, sweepLog, createSuggestions, releaseFailedClaim, listAgentRegistry, readIdemLedger, getNetworkTrace,
  rebuildMetrics, type Journal,
} from '../src/index.js';
import { createMockModel, finalTextResult } from './mock.js';

/** A complete in-memory store with one guarantee taken away. */
function without(missing: string): Journal & Record<string, unknown> {
  const inner = new InMemoryJournal();
  return new Proxy(inner, {
    get(t, k) { if (k === missing) return undefined; const v = Reflect.get(t, k, t); return typeof v === 'function' ? v.bind(t) : v; },
    has(t, k) { return k === missing ? false : Reflect.has(t, k); },
  }) as never;
}
const model = () => createMockModel(async () => finalTextResult('x'));

const ENTRIES: Array<[string, (j: Journal) => unknown]> = [
  ['createGnl', (j) => createGnl({ journal: j, agents: {} } as never)],
  ['runDurable', (j) => runDurable({ runId: 'e1', journal: j, model: model(), prompt: 'x' } as never)],
  ['streamDurable', (j) => streamDurable({ runId: 'e2', journal: j, model: model(), prompt: 'x' } as never)],
  ['toJournal', (j) => toJournal(j as never)],
  ['withOrg', (j) => withOrg(j, 'acme')],
  ['purgeRun', (j) => purgeRun(j, 'r')],
  ['purgeThread', (j) => purgeThread(j, 't')],
  ['sweepRuns', (j) => sweepRuns(j as never, { olderThanMs: 1 })],
  ['sweepLog', (j) => sweepLog(j, 'x', { olderThanMs: 1 })],
  ['createSuggestions', (j) => createSuggestions(j, { generate: false, apply: false } as never)],
  ['releaseFailedClaim', (j) => releaseFailedClaim(j, { toolName: 't', args: {} } as never)],
  ['listAgentRegistry', (j) => listAgentRegistry(j)],
  ['readIdemLedger', (j) => readIdemLedger(j)],
  ['getNetworkTrace', (j) => getNetworkTrace(j, 'r')],
  ['rebuildMetrics', (j) => rebuildMetrics(j, j as never)],
];

/** Runs an entry and returns the refusal's message, or '' when it was not refused. */
async function refusal(enter: () => unknown): Promise<string> {
  try { await enter(); return ''; } catch (e) { return (e as Error).message; }
}

describe('a store without a guarantee is refused where it enters', () => {
  for (const [entry, enter] of ENTRIES) {
    describe(entry, () => {
      for (const missing of JOURNAL_GUARANTEES) {
        it(`without \`${missing}\`: refused, naming it`, async () => {
          const message = await refusal(() => enter(without(missing)));
          expect(message).toContain(`\`${missing}\``);
          expect(message).toMatch(/was handed a store without/);
        });
      }
    });
  }

  it('control: a complete store enters every one of them', async () => {
    for (const [entry, enter] of ENTRIES) {
      const message = await refusal(() => enter(new InMemoryJournal()));
      expect(message, entry).not.toMatch(/was handed a store without/);
    }
  });
});
