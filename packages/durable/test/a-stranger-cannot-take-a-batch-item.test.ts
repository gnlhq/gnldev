// A batch item's run (`batch:<batch>:<item>`) is composed by the batch for its caller. Before, a
// stranger who began the item's id first took it: alice's item was refused and her payment ran zero
// times, and purging her batch deleted the stranger's run.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, createGnl } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { createBatch } from '../src/batch.js';
import { user, runOwnerOf } from '../src/run-identity.js';
import { createMockModel, finalTextResult } from './mock.js';

describe.each([
  ['in-memory', () => new InMemoryStorage() as any],
  ['sqlite', () => new SqliteStorage(':memory:') as any],
] as const)('a stranger cannot take a batch item, %s', (_n, make) => {
  it('the stranger is refused; the item runs once for the batch\'s caller', async () => {
    const storage = make();
    const gnl = createGnl({ storage, agents: { w: { model: createMockModel(async () => finalTextResult('w')) } } });
    await expect(gnl.run('w', { runId: 'batch:B:F-1', prompt: 'x', caller: user('mallory') })).rejects.toThrow(/composed by/);
    expect(await storage.runs.listKeys('batch:B:F-1:')).toEqual([]);

    let paid = 0;
    const b = createBatch(storage.runs, {
      tool: { description: 'pay', sideEffect: true, recover: async () => ({ done: false as const }), execute: async () => { paid++; return { paid: true }; } } as never,
      toolName: 'pay', itemKey: (i: any) => i.ref, caller: user('alice'), onDuplicate: 'skip',
    } as never);
    const list = [{ ref: 'F-1', amount: 1 }];
    const p = await b.preflight('B', list);
    await b.run('B', list, { planToken: p.token });
    expect(paid).toBe(1);
    const o: any = await runOwnerOf(storage.runs, 'batch:B:F-1');
    expect(o.state === 'owned' ? o.owner.id : o.state).toBe('alice');
  });
});
