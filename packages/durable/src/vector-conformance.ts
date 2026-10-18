/**
 * `vectorStoreConformance` — the scenarios a `VectorStore` has to pass on its own: the stores shipped
 * here and in @gnldev/rag, and one you write yourself (a hosted vector database).
 *
 * WHY. `storageConformance` reaches a vector store through a whole `Storage`; a vector database is
 * usually a store of its own. What gnl asks of one is more than its method signatures: a person's
 * documents are erased by owner and nothing else is, an organization's documents never answer the root,
 * a filter narrows before ranking and means the same on every store, a refused batch writes nothing, a
 * vector of the wrong length is refused where it is written, equal scores come back in one order (a
 * replay reads the same answer). Measured before this kit: of ten stores that each break one of these,
 * the exported kit caught one.
 *
 * Same shape as `journalConformance`: the caller's `describe`/`it`, `node:assert`, a fresh store per
 * scenario from `make` — the store itself, or `{ vectors, close }` when it holds a connection.
 *
 * ```ts
 * import { describe, it } from 'vitest';
 * import { vectorStoreConformance } from '@gnldev/durable/testing';
 * vectorStoreConformance('my store', () => new MyVectorStore(), { describe, it });
 * ```
 */
import assert from 'node:assert/strict';
import { refuseUnknownNames } from '@gnldev/options';
import { VECTOR_STORE_CONFORMANCE_NAMES } from './option-names.js';
import { VECTOR_ALL_PARTITIONS, VECTOR_PARTITION, type VectorStore, type VectorDeleteWhere, type VectorQueryOptions } from './storage.js';

export interface VectorStoreConformanceOptions {
  describe: (name: string, body: () => void) => void;
  it: (name: string, body: () => Promise<void>, timeout?: number) => void;
  /** Per-scenario timeout in ms (a hosted store answers slower than memory). */
  timeout?: number;
  /**
   * `false` only for a test double that cannot isolate two concurrent writers (pg-mem): the race in VS5 is
   * then not run. Same meaning as `journalConformance`'s `exactClaim`. Default `true`.
   */
  exactClaim?: boolean;
}

/** What `make` returns: the store, or the store and how to release it (a pool, a file). */
export type VectorStoreUnderTest = VectorStore | { vectors: VectorStore; close?: () => unknown };

const E = [1, 0, 0];
type Doc = { id: string; text: string; embedding: number[]; owner?: string; shared?: boolean; namespace?: string; metadata?: Record<string, unknown> };
const doc = (id: string, labels: { owner?: string; shared?: boolean; namespace?: string } = {}, text = id): Doc => ({ id, text, embedding: E, ...labels });
const ALL = { [VECTOR_ALL_PARTITIONS]: true } as unknown as VectorQueryOptions;

/** What a call did, as a comparable string: `ok:<value>` or `throw:<error name>`. */
async function outcome(f: () => Promise<unknown>): Promise<string> {
  try { const r = await f(); return `ok:${JSON.stringify(r ?? null)}`; } catch (e) { return `throw:${(e as Error).name}`; }
}
/** Every stored document, as `id/owner[/S]=text`, sorted — the whole store, not a query's view of it. */
async function all(s: VectorStore, opts?: VectorQueryOptions): Promise<string> {
  return (await s.query(E, 1000, opts ?? ALL)).map((m) => `${m.id}/${m.owner ?? '-'}${m.shared ? '/S' : ''}=${m.text}`).sort().join(',');
}
const ids = async (s: VectorStore, filter: Record<string, unknown>) => (await s.query(E, 10, { ...ALL, filter })).map((m) => m.id).sort().join(',');

