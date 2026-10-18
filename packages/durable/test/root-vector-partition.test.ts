// ADR-0001: "the root scope never sees organizations' vectors". A root vector query or delete without
// a namespace is the root's partition alone; the code-only grant `VECTOR_ALL_PARTITIONS` reaches every
// organization too. Each `it` is a requirement (R1..R7) or a sibling scenario (S*), run on every store.
//
// Stores: durable InMemory / SQLite / Postgres (pg-mem) [+ real Postgres with GNL_PG_URL], rag
// InMemoryVectorStore / GraphRag [+ PostgresVectorStore with GNL_PGVECTOR_URL] — the rag stores as a
// root app would hold them: the store itself, with organizations reached through withOrgStorage.
import { describe, it, expect, afterAll } from 'vitest';
import { newDb } from 'pg-mem';
import pg from 'pg';
import { InMemoryStorage, withOrgStorage, eraseSubject, purgeResource, toJournal, VECTOR_ALL_PARTITIONS, vectorQueryScope, vectorInOrganization, type Storage, type VectorStore } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { mysqlStores } from './real-backends.js';
import { InMemoryVectorStore, GraphRag, PostgresVectorStore, createRagTool, ingestDocuments } from '../../rag/src/index.js';
import { AgentMemory } from '../../memory/src/index.js';

/** Ground truth: every document, every partition — through the code-only grant. */
async function everything(s: VectorStore): Promise<string[]> {
  const got = await s.query([1, 0, 0], 100_000, { [VECTOR_ALL_PARTITIONS]: true });
  return got.map((m: { id: string }) => m.id).sort();
}

const PG_URL = process.env.GNL_PG_URL;
const PGVECTOR_URL = process.env.GNL_PGVECTOR_URL;
const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => { for (const c of cleanups) await c(); });
let schemas = 0;
async function realPool(url: string, pgvector = false): Promise<pg.Pool> {
  const schema = `rootvec_${process.pid}_${Date.now().toString(36)}_${schemas++}`;
  const admin = new pg.Pool({ connectionString: url, max: 1 });
  if (pgvector) await admin.query('CREATE EXTENSION IF NOT EXISTS vector SCHEMA public');
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: url, max: 4, options: `-c search_path=${schema},public` });
  cleanups.push(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  return pool;
}

/** A storage whose vector store is `vectors` (a rag store, held by the app itself). */
const withVectors = (storage: Storage, vectors: VectorStore): Storage => Object.assign(Object.create(storage), { vectors });

type World = { name: string; make: () => Promise<{ storage: Storage; root: VectorStore }> };
const durable = (name: string, mk: () => Promise<Storage>): World => ({ name, make: async () => { const storage = await mk(); return { storage, root: storage.vectors! }; } });
const rag = (name: string, mk: () => Promise<VectorStore>): World => ({
  name,
  make: async () => { const root = await mk(); return { storage: withVectors(new InMemoryStorage() as unknown as Storage, root), root }; },
});
export const WORLDS: World[] = [
  durable('durable InMemory', async () => new InMemoryStorage() as unknown as Storage),
  durable('durable SQLite', async () => new SqliteStorage(':memory:') as unknown as Storage),
  durable('durable Postgres (pg-mem)', async () => new PostgresStorage({ pool: new (newDb().adapters.createPg().Pool)() }) as unknown as Storage),
  rag('rag InMemoryVectorStore (standalone)', async () => new InMemoryVectorStore() as unknown as VectorStore),
  rag('rag GraphRag (standalone)', async () => new GraphRag({ threshold: 0.6 }) as unknown as VectorStore),
  ...(PG_URL ? [durable('durable Postgres (real)', async () => new PostgresStorage({ pool: await realPool(PG_URL) }) as unknown as Storage)] : []),
  ...mysqlStores(' (real)').map(([name, make]) => durable(`durable ${name}`, async () => { const s = await make(); cleanups.push(() => s.close()); return s as unknown as Storage; })),
  ...(PGVECTOR_URL ? [rag('rag PostgresVectorStore (real pgvector)', async () => new PostgresVectorStore({ pool: await realPool(PGVECTOR_URL, true), index: 'none' }) as unknown as VectorStore)] : []),
];

