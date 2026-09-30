// A document is the unit of identity; a chunk is not.
//
// `indexDocuments` upserts chunk by chunk, so re-indexing an edited document only overwrites the
// chunk ids the new text produces. Measured: a document edited from 5 chunks down to 2 left chunks
// #2-#4 of the OLD text retrievable; edited down to one chunk, every `#i` survived beside the new bare
// id. `ingestDocuments` gives the write the document's shape: remove what the document had, then
// write what it has now.
import { assertDeletesOutsideOrganizations, orgStorageScopeOf } from '@gnldev/durable';
import { chunkDocuments, documentIdPart, DOC_TRAIL_KEY, type ChunkOptions } from './chunk.js';
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
 * The partition a document's chunks live in, as a delete condition — decided before anything is
 * embedded, written or deleted.
 *
 *   - a document with a `namespace`: that namespace;
 *   - through an organization's view (`withOrgStorage(...).vectors`): nothing to add, the view forces
 *     its own namespace (and would contradict `outsideOrganizations`);
 *   - otherwise the document is the root's, and the delete must stay outside every organization. A
 *     store that does not declare `deleteOutsideOrganizations` cannot be trusted with that, so it is
 *     refused (the same rule erasure applies): measured, a root re-ingest of `handbook` on such a
 *     store deleted acme's `handbook` (1 → 0).
 */
function partitionOf(store: VectorStore, namespace: string | undefined, fn: string): Pick<DeleteWhere, 'namespace' | 'outsideOrganizations'> {
  if (namespace !== undefined) return { namespace };
  if (orgStorageScopeOf(store) !== undefined) return {};
  assertDeletesOutsideOrganizations(store, `@gnldev/rag: ${fn} (a document with no namespace)`, 'Or give the documents a `namespace`, which keeps the delete inside it.');
  return { outsideOrganizations: true };
}

/**
 * Deletes every chunk of document `id` in `part`, and nothing else:
 *
 *   - by trail (`__gnlDoc === id`) — every chunk `chunkDocuments` writes;
 *   - by the document's own one-chunk id — the id a one-chunk version has always been stored under,
 *     trail or not (0.9.0 stamped none on it);
 *   - 0.9.0's multi-chunk shape, `<id>#<n>` carrying `source: id, chunk: n`, one position at a time
 *     until a gap. The id AND both labels must match, so a record the user merely labelled
 *     `source: id` is left alone.
 *
 * Nothing here reads the user's metadata keys on their own, which is also why observational memory's
 * vectors (`source: 'observational-memory'`, no trail) no longer need a reserved document id.
 */
async function removeDocument(store: VectorStore & { delete: NonNullable<VectorStore['delete']> }, id: string, part: Pick<DeleteWhere, 'namespace' | 'outsideOrganizations'>): Promise<number> {
  let removed = await store.delete({ filter: { [DOC_TRAIL_KEY]: id }, ...part });
  removed += await store.delete({ ids: [documentIdPart(id)], ...part });
  for (let n = 0; ; n++) {
    const legacy = await store.delete({ ids: [`${id}#${n}`], filter: { source: id, chunk: n }, ...part });
    if (legacy === 0) break;
    removed += legacy;
  }
  return removed;
}

/**
 * Chunks, embeds and indexes `docs` so each document's stored chunks are exactly its current ones.
 *
 * Per document: its chunks are embedded first, then every chunk it had (see `removeDocument`) is
 * deleted in its partition, then the new chunks are upserted. Embedding first means a failing embed
 * leaves the previous version in place; between the delete and the upsert a query can see the
 * document missing, never half old and half new.
 *
 * Needs `store.delete`. Without it this throws, naming the upsert-only way through. A document with no
 * `namespace` written to a root store also needs the store to declare `deleteOutsideOrganizations`;
 * without it this throws before anything changes — give the documents a `namespace`, or make the
 * store honour the flag.
 */
export async function ingestDocuments(store: VectorStore, embed: Embed, docs: VectorDoc[], opts?: ChunkOptions): Promise<IngestResult> {
  requireDelete(store, 'ingestDocuments');
  const parts = docs.map((d) => partitionOf(store, d.namespace, 'ingestDocuments'));
  const perDoc: VectorItem[][] = [];
  for (const doc of docs) {
    const chunks = chunkDocuments([doc], opts);
    perDoc.push(await Promise.all(chunks.map(async (c) => ({ ...c, embedding: await embed(c.text) }))));
  }
  let removed = 0;
  let indexed = 0;
  for (let i = 0; i < docs.length; i++) {
    removed += await removeDocument(store, docs[i]!.id, parts[i]!);
    if (perDoc[i]!.length) await store.upsert(perDoc[i]!);
    indexed += perDoc[i]!.length;
  }
  return { indexed, removed };
}

/**
 * Removes documents indexed by `ingestDocuments` (or by `indexDocuments` over `chunkDocuments`), every
 * chunk of each, from one namespace — the root's when `namespace` is omitted, under the same
 * partition rule as `ingestDocuments`. Returns the number of chunks removed.
 */
export async function deleteDocuments(store: VectorStore, ids: string[], opts?: { namespace?: string }): Promise<number> {
  requireDelete(store, 'deleteDocuments');
  const part = partitionOf(store, opts?.namespace, 'deleteDocuments');
  let removed = 0;
  for (const id of ids) removed += await removeDocument(store, id, part);
  return removed;
}
