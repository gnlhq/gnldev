// Invariant: an organization's semantic observation recall either answers from that organization's
// vectors or says why it cannot — it never answers "nothing" because the store kept quiet.
//
// The partition check reads `match.namespace`. `omVectors.store` is a structural port, and a custom
// store that does not echo `namespace` on its matches made every hit read as "not this organization's":
// measured before this file, an organization's `recallObservationsSemantic` returned [] with the
// observation right there, and nothing said why.
import { describe, it, expect, vi } from 'vitest';
import { InMemoryStorage, withOrgStorage, VECTOR_PARTITION, type Observation } from '@gnldev/durable';
import { AgentMemory } from '../src/index.js';

const DIMS = ['password', 'weather', 'car'];
const embed = async (text: string): Promise<number[]> => DIMS.map((k) => text.toLowerCase().split(k).length - 1 + 0.01);
const omEmbed = async (texts: string[]) => Promise.all(texts.map(embed));
const obs: Observation = { id: 'obs-0', text: 'the user owns a car', createdAt: 1, sourceIds: ['0'], level: 0, threadId: 't-1', fromSeq: 0, toSeq: 0 };

async function setup(reportsNamespace: boolean) {
  const storage = new InMemoryStorage();
  const acmeStorage = withOrgStorage(storage, 'acme');
  await acmeStorage.memory!.putObservations('t-1', [obs]);
  const root = storage.vectors!;
  // A custom store over the root table: honours the namespace narrowing, but may not report it back.
  const store = {
    upsert: (items: any[]) => root.upsert(items),
    query: async (e: number[], k: number, o?: { namespace?: string }) =>
      (await root.query(e, k, o)).map(({ namespace, ...h }) => (reportsNamespace ? { ...h, namespace } : h)),
  };
  // Written as acme's memory writes it: with acme's grant (`VECTOR_PARTITION`), which the root store requires.
  await store.upsert([{ id: 'org:acme:om:t-1:0:0', namespace: 'org:acme', [VECTOR_PARTITION]: 'org:acme', text: obs.text, embedding: await embed(obs.text), metadata: { source: 'observational-memory', threadId: 't-1', level: 0, obsId: 'obs-0' } }]);
  return new AgentMemory({ storage: acmeStorage, observationalMemory: { enabled: true, observerModel: {} as never, omVectors: { store, embed: omEmbed } } });
}

describe("an organization's semantic recall over a custom observation-vector store", () => {
  it('a store that reports `namespace`: the vector answers', async () => {
    const mem = await setup(true);
    expect((await mem.recallObservationsSemantic('t-1', 'car')).map((o) => o.id)).toEqual(['obs-0']);
  });

  it('a store that does not: recall falls back to the keyword match and says why, once', async () => {
    const mem = await setup(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect((await mem.recallObservationsSemantic('t-1', 'car')).map((o) => o.id)).toEqual(['obs-0']);
      expect((await mem.recallObservationsSemantic('t-1', 'car')).map((o) => o.id)).toEqual(['obs-0']);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toMatch(/namespace/);
    } finally { warn.mockRestore(); }
  });
});

// R5-vec: the root vector store refuses an `org:` namespace from a call without an organization's grant.
// An organization's memory handed the ROOT store labels its observation vectors itself, and carries
// acme's grant — so it keeps writing and recalling them, and the root still cannot name them.
describe("an organization's memory over the root vector store (bundled)", () => {
  it('indexes and recalls its own observation vectors; a root call naming them is refused', async () => {
    const storage = new InMemoryStorage();
    const acmeStorage = withOrgStorage(storage, 'acme');
    await acmeStorage.memory!.putObservations('t-1', [obs]);
    const mem = new AgentMemory({ storage: acmeStorage, observationalMemory: { enabled: true, observerModel: {} as never, omVectors: { store: storage.vectors!, embed: omEmbed } } });
    await (mem as any).indexObservationVector('t-1', 0, 0, obs);
    expect((await mem.recallObservationsSemantic('t-1', 'car')).map((o) => o.id)).toEqual(['obs-0']);
    expect((await storage.vectors!.query(await embed('car'), 5)).map((m) => `${m.namespace}|${m.id}`)).toEqual(['org:acme|org:acme:om:t-1:0:0']);
    await expect(storage.vectors!.query(await embed('car'), 5, { namespace: 'org:acme' })).rejects.toThrow(/withOrgStorage/);
  });
});