// The organizations' documents are CLOSER to the query than the root's, so a root query that is not
// partitioned before ranking would return them first.
const Q = [1, 0, 0];
const ORG_E = [1, 0, 0];
const ROOT_E = [0.8, 0.6, 0];
const ORGS = ['acme', 'globex'];
async function seed(storage: Storage, root: VectorStore) {
  for (const org of ORGS) {
    await withOrgStorage(storage, org, { allowUnregistered: true }).vectors!.upsert([
      { id: 'a-ayse', text: `${org} ayse`, embedding: ORG_E, owner: 'ayse', metadata: { topic: 'x' } },
      { id: 'a-shared', text: `${org} shared`, embedding: ORG_E, shared: true, metadata: { topic: 'x' } },
      { id: 'a-bob', text: `${org} bob`, embedding: ORG_E, owner: 'bob', metadata: { topic: 'y' } },
    ]);
  }
  await root.upsert([
    { id: 'r-ayse', text: 'root ayse', embedding: ROOT_E, owner: 'ayse', metadata: { topic: 'x' } },
    { id: 'r-shared', text: 'root shared', embedding: ROOT_E, shared: true, metadata: { topic: 'x' } },
    { id: 'r-bob', text: 'root bob', embedding: ROOT_E, owner: 'bob', metadata: { topic: 'y' } },
    { id: 'r-kb', text: 'root kb', embedding: ROOT_E, namespace: 'kb', metadata: { topic: 'x' } },
  ]);
}
const ids = (ms: Array<{ id: string }>) => ms.map((m) => m.id).sort();
const isOrg = (id: string) => id.startsWith('org:');

