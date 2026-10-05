// A trigger definition with no state was invisible: the poller skipped it and listTriggers dropped it as a
// "partial record", so Studio did not show it either. Measured: 0.9.0 left one for a cron it refused after
// writing the definition ('99 * * * *', 'hello'), and a too-wide purge leaves one for a valid trigger —
// none fired, none was listed. Now an invalid one is failed by the poller with its reason, and a valid one
// is listed as failed with the way out, its repair left to the registration that does it.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { listTriggers, pollScheduler, scheduleWorkflow } from '../src/index.js';

afterEach(() => vi.restoreAllMocks());
const runner = () => { const fired: string[] = []; return { fired, r: { runWorkflow: async (n: string) => { fired.push(n); return { runId: 'x' }; } } as any }; };

describe('a definition without state', () => {
  for (const cron of ['99 * * * *', 'hello']) {
    it(`0.9's invalid cron '${cron}' with no state is failed and shown with its reason; a valid spec for the id replaces it`, async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const j = new InMemoryJournal();
      await j.put('sched:def:t', { name: 'w', kind: 'cron', value: cron, input: {}, maxAttempts: 3 });
      await scheduleWorkflow(j as any, { id: 'n', name: 'neighbour', every: 1_000 }, 999_000);
      const { fired, r } = runner();
      const res = await pollScheduler(j as any, r, 1_000_000);
      expect(res.failed).toBe(1);
      expect(fired).toEqual(['neighbour']);
      const t = (await listTriggers(j as any)).find((x) => x.id === 't');
      expect(t).toMatchObject({ status: 'failed' });
      expect(t?.lastError).toMatch(/cannot fire.*scheduleWorkflow again with a valid spec/s);
      await scheduleWorkflow(j as any, { id: 't', name: 'w', cron: '*/5 * * * *' }, 1_000_000);
      expect((await listTriggers(j as any)).find((x) => x.id === 't')?.status).toBe('pending');
    });
  }

  it('a valid definition whose state was purged is listed as failed with the way out; the poller writes nothing; registration repairs it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const j = new InMemoryJournal();
    await scheduleWorkflow(j as any, { id: 't', name: 'w', every: 60_000 }, 0);
    await j.deletePrefix!('sched:state:t'); // a too-wide purge
    const listed = (await listTriggers(j as any)).find((x) => x.id === 't');
    expect(listed).toMatchObject({ status: 'failed' });
    expect(listed?.lastError).toMatch(/state is missing.*scheduleWorkflow for this id repairs it/s);
    const { fired, r } = runner();
    await pollScheduler(j as any, r, 1_000_000);
    expect(fired).toEqual([]);
    expect(await j.get('sched:state:t')).toBeUndefined(); // left for the registration's repair
    await scheduleWorkflow(j as any, { id: 't', name: 'w', every: 60_000 }, 1_000_000);
    expect((await listTriggers(j as any)).find((x) => x.id === 't')).toMatchObject({ status: 'pending', nextRunAt: 1_060_000 });
  });
});
