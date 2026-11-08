// KARAR-1 (d25 memory cluster): the edges of "an AgentMemory object is split per organization".
//
// The acceptance tests (packages/server/test/agent-memory-object-*.test.ts) cover the documented shape,
// `new AgentMemory({ storage })` over the config's own storage, on every door. These are the shapes
// they deliberately leave out, where the code picked the SAFE side — refuse, naming `memoryFactory` —
// rather than guess:
//   - an AgentMemory over a DIFFERENT storage than the config's: its threads live where the
//     organization boundary does not reach;
//   - an AgentMemory subclass: rebuilding it as a plain AgentMemory would drop what it adds;
//   - an AgentMemory that is already an organization's;
//   - a journal-only config (no storage to split).
// And the positive control: the split memory keeps its options and lives in the organization's partition.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, scopeConfigToOrg, assertMemorySplitsByOrganization, withOrgStorage, requestRefusal } from '@gnldev/durable';
import { AgentMemory } from '../src/index.js';

const refusal = (fn: () => unknown): { name?: string; code?: string; message: string } | undefined => {
  try { fn(); return undefined; } catch (e) { return e as never; }
};

describe('scopeConfigToOrg splits an AgentMemory object', () => {
  it('positive control: the organization gets a NEW AgentMemory over its own partition, with the same options', async () => {
    const storage = new InMemoryStorage();
    const memory = new AgentMemory({ storage, recentN: 3 });
    const scoped = scopeConfigToOrg({ storage, memory }, 'acme').config as { memory: AgentMemory; storage: unknown };
    expect(scoped.memory).toBeInstanceOf(AgentMemory);
    expect(scoped.memory).not.toBe(memory);
    expect(scoped.memory.storage).toBe(scoped.storage);
    await scoped.memory.append('T', [{ role: 'user', content: 'ACME-ONLY' }]);
    expect(JSON.stringify(await withOrgStorage(storage, 'acme').memory!.getMessages('T', { limit: 10 } as never))).toContain('ACME-ONLY');
    expect(JSON.stringify(await storage.memory!.getMessages('T', { limit: 10 } as never))).not.toContain('ACME-ONLY');
    // recentN survived the rebuild: 5 messages in, 3 out.
    for (let i = 0; i < 4; i++) await scoped.memory.append('T', [{ role: 'user', content: `m${i}` }]);
    expect(await scoped.memory.getMessages('T')).toHaveLength(3);
  });

  const refusedShapes: { name: string; config: () => Record<string, unknown> }[] = [
    { name: 'built over a different storage than the config\'s', config: () => ({ storage: new InMemoryStorage(), memory: new AgentMemory({ storage: new InMemoryStorage() }) }) },
    { name: 'a subclass', config: () => { const storage = new InMemoryStorage(); class Mine extends AgentMemory {} return { storage, memory: new Mine({ storage }) }; } },
    { name: 'already an organization\'s', config: () => { const storage = new InMemoryStorage(); return { storage, memory: new AgentMemory({ storage: withOrgStorage(storage, 'globex') }) }; } },
    { name: 'a journal-only config', config: () => { const storage = new InMemoryStorage(); return { journal: storage.runs, memory: new AgentMemory({ storage }) }; } },
  ];
  for (const shape of refusedShapes) {
    it(`refuses an AgentMemory ${shape.name} — typed, naming memoryFactory, at scoping and at construction alike`, () => {
      const atScope = refusal(() => scopeConfigToOrg(shape.config() as never, 'acme'));
      const atBoot = refusal(() => assertMemorySplitsByOrganization(shape.config() as never));
      for (const e of [atScope, atBoot]) {
        expect(e?.name).toBe('MemoryNotSplittableError');
        expect(e?.code).toBe('memory_not_splittable');
        expect(e?.message).toMatch(/memoryFactory/);
        expect(e?.message).toMatch(/organization/);
        expect(requestRefusal(e)?.status).toBe(500);
      }
    });
  }
});