describe.each(WORLDS)('root vectors — $name', (w) => {
  it('R1: a root query with no namespace returns only the root\'s documents, topK filled from them', async () => {
    const { storage, root } = await w.make();
    await seed(storage, root);
    const got = await root.query(Q, 4);
    expect(ids(got).filter(isOrg)).toEqual([]);
    expect(ids(got)).toEqual(['r-ayse', 'r-bob', 'r-kb', 'r-shared']);
  });

  it('R1: a root RAG tool (createRagTool, no namespace) answers from the root\'s shelf only', async () => {
    const { storage, root } = await w.make();
    await seed(storage, root);
    const tool = createRagTool({ store: root as never, embed: async () => Q, topK: 4 });
    // No run identity: the general shelf only (SHARED_ONLY) — the shared documents of whoever.
    const hits = (await (tool as any).execute({ query: 'q' }, {})) as Array<{ text: string }>;
    expect(hits.map((h) => h.text).filter((t) => !t.startsWith('root'))).toEqual([]);
    expect(hits.map((h) => h.text)).toEqual(['root shared']);
  });

  it('R1/S3: a root query with a filter only (no namespace) does not reach organizations', async () => {
    const { storage, root } = await w.make();
    await seed(storage, root);
    expect(ids(await root.query(Q, 10, { filter: { topic: 'x' } }))).toEqual(['r-ayse', 'r-kb', 'r-shared']);
  });

  it('R1: a root query for an end user (visibleTo) sees their root documents and the root shelf only', async () => {
    const { storage, root } = await w.make();
    await seed(storage, root);
    expect(ids(await root.query(Q, 10, { visibleTo: 'ayse' }))).toEqual(['r-ayse', 'r-shared']);
  });

  it('R2: an organization\'s view sees exactly its own documents', async () => {
    const { storage, root } = await w.make();
    await seed(storage, root);
    const acme = withOrgStorage(storage, 'acme', { allowUnregistered: true }).vectors!;
    expect(ids(await acme.query(Q, 10))).toEqual(['a-ayse', 'a-bob', 'a-shared']);
    expect(ids(await acme.query(Q, 10, { visibleTo: 'ayse' }))).toEqual(['a-ayse', 'a-shared']);
  });

  it('R3: eraseSubject without an organization erases the root\'s ayse only', async () => {
    const { storage, root } = await w.make();
    await seed(storage, root);
    await eraseSubject(storage, 'ayse');
    const left = await everything(root);
    expect(left).not.toContain('r-ayse');
    expect(left).toEqual(expect.arrayContaining(['org:acme:a-ayse', 'org:globex:a-ayse']));
  });

  it('R3: eraseSubject with an organization erases that organization\'s ayse only', async () => {
    const { storage, root } = await w.make();
    await seed(storage, root);
    await eraseSubject(storage, 'ayse', { orgId: 'acme' });
    const left = await everything(root);
    expect(left).not.toContain('org:acme:a-ayse');
    expect(left).toEqual(expect.arrayContaining(['r-ayse', 'org:globex:a-ayse']));
  });

  it('R3: purgeResource(journal, id, { vectors }) without outsideOrganizations still erases the id in every organization', async () => {
    const { storage, root } = await w.make();
    await seed(storage, root);
    const n = await purgeResource(toJournal(storage.runs), 'ayse', { vectors: root });
    expect(n).toBeGreaterThanOrEqual(3);
    expect((await everything(root)).filter((id) => id.endsWith('ayse'))).toEqual([]);
  });

  it('R3: purgeResource with outsideOrganizations keeps the organizations\' ayse', async () => {
    const { storage, root } = await w.make();
    await seed(storage, root);
    await purgeResource(toJournal(storage.runs), 'ayse', { vectors: root, outsideOrganizations: true });
    expect((await everything(root)).filter((id) => id.endsWith('ayse'))).toEqual(['org:acme:a-ayse', 'org:globex:a-ayse']);
  });

  it('S4: a root delete by filter only (no namespace) takes the root\'s documents only', async () => {
    const { storage, root } = await w.make();
    await seed(storage, root);
    const n = await root.delete!({ filter: { topic: 'y' } });
    expect(n).toBe(1);
    expect(await everything(root)).toEqual(expect.arrayContaining(['org:acme:a-bob', 'org:globex:a-bob']));
  });

  it('S4: a root delete by owner (no namespace, no flag) takes the root\'s documents only', async () => {
    const { storage, root } = await w.make();
    await seed(storage, root);
    expect(await root.delete!({ owner: 'bob' })).toBe(1);
    expect(await everything(root)).toEqual(expect.arrayContaining(['org:acme:a-bob', 'org:globex:a-bob']));
  });

  it('S4: a root delete by ids naming an organization\'s id is refused, nothing deleted', async () => {
    const { storage, root } = await w.make();
    await seed(storage, root);
    const before = await everything(root);
    await expect(root.delete!({ ids: ['r-bob', 'org:acme:a-bob'] })).rejects.toThrow(/org:/);
    expect(await everything(root)).toEqual(before);
  });

  it('S6: re-ingesting a root document does not touch an organization\'s document of the same id', async () => {
    const { storage, root } = await w.make();
    await ingestDocuments(withOrgStorage(storage, 'acme', { allowUnregistered: true }).vectors as never, async () => ORG_E, [{ id: 'handbook', text: 'acme handbook' }]);
    await ingestDocuments(root as never, async () => ROOT_E, [{ id: 'handbook', text: 'root handbook v1' }]);
    await ingestDocuments(root as never, async () => ROOT_E, [{ id: 'handbook', text: 'root handbook v2' }]);
    const all = await everything(root);
    expect(all.filter(isOrg).length).toBeGreaterThan(0);
    expect((await root.query(Q, 10)).map((m) => m.text)).toEqual(['root handbook v2']);
  });

  it('S7: ten organizations closer to the query cannot crowd the root out of its topK', async () => {
    const { storage, root } = await w.make();
    for (let i = 0; i < 10; i++) {
      await withOrgStorage(storage, `o${i}`, { allowUnregistered: true }).vectors!.upsert(
        Array.from({ length: 5 }, (_, j) => ({ id: `d${j}`, text: `o${i} d${j}`, embedding: ORG_E })),
      );
    }
    await root.upsert([{ id: 'r1', text: 'r1', embedding: ROOT_E }, { id: 'r2', text: 'r2', embedding: ROOT_E }]);
    expect(ids(await root.query(Q, 2))).toEqual(['r1', 'r2']);
  });

  it('R5: a single-tenant app (no organizations) sees what it saw before', async () => {
    const { root } = await w.make();
    await root.upsert([
      { id: 'a', text: 'a', embedding: [1, 0, 0], owner: 'u1' },
      { id: 'b', text: 'b', embedding: [0.9, 0.1, 0], namespace: 'sales' },
      { id: 'c', text: 'c', embedding: [0.5, 0.5, 0], shared: true, metadata: { k: 1 } },
      { id: 'd', text: 'd', embedding: [0, 1, 0], namespace: 'kb', owner: 'u1' },
    ]);
    expect((await root.query(Q, 10)).map((m) => m.id)).toEqual(['a', 'b', 'c', 'd']);
    expect((await root.query(Q, 2)).map((m) => m.id)).toEqual(['a', 'b']);
    expect(ids(await root.query(Q, 10, { namespace: 'kb' }))).toEqual(['d']);
    expect(ids(await root.query(Q, 10, { visibleTo: 'u1' }))).toEqual(['a', 'c', 'd']);
    expect(await root.delete!({ owner: 'u1' })).toBe(2);
    expect(await root.delete!({ filter: { k: 1 } })).toBe(1);
    expect(ids(await root.query(Q, 10))).toEqual(['b']);
  });

  it('R7: the administrative way through (one line) reaches every organization', async () => {
    const { storage, root } = await w.make();
    await seed(storage, root);
    expect((await everything(root)).filter(isOrg).length).toBe(6);
    const n = await root.delete!({ filter: { topic: 'y' }, [VECTOR_ALL_PARTITIONS]: true });
    expect(n).toBe(3);
  });

  it('R7: naming an organization from the root fails with an error that names the way through', async () => {
    const { storage, root } = await w.make();
    await seed(storage, root);
    await expect(root.query(Q, 4, { namespace: 'org:acme' })).rejects.toThrow(/withOrgStorage\(storage, orgId\)\.vectors/);
  });
});

