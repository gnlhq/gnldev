// Invariant: a root-scope vector call cannot name a namespace in the organizations' reserved space
// (`org:`); an organization reaches its own documents only through its view (`withOrgStorage`).
//
// Measured before this file (and in 0.9.0), on the durable InMemory, SQLite and Postgres stores: a root
// `ingestDocuments` of a document with `namespace: 'org:acme'` deleted acme's document of the same id
// and wrote the root's text in its place; `createRagTool({ namespace: 'org:acme' })` over the root store
// answered with acme's documents.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, withOrgStorage, VECTOR_ALL_PARTITIONS } from '@gnldev/durable';
import { SqliteStorage } from '../../durable/src/sqlite-storage.js';
import { ingestDocuments, deleteDocuments, createRagTool, type VectorStore } from '../src/index.js';

const embed = async (_t: string) => [1, 1, 1];
// `ingestDocuments` writes `<id>#<i>@<generation>`; the generation is compared away here.
const all = async (vs: VectorStore) => (await vs.query([1, 1, 1], 1000, { [VECTOR_ALL_PARTITIONS]: true })).map((m) => `${m.namespace ?? '-'}|${m.id.replace(/@[0-9a-z]+$/, '')}|${m.text}`).sort();

describe.each([
  ['durable InMemory', () => new InMemoryStorage()],
  ['durable SQLite', () => new SqliteStorage(':memory:')],
] as const)('root scope and an organization\'s namespace — %s', (_name, mk) => {
  async function world() {
    const storage = mk();
    const acme = withOrgStorage(storage, 'acme').vectors!;
    await ingestDocuments(acme, embed, [{ id: 'h', text: 'ACME-SECRET', shared: true }]);
    return { root: storage.vectors! as VectorStore, acme };
  }

  it('a root ingest, delete or RAG tool naming `org:acme` is refused, and acme\'s document is untouched', async () => {
    const { root, acme } = await world();
    const before = await all(root);
    await expect(ingestDocuments(root, embed, [{ id: 'h', text: 'ROOT', shared: true, namespace: 'org:acme' }])).rejects.toThrow(/ReservedVectorName|withOrgStorage/);
    await expect(deleteDocuments(root, ['h'], { namespace: 'org:acme' })).rejects.toThrow(/withOrgStorage/);
    const tool = createRagTool({ store: root, embed, topK: 5, namespace: 'org:acme' });
    await expect((tool as any).execute({ query: 'secret' }, {})).rejects.toThrow(/withOrgStorage/);
    expect(await all(root)).toEqual(before);
    expect((await acme.query([1, 1, 1], 5)).map((m) => m.text)).toEqual(['ACME-SECRET']);
  });

  it('the way through: the organization\'s view ingests and deletes its own; the root keeps any other namespace', async () => {
    const { root, acme } = await world();
    await ingestDocuments(acme, embed, [{ id: 'h', text: 'ACME-NEW', shared: true }]);
    await ingestDocuments(root, embed, [{ id: 'h', text: 'ROOT', shared: true, namespace: 'acme-notes' }]);
    expect(await all(root)).toEqual(['acme-notes|h#0|ROOT', 'org:acme|org:acme:h#0|ACME-NEW']);
    expect(await deleteDocuments(acme, ['h'])).toBe(1);
    expect(await all(root)).toEqual(['acme-notes|h#0|ROOT']);
  });
});
