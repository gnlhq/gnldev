// Every options object @gnldev/scheduler reads refuses a name it does not take (@gnldev/options),
// naming the option it is closest to: a misspelled `tz` would otherwise fire a cron in UTC.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { scheduleWorkflow, pollScheduler, createScheduler, moveTrigger, createWorkflowWaker } from '../src/index.js';

const runner: any = { runWorkflow: async () => ({ runId: 'x' }) };

describe('@gnldev/scheduler: a misspelled option is refused', () => {
  it.each([
    ['scheduleWorkflow', () => scheduleWorkflow(new InMemoryJournal() as any, { name: 'w', cron: '0 9 * * *', timezone: 'Europe/Istanbul' } as any), /scheduleWorkflow: `timezone` is not an option/],
    ['scheduleWorkflow every', () => scheduleWorkflow(new InMemoryJournal() as any, { name: 'w', evry: 1000 } as any), /scheduleWorkflow: `evry` .* did you mean `every`\?/],
    ['pollScheduler', () => pollScheduler(new InMemoryJournal() as any, runner, 1, { lockTTLMs: 5 } as any), /pollScheduler: `lockTTLMs` .* did you mean `lockTtlMs`\?/],
    ['createScheduler', () => createScheduler(new InMemoryJournal() as any, runner, { pollMS: 5 } as any), /createScheduler: `pollMS` .* did you mean `pollMs`\?/],
    ['moveTrigger', () => moveTrigger(new InMemoryJournal() as any, 'id', { orgID: 'a' } as any), /moveTrigger: `orgID` .* did you mean `orgId`\?/],
    ['createWorkflowWaker', () => createWorkflowWaker({ journal: new InMemoryJournal() as any, resume: async () => undefined, intervalMS: 5 } as any), /createWorkflowWaker: `intervalMS` .* did you mean `intervalMs`\?/],
  ])('%s', async (_n, build, message) => {
    await expect((async () => build())()).rejects.toThrow(message);
  });
});
