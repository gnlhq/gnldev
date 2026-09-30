// ADR-0001: "In the root scope, every organization's rows are hidden."
//
// An organization's memory is the root store seen through `withOrgStorage`, so its rows sit physically
// in the root under `org:<id>:`. A resource id is a user of ONE scope, and an identity provider that
// sometimes binds an organization and sometimes does not hands the same `u-shared` to both. Measured
// before the fix: a root-scope turn of `u-shared` with `scope: 'resource'` recall got acme's message in
// its prompt, because the store's resource branch filtered by resource id alone. The org -> org
// direction was already closed by the org view; nothing closed root -> org.
//
// These drive the memory the engine drives (`getMessages` is what `composeTrack1` sits behind), over
// both local engines, and pin the resource-keyed siblings: working memory, observations, and the
// observation vectors.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, withOrgStorage, type Storage, type Observation } from '@gnldev/durable';
import { SqliteStorage } from '../../durable/src/sqlite-storage.js';
import { AgentMemory } from '../src/index.js';

const SECRET = 'ACME-SECRET-42';
const DIMS = ['password', 'weather', 'car'];
const embed = async (text: string): Promise<number[]> => {
  const t = text.toLowerCase();
  return DIMS.map((k) => t.split(k).length - 1 + 0.01);
};
const u = (content: string) => ({ role: 'user', content });

const engines: [string, () => Storage][] = [
  ['InMemoryStorage', () => new InMemoryStorage()],
  ['SqliteStorage', () => new SqliteStorage(':memory:') as unknown as Storage],
];

for (const [name, make] of engines) {
  describe(`root scope vs organization rows (${name})`, () => {
    it('resource-scoped recall of a root thread does not return an organization\'s message for the same user id', async () => {
      const storage = make();
      const acme = new AgentMemory({ storage: withOrgStorage(storage, 'acme'), embed, recentN: 1 });
      const root = new AgentMemory({ storage, embed, recentN: 1 });
      await acme.createThread({ id: 't-acme', resourceId: 'u-shared' });
      await acme.append('t-acme', [u(`my secret password is ${SECRET}`)]);
      await root.createThread({ id: 't-root', resourceId: 'u-shared' });
      await root.append('t-root', [u('hello'), u('weather today')]);

      const msgs = await root.getMessages('t-root', { query: 'what is my password', resourceId: 'u-shared', scope: 'resource' });
      expect(JSON.stringify(msgs)).not.toContain(SECRET);
    });

    it('CONTROL: the organization still recalls its own message across its own threads', async () => {
      const storage = make();
      const acme = new AgentMemory({ storage: withOrgStorage(storage, 'acme'), embed, recentN: 1 });
      await acme.createThread({ id: 't-1', resourceId: 'u-shared' });
      await acme.append('t-1', [u(`my secret password is ${SECRET}`)]);
      await acme.createThread({ id: 't-2', resourceId: 'u-shared' });
      await acme.append('t-2', [u('hello'), u('weather today')]);
      const msgs = await acme.getMessages('t-2', { query: 'what is my password', resourceId: 'u-shared', scope: 'resource' });
      expect(JSON.stringify(msgs)).toContain(SECRET);
    });

    it('CONTROL: the root still recalls its own message across its own threads', async () => {
      const storage = make();
      const root = new AgentMemory({ storage, embed, recentN: 1 });
      await root.createThread({ id: 't-1', resourceId: 'u-shared' });
      await root.append('t-1', [u('ROOT password is 7')]);
      await root.createThread({ id: 't-2', resourceId: 'u-shared' });
      await root.append('t-2', [u('hello'), u('weather today')]);
      const msgs = await root.getMessages('t-2', { query: 'what is my password', resourceId: 'u-shared', scope: 'resource' });
      expect(JSON.stringify(msgs)).toContain('ROOT password is 7');
    });

    it('SIBLING: a person\'s working memory (resource scope) in acme is not the root person\'s', async () => {
      const storage = make();
      const cfg = { workingMemory: { scope: 'resource' as const } };
      const acme = new AgentMemory({ storage: withOrgStorage(storage, 'acme'), ...cfg });
      const root = new AgentMemory({ storage, ...cfg });
      await acme.applyWorkingMemoryUpdate('t-acme', { secret: SECRET }, 'u-shared');
      const merged = await root.applyWorkingMemoryUpdate('t-root', { note: 'root' }, 'u-shared');
      expect(merged).toEqual({ note: 'root' });
    });

    it('SIBLING: observations are per thread — a root thread with the same id as acme\'s holds none of acme\'s', async () => {
      const storage = make();
      const obs: Observation = { id: 'obs-0', text: SECRET, createdAt: 1, sourceIds: ['0'], level: 0 };
      await withOrgStorage(storage, 'acme').memory!.putObservations('t-1', [obs]);
      const root = new AgentMemory({ storage });
      expect(await root.recallObservations('t-1', 'ACME')).toEqual([]);
    });

    it('SIBLING: root semantic observation recall is not ranked by an organization\'s observation vectors', async () => {
      // Observation ids are per thread (`obs-0`, `obs-1`, …), so acme's `t-1` and the root's `t-1` both
      // have an `obs-0`. A root query over the whole vector table used to take acme's vector as the
      // best match and answer with the root's unrelated `obs-0` — acme's content steering the root's
      // answer, and telling the root user acme had written about it.
      const storage = make();
      const omEmbed = async (texts: string[]) => Promise.all(texts.map(embed));
      const model = {} as never;
      const acmeStorage = withOrgStorage(storage, 'acme');
      const acmeObs: Observation = { id: 'obs-0', text: 'the user owns a car', createdAt: 1, sourceIds: ['0'], level: 0, threadId: 't-1', fromSeq: 0, toSeq: 0 };
      const rootObs: Observation = { id: 'obs-0', text: 'the user asked about weather', createdAt: 1, sourceIds: ['0'], level: 0, threadId: 't-1', fromSeq: 0, toSeq: 0 };
      await acmeStorage.memory!.putObservations('t-1', [acmeObs]);
      await storage.memory!.putObservations('t-1', [rootObs]);
      await acmeStorage.vectors!.upsert([{ id: 'om:t-1:0:0', text: acmeObs.text, embedding: await embed(acmeObs.text), metadata: { source: 'observational-memory', threadId: 't-1', level: 0, obsId: 'obs-0' } }]);
      const root = new AgentMemory({ storage, observationalMemory: { enabled: true, observerModel: model, omVectors: { store: storage.vectors!, embed: omEmbed } } });
      const hits = await root.recallObservationsSemantic('t-1', 'car', { topK: 1 });
      expect(hits).toEqual([]);
    });
  });
}
