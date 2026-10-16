// A run id cannot name another run's records (audit A1, A2, A7). Every record family the engine writes
// under a run id — `:model`, `:tool`, and the event log's `:ev` — is refused inside a caller's run id,
// so `x:ev:…` can neither be read back as run x's events nor be deleted with them. Sibling scenarios:
// each family, at the end and in the middle of an id, on every entry point that accepts an id.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, runDurable, streamDurable, assertRunIdSafe } from '../src/index.js';
import { createMockModel, finalTextResult } from './mock.js';

const forbidden = ['x:ev', 'x:ev:1', 'x:ev:0000000500.3', 'a:b:ev:zzz', 'x:model:0', 'x:tool:t1'];
const allowed = ['x', 'x:evening', 'x:events', 'ev:x', 'model:x:input', 'x:y:z'];

describe('a run id cannot name another run\'s records', () => {
  it.each(forbidden)('%s is refused by the gate every entry point calls', (id) => {
    expect(() => assertRunIdSafe(id)).toThrow(/record separator/);
  });
  it.each(allowed)('%s is accepted', (id) => {
    expect(() => assertRunIdSafe(id)).not.toThrow();
  });
  it('runDurable and streamDurable refuse x:ev:… before writing anything', async () => {
    const journal = new InMemoryJournal();
    const model = createMockModel(async () => finalTextResult('hi'));
    await expect(runDurable({ runId: 'x:ev:1', journal, model, prompt: 'p' } as any)).rejects.toThrow(/':ev'/);
    await expect((async () => streamDurable({ runId: 'x:ev:1', journal, model, prompt: 'p' } as any))()).rejects.toThrow(/':ev'/);
    expect(await journal.listKeys('')).toEqual([]);
  });
});