describe('observational memory over the root store', () => {
  const DIMS = ['password', 'weather', 'car'];
  const embed = async (t: string) => DIMS.map((k) => t.toLowerCase().split(k).length - 1 + 0.01);
  const omEmbed = async (texts: string[]) => Promise.all(texts.map(embed));
  const obs = (id: string, text: string) => ({ id, text, createdAt: 1, sourceIds: ['0'], level: 0, threadId: 't-1', fromSeq: 0, toSeq: 0 });
  for (const [name, make] of [['InMemory', () => new InMemoryStorage()], ['SQLite', () => new SqliteStorage(':memory:')]] as const) {
    it(`R4 (${name}): an organization's memory over the ROOT store recalls its observation vectors`, async () => {
      const storage = make() as unknown as Storage;
      const acmeStorage = withOrgStorage(storage, 'acme', { allowUnregistered: true });
      const acme = new AgentMemory({ storage: acmeStorage, observationalMemory: { enabled: true, observerModel: {} as never, omVectors: { store: storage.vectors!, embed: omEmbed } } });
      const o = obs('obs-0', 'the user owns a car');
      await acmeStorage.memory!.putObservations('t-1', [o]);
      await (acme as any).indexObservationVector('t-1', 0, 0, o);
      const hits = await acme.recallObservationsSemantic('t-1', 'car', { topK: 1 });
      expect(hits.map((h) => h.text)).toEqual(['the user owns a car']);
    });

    it(`S8 (${name}): the root memory's semantic recall is not starved by 150 organization vectors`, async () => {
      const storage = make() as unknown as Storage;
      const rootStore = storage.vectors!;
      const root = new AgentMemory({ storage, observationalMemory: { enabled: true, observerModel: {} as never, omVectors: { store: rootStore, embed: omEmbed } } });
      const o = obs('obs-0', 'weather weather and a car'); // less like the query than the organizations' vectors
      await storage.memory!.putObservations('t-1', [o]);
      await (root as any).indexObservationVector('t-1', 0, 0, o);
      for (let i = 0; i < 3; i++) {
        await withOrgStorage(storage, `o${i}`, { allowUnregistered: true }).vectors!.upsert(
          Array.from({ length: 50 }, (_, j) => ({ id: `v${j}`, text: 'car car car', embedding: [0, 0, 1], metadata: { source: 'observational-memory', threadId: 't-x', obsId: `x${j}` } })),
        );
      }
      const hits = await root.recallObservationsSemantic('t-1', 'car', { topK: 1 });
      expect(hits.map((h) => h.text)).toEqual(['weather weather and a car']);
    });
  }
});

