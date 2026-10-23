# @gnldev/rag

> Part of [GNL](https://github.com/gnlhq/gnldev), a full agent framework for TypeScript — works with the rest of it, or on its own.

**Vector store + RAG tool** for AI SDK agents. Used as a tool inside `runDurable`, it's automatically
**replayable** (thanks to durableTool the retrieval is journaled: on resume it comes back from the record
instead of running again).

> Install: `pnpm add @gnldev/rag` — or use it from a [repo clone](https://github.com/gnlhq/gnldev): `pnpm install && pnpm -r build`.

```bash
npm i @gnldev/rag   # peer: @gnldev/durable, ai, zod
```

```ts
import { InMemoryVectorStore, indexDocuments, createRagTool, llmReranker } from '@gnldev/rag';

const store = new InMemoryVectorStore();
await indexDocuments(store, embed, [{ id: 'p1', text: 'Return policy: 30 days…', shared: true }]);

const searchPolicy = createRagTool({
  store, embed, topK: 3,
  rerank: llmReranker({ model }), rerankTopK: 2,   // optional LLM reranker
});

await runDurable({ runId: 'r1', journal, model, tools: { searchPolicy }, prompt: '…' });
```

## API
- `InMemoryVectorStore` · `indexDocuments(store, embed, docs, { concurrency? })` · `VectorStore` interface
  (plug in your own backend)
- Embedding runs at most `concurrency` `embed` calls at once (default 8, `Infinity` for no bound), in
  `indexDocuments` and across every document of one `ingestDocuments` call. On a failure no new call
  starts and nothing is written.
- `ingestDocuments(store, embed, docs, { strategy?, size?, overlap?, concurrency? })` — chunk, embed and write whole documents so each
  document's stored chunks are exactly one version of it: when the call resolves or rejects, a document
  holds all of its new chunks or all of its previous ones, never a mix and never nothing. The new
  chunks are written first, as a new generation (ids `<id>#<i>@<generation>`, `metadata.__gnlGen`);
  then the document's chunks are listed by the reserved trail `metadata.__gnlDoc === id` and every
  other generation is deleted in its partition, with the 0.9.0 shapes (a one-chunk document under its
  raw id, `<id>#<n>` + `source`/`chunk`). Two concurrent ingests of one document converge on the newer
  one. A write that fails is undone and the error names the document (`err.documentId`) and the
  documents this call had already replaced (`err.replaced`). While an ingest runs, a query can see both
  versions whole. The listing is a `query` with the trail as `filter`: an approximate index (pgvector
  HNSW/IVFFlat) may miss chunks, which then stay until the next ingest. Your own metadata — `source`
  included — is never used to find a document's chunks.
  Without a `namespace` on a root store, the store must declare `rootOutsideOrganizations` (so the
  delete cannot reach an organization's document of the same id); otherwise it is refused. Use it for
  anything you re-index after an edit; `indexDocuments` only upserts, so an edit that yields fewer chunks leaves the old tail retrievable.
  `deleteDocuments(store, ids, { namespace? })` removes documents the same way. Both need `store.delete`.
- `chunkDocuments(docs, opts?)` — ids `<docId>#<i>` (the bare id for a one-chunk document); every chunk
  carries the trail `metadata: { __gnlDoc: docId, __gnlChunk: i }` beside your own metadata, which is
  left as it was. `%` and `#` in a document id are escaped in chunk ids, so no document id is another's
  chunk id. No chunk is longer than `size`, overlap included: each chunk repeats as much of the previous one as
  fits, up to `overlap`; a cut never splits a surrogate pair.
- `createRagTool({ store, embed, topK?, namespace?, filter?, rerank?, rerankTopK?, description? })` → AI SDK
  tool. Each hit is `{ id, documentId, text, score, metadata? }`: `id` is the stored record (a chunk id
  for a chunked document), `documentId` the document it belongs to — what the model cites.
- `llmReranker({ model })` → `Reranker`
- `SemanticMemory` — vector-based recall (memory integration). Concurrent turns on one thread keep
  every message: appends go through `appendToJournalLog` (@gnldev/durable), which is safe across
  processes on any journal with `putIfMatch`/`putIfAbsent` (every first-party one).

## General documents and each user's own

One knowledge base can hold both: documents for everyone in the organization, and documents that belong
to one end user. Label each document when you index it:

```ts
import { InMemoryVectorStore, indexDocuments } from '@gnldev/rag';
declare const embed: (text: string) => Promise<number[]>;

const store = new InMemoryVectorStore();
await indexDocuments(store, embed, [
  { id: 'handbook', text: 'Leave policy…', shared: true },     // everyone's
  { id: 'inv-17', text: 'Invoice 17…', owner: 'ayse' },         // Ayşe's only
]);
```

When a run is on behalf of an end user, `createRagTool` answers from the shared documents and that
user's own. You don't pass anything for this: the tool reads whose run it is from the engine's identity
channel (`identityOf(options)` in `@gnldev/durable`), the same value the run's owner record comes from.

| Document | Ayşe's search | Mehmet's search | Staff / system | Identity lost (`unknown`) |
|---|---|---|---|---|
| `shared: true` | ✅ | ✅ | ✅ | ✅ |
| `owner: 'ayse'` | ✅ | ❌ | ✅ | ❌ |
| no label | ❌ | ❌ | ✅ | ❌ |

A document with no label is visible to no end user. A forgotten label shows up as "not found", never as
a leak. A call that lost its identity (called by hand, or by another tool that did not pass its
`options` on) gets the shared documents only.

## One tool per organization

> **Warning.** `visibleTo` separates users, not organizations. A tool built once over the ROOT vector
> store searches every organization's documents. The run knows the caller's organization, but the
> tool does not filter by it. Measured with one root store: a user of `acme` got `globex`'s shared
> document, and the private document of a `globex` user with the same id as theirs.

Give each organization its own tool, over that organization's part of the store
(`withOrgStorage(storage, orgId).vectors`). `tools` on an agent may be a function of the request
context, so the tool can be built per request, for the caller's organization:

```ts
import { createGnl, InMemoryStorage, withOrgStorage, serverIdentityOf } from '@gnldev/durable';
import { createRagTool, indexDocuments } from '@gnldev/rag';
import type { ToolSet } from 'ai';
declare const embed: (text: string) => Promise<number[]>;

const storage = new InMemoryStorage(); // the root storage, shared by every organization

// Index into the organization's part of the store, not into `storage.vectors`.
await indexDocuments(withOrgStorage(storage, 'acme').vectors!, embed, [
  { id: 'handbook', text: 'Leave policy…', shared: true },
]);

const gnl = createGnl({
  storage,
  agents: {
    assistant: {
      model,
      // Called for every run, with the request context the server sealed.
      tools: (ctx): ToolSet => {
        const orgId = serverIdentityOf(ctx).orgId;
        if (!orgId) return {}; // no organization on the request: no knowledge base
        return { search: createRagTool({ store: withOrgStorage(storage, orgId).vectors!, embed }) };
      },
    },
  },
});
```

Read the organization with `serverIdentityOf(ctx)`: the server writes it from the credential, and a
request body cannot set it. A call to `gnl.run` from your own code has no sealed organization, so it
gets no tool here.

### Qdrant

`QdrantVectorStore` keeps the documents on a Qdrant server, through its REST API (no extra package):

```ts
import { QdrantVectorStore } from '@gnldev/rag';

const vectors = new QdrantVectorStore({
  url: 'https://qdrant.example.internal:6333',
  apiKey: process.env.QDRANT_API_KEY, // sent as the `api-key` header, never in an error message
  collection: 'gnl_vectors',          // default; letters, digits, `_` and `-`
});
```

The collection is created on the first write, with the length of that write's vectors (or
`dimension`, when given); a later vector of another length is refused with `VectorDimensionError`.
Query and delete before the first write return nothing. Owner, namespace and sharing are part of each
point's id, so the same document id under two owners is two points, and a write that would take over
another's id fails with `VectorOwnerConflictError`, also when two processes write it at once. Equal
scores at the top-K cut are read in full and ordered by id, like every other store; a zero query
vector matches every visible document with score 0.

### Chroma

`ChromaVectorStore` keeps the documents on a Chroma server (1.x), through its REST API (no extra package):

```ts
import { ChromaVectorStore } from '@gnldev/rag';

const vectors = new ChromaVectorStore({
  url: 'http://chroma.example.internal:8000',
  apiKey: process.env.CHROMA_TOKEN, // sent as the `x-chroma-token` header, never in an error message
  collection: 'gnl_vectors',        // default; letters, digits, `_` and `-` (so are `tenant` and `database`)
});
```

It keeps the same rules as the Qdrant store: the collection (cosine) is created on the first write with
that write's vector length or `dimension`; owner, namespace and sharing are part of each record's id;
a zero vector scores 0. A document's metadata may hold any JSON value — it is stored whole beside the
scalar fields filters read.

Chroma's search is approximate (HNSW), and among copies of one vector it does not reach them all. When
equal scores fall at the top-K cut, the store reads the tie whole and orders it by id like every other
store: copies of one vector (a text ingested twice) are read by a digest of the vector; a tie between
different vectors is found one vector at a time. Away from a tie, the answer is Chroma's.

### Weaviate

`WeaviateVectorStore` keeps the documents on a Weaviate server (1.x), through its REST and GraphQL API
(no extra package):

```ts
import { WeaviateVectorStore } from '@gnldev/rag';

const vectors = new WeaviateVectorStore({
  url: 'https://weaviate.example.internal:8080',
  apiKey: process.env.WEAVIATE_API_KEY, // sent as `Authorization: Bearer …`, never in an error message
  collection: 'GnlVectors',             // default; a capital letter, then letters, digits and `_`
});
```

It keeps the same rules as the Qdrant and Chroma stores: the collection (cosine, no vectorizer: the
store sends its own vectors) is created on the first write with that write's vector length or
`dimension`; owner, namespace and sharing are part of each object's id; a zero vector scores 0; a
document's metadata may hold any JSON value. Weaviate's exact match trims whitespace, so the store
keeps every label it filters on as its JSON spelling: `"a"` and `" a"` stay two ids, two namespaces,
two owners. Its search is approximate (HNSW) and does not reach every copy of one vector either, so a
tie at the top-K cut is read whole and ordered by id, as in the Chroma store.

A collection made by hand needs this store's properties; let the store make it. Weaviate's batch write
is not one transaction: when it refuses an object, the call fails and the objects it accepted stay
written.

### Elasticsearch and OpenSearch

`ElasticsearchVectorStore` (Elasticsearch 9.x) and `OpenSearchVectorStore` (OpenSearch 3.x) keep the
documents in an index on that server, through its REST API (no extra package):

```ts
import { ElasticsearchVectorStore, OpenSearchVectorStore } from '@gnldev/rag';

const es = new ElasticsearchVectorStore({
  url: 'https://es.example.internal:9200',
  apiKey: process.env.ES_API_KEY,     // sent as `Authorization: ApiKey …`, never in an error message
  index: 'gnl_vectors',               // default; lowercase letters, digits, `_` and `-`
});
const os = new OpenSearchVectorStore({
  url: 'https://opensearch.example.internal:9200',
  auth: { username: 'gnl', password: process.env.OPENSEARCH_PASSWORD! }, // HTTP basic, never in an error message
});
```

They keep the same rules as the other server stores: the index is created on the first write with that
write's vector length (or `dimension`), with fields of its own and `dynamic: strict`, and an index this
store did not make is refused by name rather than written into; owner, namespace and sharing are part of
each document's id; equal scores at the cut are read in full and ordered by id; a zero vector is kept
and scores 0. Scores are computed from the vectors as written — the index only finds the candidates
(cosine refuses a zero vector on both servers, so the index searches normalized vectors by inner
product). Every write and delete asks the server to refresh, so what was written is searchable when the
call returns; that costs a refresh per call (1,000 inserts in batches of 100: about 0.65 s). Labels
compare exactly — case and whitespace are kept — and a metadata value of any length filters exactly.

### A call to a vector server has a deadline

`QdrantVectorStore`, `ChromaVectorStore`, `WeaviateVectorStore`, `ElasticsearchVectorStore` and
`OpenSearchVectorStore` give each call to their server
`timeoutMs` (default 30 000 ms), from sending it to the answer's last byte — a server that takes the
connection and never answers, or answers a byte at a time, fails the call with `… timed out after
30000 ms` instead of holding it. A write cut this way may still have landed on the server; an upsert
writes by a derived id, so the same upsert again is safe.

```ts
import { QdrantVectorStore } from '@gnldev/rag';

const vectors = new QdrantVectorStore({ url: 'http://qdrant.example.internal:6333', timeoutMs: 10_000 });
```

Every store (`InMemoryVectorStore`, `GraphRag`, `PostgresVectorStore`, `QdrantVectorStore`, `ChromaVectorStore`, `WeaviateVectorStore`,
`ElasticsearchVectorStore`, `OpenSearchVectorStore` and the `@gnldev/durable`
storages) applies the same write rule, before anything is written:

- `owner` must be an id an end user can carry: not empty, at most 200 characters, no control
  characters, no staff prefix such as `operator:` (`ownerIdProblem` in `@gnldev/durable`, the same rule
  as `subjectIdProblem` in `@gnldev/auth`). Otherwise the upsert throws `OwnerIdError`.
- `shared` is `true`, `false` or absent; `namespace` is a non-empty string or absent.
- A namespace or id starting with `org:` is an organization's (`withOrgStorage` writes acme's
  documents under `org:acme`): an upsert, query or delete that names one throws
  `ReservedVectorNameError` unless it comes through that organization's view
  (`withOrgStorage(storage, orgId).vectors`). Any other namespace (`acme`, `ORG:x`, `my-org:x`) is yours.
- An upsert **updates** a document; it does not move it to another owner or label. Upserting an
  existing id with a different `owner`/`shared` (or namespace) fails with `VectorOwnerConflictError`,
  so one user cannot take over another's document or replace a shared one. The same id twice in one
  batch under two owners fails the same way, and nothing of the batch is written. To relabel, `delete`
  it first.

`delete({ owner })` removes one person's documents; `eraseSubject(storage, userId)` in
`@gnldev/durable` does it for the storage's vector store as part of erasing them. A `delete` with no condition (`{}`, `{ ids: [] }`,
`{ filter: {} }`) removes nothing.

A `filter` value is a string, number, boolean or `null`, compared by `===`; `undefined` means the
document has no such key. An array, object or function value is refused with `VectorFilterError` on
every store — filter on a scalar key instead (`tag_a: true`). Equal scores come back ordered by id, and
a vector of another length than the store's is refused with `VectorDimensionError`.

Your own `VectorStore` gets the same request as `QueryOptions.visibleTo`. Return only documents with
`shared: true` or `owner === visibleTo`, and filter **before** taking the top K. Run it through
`vectorStoreConformance` (`@gnldev/durable/testing`) — the scenarios every store here passes.

## How it works
Since RAG is a tool, it naturally fits into the durable agent loop: retrieval + rerank are journaled once
and replayed rather than repeated. For cross-run reuse, it can be combined with `@gnldev/cache`.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
