// `gnl upgrade` — lists before it runs, runs only what it is told, and writes nothing on a list.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InMemoryStorage, toJournal, THREAD_RECORDS_KEY } from '@gnldev/durable';

const loadConfig = vi.fn();
vi.mock('../src/config.js', () => ({ loadConfig: (...a: unknown[]) => loadConfig(...a) }));

const { upgradeCommand } = await import('../src/commands/upgrade.js');

/** A store as an earlier version left it: a thread with runs, and no owner record or mark. */
async function oldStore() {
  const storage = new InMemoryStorage();
  const j = toJournal(storage.runs);
  await j.put('r1:input', { _v: 1, threadId: 't1', resourceId: 'ayse' });
  await j.put('r1:model:0', { text: 'x' });
  return { storage, j };
}

let logged: string[] = [];
beforeEach(() => {
  logged = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logged.push(a.join(' ')); });
});
afterEach(() => { vi.restoreAllMocks(); loadConfig.mockReset(); });

const run = async (argv: string[], storage: unknown) => {
  loadConfig.mockResolvedValue({ storage });
  await upgradeCommand.run({ argv });
};

describe('gnl upgrade', () => {
  it('--list shows the pending step and what it does, and writes nothing', async () => {
    const { storage, j } = await oldStore();
    await run(['--list'], storage);
    const out = logged.join('\n');
    expect(out).toMatch(/pending/);
    expect(out).toMatch(/thread-records/);
    expect(out).toMatch(/Nothing was written/);
    expect(await j.get(THREAD_RECORDS_KEY)).toBeUndefined();
  });

  it('with no flag runs every pending step; run again, there is nothing left', async () => {
    const { storage, j } = await oldStore();
    await run([], storage);
    expect(logged.join('\n')).toMatch(/ran[\s\S]*thread-records/);
    expect(await j.get(THREAD_RECORDS_KEY)).toBeDefined();
    logged = [];
    await run(['--list'], storage);
    expect(logged.join('\n')).toMatch(/done[\s\S]*thread-records/);
  });

  it('--only names a step this store does not have: refused, naming the ones it has', async () => {
    const { storage } = await oldStore();
    await expect(run(['--only', 'schema'], storage)).rejects.toThrow(/not a step of this store\. Its steps: thread-records/);
  });

  it('a store with no upgrade steps says so', async () => {
    await run([], { name: 'custom' });
    expect(logged.join('\n')).toMatch(/custom: this store has no upgrade steps/);
  });
});