describe('S5: a custom store written by the user', () => {
  /** Structural, written against the port's documented contract: filters `namespace` itself, runs no shared rule. */
  class HandWritten implements VectorStore {
    readonly deleteOutsideOrganizations = true;
    items: any[] = [];
    async upsert(items: any[]) { for (const it of items) { const { ...doc } = it; this.items = this.items.filter((x) => x.id !== it.id).concat([doc]); } }
    async query(e: number[], k: number, o?: any) {
      return this.items.filter((it) => o?.namespace === undefined || it.namespace === o.namespace)
        .map((it) => ({ ...it, score: it.embedding.reduce((s: number, v: number, i: number) => s + v * e[i]!, 0) })).sort((a, b) => b.score - a.score).slice(0, k);
    }
    async delete(wh: any) {
      const before = this.items.length;
      this.items = this.items.filter((it) => !((wh.owner === undefined || it.owner === wh.owner) && (wh.namespace === undefined || it.namespace === wh.namespace)
        && (!wh.outsideOrganizations || !(typeof it.namespace === 'string' && it.namespace.startsWith('org:')))));
      return before - this.items.length;
    }
  }
  /** Written against the shared rule (`vectorQueryScope`), as the docs suggested before `outsideOrganizations` (ignores it). */
  class OnTheRule extends HandWritten {
    override async query(e: number[], k: number, o?: any) {
      const scope = vectorQueryScope(o);
      return this.items.filter((it) => scope.namespace === undefined || it.namespace === scope.namespace)
        .map((it) => ({ ...it, score: it.embedding.reduce((s: number, v: number, i: number) => s + v * e[i]!, 0) })).sort((a, b) => b.score - a.score).slice(0, k);
    }
  }
  /** Written against the rule: applies `outsideOrganizations` from the shared rule, and says so. */
  class Conforming extends HandWritten {
    readonly rootOutsideOrganizations = true;
    override async query(e: number[], k: number, o?: any) {
      const scope = vectorQueryScope(o);
      return this.items.filter((it) => (scope.namespace === undefined || it.namespace === scope.namespace)
        && !(scope.outsideOrganizations && vectorInOrganization(it.namespace)))
        .map((it) => ({ ...it, score: it.embedding.reduce((s: number, v: number, i: number) => s + v * e[i]!, 0) })).sort((a, b) => b.score - a.score).slice(0, k);
    }
  }
  for (const [name, mk] of [['hand-written', () => new HandWritten()], ['on vectorQueryScope', () => new OnTheRule()], ['conforming to the new rule', () => new Conforming()]] as const) {
    it(`S5 (${name}): a root query does not return an organization's document (or organizations never enter the store)`, async () => {
      const raw = mk();
      const root = raw as unknown as VectorStore;
      const storage = withVectors(new InMemoryStorage() as unknown as Storage, root);
      const seeded = await seed(storage, root).then(() => 'ok', (e: Error) => e.message);
      if (seeded !== 'ok') {
        // Refused at the organization's write: nothing of any organization is in the store, and the
        // error names the way through.
        expect(seeded).toMatch(/rootOutsideOrganizations = true/);
        expect(raw.items.filter((it: any) => isOrg(it.id))).toEqual([]);
        return;
      }
      expect(ids(await root.query(Q, 4)).filter(isOrg)).toEqual([]);
    });
  }
});
