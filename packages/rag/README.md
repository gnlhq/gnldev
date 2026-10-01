# @gnldev/rag

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
- `InMemoryVectorStore` · `indexDocuments(store, embed, docs)` · `VectorStore` interface (plug in your own
  backend)
- `ingestDocuments(store, embed, docs, chunkOptions?)` — chunk, embed and write whole documents so each
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
  Without a `namespace` on a root store, the store must declare `deleteOutsideOrganizations` (so the
  delete cannot reach an organization's document of the same id); otherwise it is refused. Use it for
  anything you re-index after an edit; `indexDocuments` only upserts, so an edit that yields fewer chunks leaves the old tail retrievable.
  `deleteDocuments(store, ids, { namespace? })` removes documents the same way. Both need `store.delete`.
- `chunkDocuments(docs, opts?)` — ids `<docId>#<i>` (the bare id for a one-chunk document); every chunk
  carries the trail `metadata: { __gnlDoc: docId, __gnlChunk: i }` beside your own metadata, which is
  left as it was. `%` and `#` in a document id are escaped in chunk ids, so no document id is another's
  chunk id.
- `createRagTool({ store, embed, topK?, namespace?, filter?, rerank?, rerankTopK?, description? })` → AI SDK tool
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

Every store (`InMemoryVectorStore`, `GraphRag`, `PostgresVectorStore` and the `@gnldev/durable`
storages) applies the same write rule, before anything is written:

- `owner` must be an id an end user can carry: not empty, at most 200 characters, no control
  characters, no staff prefix such as `operator:` (`ownerIdProblem` in `@gnldev/durable`, the same rule
  as `subjectIdProblem` in `@gnldev/auth`). Otherwise the upsert throws `OwnerIdError`.
- `shared` is `true`, `false` or absent; `namespace` is a non-empty string or absent.
- An upsert **updates** a document; it does not move it to another owner or label. Upserting an
  existing id with a different `owner`/`shared` (or namespace) fails with `VectorOwnerConflictError`,
  so one user cannot take over another's document or replace a shared one. The same id twice in one
  batch under two owners fails the same way, and nothing of the batch is written. To relabel, `delete`
  it first.

`delete({ owner })` removes one person's documents; `eraseSubject(storage, userId)` in
`@gnldev/durable` does it for the storage's vector store as part of erasing them. A `delete` with no condition (`{}`, `{ ids: [] }`,
`{ filter: {} }`) removes nothing.

Your own `VectorStore` gets the same request as `QueryOptions.visibleTo`. Return only documents with
`shared: true` or `owner === visibleTo`, and filter **before** taking the top K.

## How it works
Since RAG is a tool, it naturally fits into the durable agent loop: retrieval + rerank are journaled once
and replayed rather than repeated. For cross-run reuse, it can be combined with `@gnldev/cache`.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
