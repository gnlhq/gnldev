// A trigger's fire (`sched:<trigger>:<n>`) is composed by the scheduler for the trigger's owner. Before,
// a stranger who began the next fire's id first took it: alice's fire was deferred, retried, and the
// trigger ended `failed` ("belongs to a different subject") without her workflow ever running. The
// same held for a system trigger (`sched:<name>:<n>`, no owner in the id).
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, createGnl, user, runOwnerOf } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { workflow, step } from '@gnldev/workflow';
import { scheduleWorkflow, pollScheduler, listTriggers } from '../src/index.js';

const ownerLabel = async (j: any, id: string) => { const o: any = await runOwnerOf(j, id); return o.state === 'owned' ? `${o.owner.kind}:${o.owner.id ?? ''}` : o.state; };

describe.each([
  ['in-memory', () => new InMemoryStorage() as any],
  ['sqlite', () => new SqliteStorage(':memory:') as any],
] as const)('a stranger cannot take a fire, %s', (_n, make) => {
  for (const owner of ['alice', undefined] as const) {
    it(`${owner ? 'an owned' : 'a system'} trigger: the stranger is refused, the fire runs for its owner`, async () => {
      const storage = make();
      const ran: string[] = [];
      const wf = workflow<{ who: string }>().then(step('s', async (i) => { ran.push(i.who); return { ok: true }; }));
      const gnl: any = createGnl({ storage, workflows: { weekly: wf } } as never);
      const t0 = 1_800_000_000_000;
      const trig = await scheduleWorkflow(storage.runs, { id: 'weekly', name: 'weekly', input: { who: 'OWNER' }, at: t0, ...(owner ? { resourceId: owner } : {}) }, t0 - 10);
      const runId = `sched:${trig}:0`;
      await expect(gnl.runWorkflow('weekly', { who: 'STRANGER' }, { runId, caller: user('mallory') })).rejects.toThrow(/composed by/);
      expect(await storage.runs.listKeys(`${runId}:`)).toEqual([]);

      const out = await pollScheduler(storage.runs, gnl, t0 + 1);
      expect(out.fired).toBe(1);
      expect(ran).toEqual(['OWNER']);
      expect((await listTriggers(storage.runs)).map((t: any) => t.status)).toEqual(['done']);
      if (owner) expect(await ownerLabel(storage.runs, runId)).toBe(`user:${owner}`);
    });
  }
});