export function vectorStoreConformance(name: string, make: () => VectorStoreUnderTest | Promise<VectorStoreUnderTest>, opts: VectorStoreConformanceOptions): void {
  refuseUnknownNames('vectorStoreConformance', opts, VECTOR_STORE_CONFORMANCE_NAMES);
  const scenario = (title: string, body: (s: VectorStore) => Promise<void>) =>
    opts.it(title, async () => {
      const made = await make();
      const held = 'vectors' in made && typeof (made as { upsert?: unknown }).upsert !== 'function' ? made as { vectors: VectorStore; close?: () => unknown } : { vectors: made as VectorStore };
      try { await body(held.vectors); } finally { await held.close?.(); }
    }, ...(opts.timeout === undefined ? [] : [opts.timeout]) as [number?]);
  const del = (s: VectorStore, w: unknown) => outcome(() => s.delete!(w as VectorDeleteWhere));

  opts.describe(`vector store conformance — ${name}`, () => {
    scenario('VS1 labels: a refused label refuses the whole upsert, and nothing is written', async (s) => {
      const bad: Array<[string, object]> = [['shared "false"', { shared: 'false' }], ['owner ""', { owner: '' }], ['owner reserved', { owner: 'operator:ops' }], ['owner control char', { owner: 'bob\n' }], ['namespace ""', { namespace: '' }]];
      for (const [what, labels] of bad) assert.match(await outcome(() => s.upsert([doc('ok1'), { ...doc('d'), ...labels } as Doc])), /^throw:/, what);
      assert.equal(await all(s), '');
    });
    scenario('VS2 an upsert updates a document, never hands it to another owner or label; one batch naming one id under two owners is refused whole', async (s) => {
      await s.upsert([doc('d1', { owner: 'alice', namespace: 'n' }, 'v1'), doc('s1', { shared: true })]);
      assert.equal(await outcome(() => s.upsert([doc('d1', { owner: 'bob', namespace: 'n' }, 'bob')])), 'throw:VectorOwnerConflictError');
      assert.equal(await outcome(() => s.upsert([doc('d1', { owner: 'alice' }, 'moved')])), 'throw:VectorOwnerConflictError');
      assert.equal(await outcome(() => s.upsert([doc('d1', { owner: 'alice', namespace: 'n' }, 'v2')])), 'ok:null');
      assert.equal(await outcome(() => s.upsert([doc('x', { owner: 'alice' }), doc('x', { owner: 'bob' })])), 'throw:VectorOwnerConflictError');
      assert.equal(await all(s), 'd1/alice=v2,s1/-/S=s1');
    });
    scenario('VS3 a batch refused on its last document writes none of it', async (s) => {
      await s.upsert([doc('d1', { owner: 'alice' })]);
      assert.match(await outcome(() => s.upsert([doc('n1', { owner: 'bob' }), doc('n2', { shared: true }), doc('d1', { owner: 'bob' })])), /^throw:/);
      assert.equal(await all(s), 'd1/alice=d1');
    });
    scenario('VS4 the same id twice is one document, the last copy', async (s) => {
      await s.upsert([doc('a', {}, 'one')]);
      await s.upsert([doc('a', {}, 'two')]);
      assert.equal(await all(s), 'a/-=two');
    });
    scenario('VS5 two owners writing the same new id at once: at most one wins, and the document is never the loser\'s', async (s) => {
      if (opts.exactClaim === false) return;
      for (let round = 0; round < 5; round++) {
        const id = `race${round}`;
        const [a, b] = await Promise.all([outcome(() => s.upsert([doc(id, { owner: 'alice' }, 'A')])), outcome(() => s.upsert([doc(id, { owner: 'bob' }, 'B')]))]);
        const stored = (await s.query(E, 1000, ALL)).filter((m) => m.id === id).map((m) => `${m.owner}=${m.text}`);
        assert.ok(!(a === 'ok:null' && b === 'ok:null'), `round ${round}: both writers were told they wrote ${id}`);
        if (a === 'ok:null') assert.deepEqual(stored, ['alice=A'], `round ${round}: alice won, the document is hers`);
        else if (b === 'ok:null') assert.deepEqual(stored, ['bob=B'], `round ${round}: bob won, the document is his`);
        else assert.deepEqual(stored, [], `round ${round}: both refused, nothing is stored`);
      }
    });
    scenario('VS6 a namespace sees only itself; the root (no namespace) never sees an organization\'s documents', async (s) => {
      await s.upsert([doc('n1', { shared: true, namespace: 'n' }), doc('m1', { shared: true, namespace: 'm' }), doc('r1', { shared: true })]);
      await s.upsert([{ ...doc('org:acme:a1', { shared: true, namespace: 'org:acme' }), [VECTOR_PARTITION]: 'org:acme' } as Doc]);
      assert.equal(await all(s, { namespace: 'n' }), 'n1/-/S=n1');
      assert.equal(await all(s, {}), 'm1/-/S=m1,n1/-/S=n1,r1/-/S=r1');
      assert.equal(s.rootOutsideOrganizations, true, 'a store that keeps organizations from the root says so');
    });
    scenario('VS7 the root cannot write, read or delete by naming an organization\'s namespace', async (s) => {
      assert.equal(await outcome(() => s.upsert([doc('h', { shared: true, namespace: 'org:acme' })])), 'throw:ReservedVectorNameError');
      assert.equal(await outcome(() => s.query(E, 10, { namespace: 'org:acme' })), 'throw:ReservedVectorNameError');
      assert.equal(await del(s, { namespace: 'org:acme' }), 'throw:ReservedVectorNameError');
    });
    scenario('VS8 visibleTo: their own and the shared shelf; an unlabelled document is nobody\'s', async (s) => {
      await s.upsert([doc('a1', { owner: 'alice', namespace: 'n' }), doc('b1', { owner: 'bob', namespace: 'n' }), doc('s1', { shared: true, namespace: 'n' }), doc('u1', { namespace: 'n' })]);
      assert.equal(await all(s, { namespace: 'n', visibleTo: 'alice' }), 'a1/alice=a1,s1/-/S=s1');
      assert.equal(await all(s, { namespace: 'n', visibleTo: '' }), 's1/-/S=s1');
    });
    scenario('VS9 delete: no condition removes nothing; every given condition must match; it returns the count', async (s) => {
      await s.upsert([doc('a1', { owner: 'alice', namespace: 'n' }), doc('a2', { owner: 'alice' }), doc('b1', { owner: 'bob', namespace: 'n' })]);
      assert.deepEqual([await del(s, {}), await del(s, { ids: [] }), await del(s, { filter: {} })], ['ok:0', 'ok:0', 'ok:0']);
      assert.equal(await del(s, { ids: ['a1'], owner: 'bob' }), 'ok:0');
      assert.equal(await del(s, { owner: 'alice', namespace: 'n' }), 'ok:1');
      assert.equal(await all(s), 'a2/alice=a2,b1/bob=b1');
    });
    scenario('VS10 erasure: a person\'s documents outside every organization go; organizations\' same person stays; the grant reaches them', async (s) => {
      await s.upsert([doc('root-bob', { owner: 'bob' }), doc('n-bob', { owner: 'bob', namespace: 'n' }), doc('root-cem', { owner: 'cem' })]);
      await s.upsert([{ ...doc('org:acme:bob', { owner: 'bob', namespace: 'org:acme' }), [VECTOR_PARTITION]: 'org:acme' } as Doc]);
      assert.equal(await del(s, { outsideOrganizations: true }), 'ok:0', 'alone it is no condition');
      assert.equal(await del(s, { owner: 'bob', outsideOrganizations: true }), 'ok:2');
      assert.equal(await all(s), 'org:acme:bob/bob=org:acme:bob,root-cem/cem=root-cem');
      assert.equal(await del(s, { owner: 'bob', [VECTOR_ALL_PARTITIONS]: true }), 'ok:1');
    });
    scenario('VS11 filter: a scalar matches its equal (`===`); number and string are different values; null is a value', async (s) => {
      await s.upsert([{ ...doc('n'), metadata: { n: 1 } }, { ...doc('s'), metadata: { n: '1' } }, { ...doc('t'), metadata: { flag: true } }, { ...doc('z'), metadata: { x: null } }]);
      assert.deepEqual([await ids(s, { n: 1 }), await ids(s, { n: '1' }), await ids(s, { flag: true }), await ids(s, { x: null })], ['n', 's', 't', 'z']);
    });
    scenario('VS12 filter: an array, object or function value is refused (VectorFilterError) at the query and at the delete, and nothing is removed', async (s) => {
      await s.upsert([{ ...doc('ab'), metadata: { tags: ['a', 'b'] } }, { ...doc('o'), metadata: { o: { b: 1 } } }]);
      for (const filter of [{ tags: ['a'] }, { tags: ['a', 'b'] }, { o: { b: 1 } }, { f: () => 1 }]) {
        assert.equal(await outcome(() => s.query(E, 10, { ...ALL, filter })), 'throw:VectorFilterError', JSON.stringify(Object.keys(filter)));
        assert.equal(await del(s, { ids: ['ab', 'o'], filter }), 'throw:VectorFilterError');
      }
      assert.equal(await all(s), 'ab/-=ab,o/-=o');
    });
    scenario('VS13 filter: a scalar never matches inside a stored array or object (no containment either way)', async (s) => {
      await s.upsert([{ ...doc('arr'), metadata: { tags: ['a', 'b'] } }, { ...doc('obj'), metadata: { o: { b: 1 } } }, { ...doc('plain'), metadata: { tags: 'a' } }]);
      assert.equal(await ids(s, { tags: 'a' }), 'plain');
      assert.equal(await del(s, { ids: ['arr', 'obj', 'plain'], filter: { tags: 'a' } }), 'ok:1');
    });
    scenario('VS14 filter: a key whose value is undefined matches records without that key — in a query and in a delete alike', async (s) => {
      await s.upsert([{ ...doc('t1'), metadata: { trail: 'x' } }, { ...doc('t2'), metadata: { doc: 'x' } }, doc('t3'), { ...doc('t4'), metadata: { trail: null } }]);
      assert.equal((await s.query(E, 10, { ...ALL, filter: { trail: undefined } })).map((m) => m.id).sort().join(','), 't2,t3');
      assert.equal(await del(s, { ids: ['t1', 't2', 't3', 't4'], filter: { trail: undefined } }), 'ok:2');
    });
    scenario('VS15 a filter narrows BEFORE ranking: topK is filled from the matching documents', async (s) => {
      const near = Array.from({ length: 8 }, (_, i) => ({ ...doc(`near${i}`), metadata: { k: 'other' } }));
      await s.upsert([...near, { ...doc('far1'), embedding: [0, 1, 0], metadata: { k: 'mine' } }, { ...doc('far2'), embedding: [0, 1, 0.1], metadata: { k: 'mine' } }]);
      assert.equal(await ids(s, { k: 'mine' }), 'far1,far2');
      assert.equal((await s.query(E, 2, { ...ALL, filter: { k: 'mine' } })).length, 2);
    });
    scenario('VS16 ranking: most similar first; topK 0 is nothing; topK above the count is everything; an identical vector scores 1', async (s) => {
      await s.upsert([{ ...doc('far'), embedding: [0, 1, 0] }, { ...doc('near'), embedding: [1, 0.1, 0] }, { ...doc('mid'), embedding: [1, 1, 0] }]);
      assert.deepEqual((await s.query(E, 3, ALL)).map((m) => m.id), ['near', 'mid', 'far']);
      assert.deepEqual(await s.query(E, 0, ALL), []);
      assert.equal((await s.query(E, 50, ALL)).length, 3);
      await s.upsert([{ ...doc('same'), embedding: [3, 4, 0] }]);
      const [top] = await s.query([3, 4, 0], 1, ALL);
      assert.ok(Math.abs(top!.score - 1) < 1e-6, `score ${top!.score}`);
    });
    scenario('VS17 equal scores come back ordered by id, and topK cuts in that order (a replay reads the same answer)', async (s) => {
      await s.upsert(['c', 'a', 'd', 'b'].map((id) => doc(id)));
      assert.deepEqual((await s.query(E, 4, ALL)).map((m) => m.id), ['a', 'b', 'c', 'd']);
      assert.deepEqual((await s.query(E, 2, ALL)).map((m) => m.id), ['a', 'b']);
    });
    scenario('VS18 a vector of another length is refused where it is written (VectorDimensionError), nothing of the batch is, and the shelf still answers; a query of another length is refused', async (s) => {
      await s.upsert([doc('a')]);
      assert.equal(await outcome(() => s.upsert([doc('b'), { ...doc('bad'), embedding: [1, 0] }])), 'throw:VectorDimensionError', 'a 2-d vector beside 3-d ones');
      assert.equal(await outcome(() => s.upsert([{ ...doc('bad2'), embedding: [1, 0] }])), 'throw:VectorDimensionError', 'a 2-d vector into a 3-d store');
      assert.equal(await all(s), 'a/-=a', 'the shelf is unchanged and still answers');
      assert.equal(await outcome(() => s.query([1, 0], 5, ALL)), 'throw:VectorDimensionError');
    });
    scenario('VS19 a zero vector scores a finite number (no NaN), so minScore and ranking still work', async (s) => {
      await s.upsert([doc('a'), { ...doc('zero'), embedding: [0, 0, 0] }]);
      const got = [...await s.query([0, 0, 0], 5, ALL), ...await s.query(E, 5, ALL)];
      assert.ok(got.every((m) => Number.isFinite(m.score)), JSON.stringify(got.map((m) => m.score)));
    });
    scenario('VS20 a stored document is a copy: changing the item after the upsert changes nothing', async (s) => {
      const item = { ...doc('m1', { owner: 'alice' }, 'orig'), metadata: { k: 'orig' } as Record<string, unknown> };
      await s.upsert([item]);
      item.text = 'changed'; item.metadata.k = 'changed'; item.owner = 'bob';
      const [m] = await s.query(E, 1, ALL);
      assert.deepEqual([m!.text, m!.owner, m!.metadata], ['orig', 'alice', { k: 'orig' }]);
    });
  });
}
