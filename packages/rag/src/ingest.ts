// A document is the unit of identity; a chunk is not.
//
// `indexDocuments` upserts chunk by chunk, so re-indexing an edited document only overwrites the
// chunk ids the new text produces. Measured: a document edited from 5 chunks down to 2 left chunks
// #2-#4 of the OLD text retrievable; edited down to one chunk, every `#i` survived beside the new bare
// id. `ingestDocuments` gives the write the document's shape: remove what the document had, then
// write what it has now.
import { OM_VECTOR_SOURCE } from '@gnldev/durable';
import { chunkDocuments, type ChunkOptions } from './chunk.js';
import type { DeleteWhere, Embed, VectorDoc, VectorItem, VectorStore } from './vector-store.js';

export interface IngestResult {
  /** Chunks written. */
  indexed: number;
  /** Chunks removed before writing — the previous version's, including ones the new text reuses. */
  removed: number;
}

function requireDelete(store: VectorStore, fn: string): asserts store is VectorStore & { delete: NonNullable<VectorStore['delete']> } {
  if (typeof store.delete !== 'function') {
    throw new Error(
      `@gnldev/rag: ${fn} replaces a document's chunks, and this vector store has no \`delete\`. ` +
        'Implement `delete(where)` on the store, or index upsert-only with ' +
        '`indexDocuments(store, embed, chunkDocuments(docs))` — which cannot remove the chunks an edit no longer produces.',
    );
  }
}

/**
 * The partition a document's chunks live in, as a delete condition. A document without a namespace
 * is the root's: `outsideOrganizations` keeps a root re-ingest of `doc` from deleting an
 * organization's `doc` (whose chunks carry the same `source`), on a store that honours it. Through an
 * organization's view (`withOrgStorage(...).vectors`) the view forces its own namespace, and the flag
 * would contradict it, so it is left out there — such a view does not declare it.
 */
function partitionOf(store: VectorStore, namespace: string | undefined): Pick<DeleteWhere, 'namespace' | 'outsideOrganizations'> {
  if (namespace !== undefined) return { namespace };
  return store.deleteOutsideOrganizations === true ? { outsideOrganizations: true } : {};
}

function assertOwnId(id: string, fn: string): void {
  // `source` is shared metadata: observational memory labels every observation vector
  // `source: 'observational-memory'` in the same store. A document with that id would take them all.
  if (id === OM_VECTOR_SOURCE) {
    throw new Error(`@gnldev/rag: ${fn} cannot use the document id '${OM_VECTOR_SOURCE}' — observational memory's vectors carry that \`source\`, and replacing the document would delete them. Give the document another id.`);
  }
}

async function removeDocument(store: VectorStore & { delete: NonNullable<VectorStore['delete']> }, id: string, namespace: string | undefined): Promise<number> {
  const part = partitionOf(store, namespace);
  // By trail: every chunk `chunkDocuments` wrote for this document. By id: a single-chunk version
  // indexed before the trail was stamped, which has none.
  return (await store.delete({ filter: { source: id }, ...part })) + (await store.delete({ ids: [id], ...part }));
}

/**
 * Chunks, embeds and indexes `docs` so each document's stored chunks are exactly its current ones.
 *
 * Per document: its chunks are embedded first, then every chunk it had (`metadata.source === id`, or
 * the bare `id`) is deleted in its namespace, then the new chunks are upserted. Embedding first means a
 * failing embed leaves the previous version in place; between the delete and the upsert a query can
 * see the document missing, never half old and half new.
 *
 * Needs `store.delete`. Without it this throws, naming the upsert-only way through.
 */
export async function ingestDocuments(store: VectorStore, embed: Embed, docs: VectorDoc[], opts?: ChunkOptions): Promise<IngestResult> {
  requireDelete(store, 'ingestDocuments');
  for (const d of docs) assertOwnId(d.id, 'ingestDocuments');
  const perDoc: VectorItem[][] = [];
  for (const doc of docs) {
    const chunks = chunkDocuments([doc], opts);
    perDoc.push(await Promise.all(chunks.map(async (c) => ({ ...c, embedding: await embed(c.text) }))));
  }
  let removed = 0;
  let indexed = 0;
  for (let i = 0; i < docs.length; i++) {
    removed += await removeDocument(store, docs[i]!.id, docs[i]!.namespace);
    if (perDoc[i]!.length) await store.upsert(perDoc[i]!);
    indexed += perDoc[i]!.length;
  }
  return { indexed, removed };
}

/**
 * Removes documents indexed by `ingestDocuments` (or by `indexDocuments` over `chunkDocuments`), every
 * chunk of each, from one namespace — the root's when `namespace` is omitted. Returns the number of
 * chunks removed.
 */
export async function deleteDocuments(store: VectorStore, ids: string[], opts?: { namespace?: string }): Promise<number> {
  requireDelete(store, 'deleteDocuments');
  for (const id of ids) assertOwnId(id, 'deleteDocuments');
  let removed = 0;
  for (const id of ids) removed += await removeDocument(store, id, opts?.namespace);
  return removed;
}
