import { it, expect, vi } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { workflow, step, waitFor, getWorkflowRunStatus } from '@gnldev/workflow';
import { createWorkflowWaker } from '../../src/index.js';

it('a run that re-suspends within the same millisecond is still woken later', async () => {
  const journal = new InMemoryJournal();
  const runId = 'same-ms';
  let ready = false;
  let afterCalls = 0;
  const wf = workflow<Record<string, never>>()
    .then(waitFor('evt', async () => (ready ? { got: true } : null)))
    .then(step('after', async () => { afterCalls++; return { done: true }; }));
  const frozen = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
  expect((await wf.runResumable({}, { runId, journal })).status).toBe('suspended');
  const waker = createWorkflowWaker({ journal, wakeEvented: true, onError: () => {}, resume: (id) => wf.runResumable({}, { runId: id, journal }) });
  await waker.tick(1_800_000_000_000); // not ready: re-suspends at the same ms
  frozen.mockRestore();
  ready = true;
  const ticks = [];
  for (let i = 0; i < 3; i++) ticks.push(await waker.tick(Date.now() + 60_000));
  console.log('[same-ms]', JSON.stringify({ ticks, afterCalls }));
  expect((await getWorkflowRunStatus(journal, runId))?.status).toBe('completed');
});
