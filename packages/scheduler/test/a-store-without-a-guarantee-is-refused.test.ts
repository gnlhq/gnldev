// The scheduler's triggers are run records like any other (two writes in one atomic batch, transitions
// by compare-and-set, fires dated by the store's clock). A journal without one of the store's
// guarantees used to get a plain-put fallback for each; now every entry refuses it, naming what it lacks.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, JOURNAL_GUARANTEES, type Journal } from '@gnldev/durable';
import { scheduleWorkflow, pollScheduler, listTriggers, unscheduleWorkflow, pauseTrigger, resumeTrigger, createWorkflowWaker } from '../src/index.js';

function without(missing: string): Journal {
  const inner = new InMemoryJournal();
  return new Proxy(inner, {
    get(t, k) { if (k === missing) return undefined; const v = Reflect.get(t, k, t); return typeof v === 'function' ? v.bind(t) : v; },
    has(t, k) { return k === missing ? false : Reflect.has(t, k); },
  }) as never;
}
const runner = { runWorkflow: async () => ({ runId: 'x' }) };
const ENTRIES: Array<[string, (j: Journal) => unknown]> = [
  ['scheduleWorkflow', (j) => scheduleWorkflow(j, { id: 'n', name: 'w', every: 60_000 })],
  ['pollScheduler', (j) => pollScheduler(j, runner as never)],
  ['listTriggers', (j) => listTriggers(j)],
  ['unscheduleWorkflow', (j) => unscheduleWorkflow(j, { id: 'n' })],
  ['pauseTrigger', (j) => pauseTrigger(j, { id: 'n' })],
  ['resumeTrigger', (j) => resumeTrigger(j, { id: 'n' })],
  ['createWorkflowWaker', (j) => createWorkflowWaker({ journal: j as never, resume: async () => undefined as never })],
];
const refusal = async (enter: () => unknown) => { try { await enter(); return ''; } catch (e) { return (e as Error).message; } };

describe('the scheduler refuses a store without a guarantee', () => {
  for (const [entry, enter] of ENTRIES) {
    for (const missing of JOURNAL_GUARANTEES) {
      it(`${entry} without \`${missing}\`: refused, naming it`, async () => {
        expect(await refusal(() => enter(without(missing)))).toContain(`\`${missing}\``);
      });
    }
  }
});
