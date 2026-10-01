// A document is the unit of identity; a chunk is not.
//
// `indexDocuments` upserts chunk by chunk, so re-indexing an edited document only overwrites the
// chunk ids the new text produces. Measured: a document edited from 5 chunks down to 2 left chunks
// #2-#4 of the OLD text retrievable; edited down to one chunk, every `#i` survived beside the new bare
// id. `ingestDocuments` gives the write the document's shape: write what the document has now as a new
// generation, then remove every other generation.
import { assertDeletesOutsideOrganizations, orgPrefix, orgStorageScopeOf, vectorWriteBatch, OBSERVATION_VECTOR_KEY } from '@gnldev/durable';
import { chunkDocuments, DOC_TRAIL_KEY, CHUNK_TRAIL_KEY, GEN_TRAIL_KEY, documentIdPart, type ChunkOptions } from './chunk.js';
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
 * How many 0.9.0 chunk positions one delete names. 0.9.0 wrote `<id>#0 … <id>#<n-1>`; a position can be
 * missing (another document called `<id>#<n>` overwrote it), so the scan goes on in blocks and stops
 * only at a block with nothing of the document's in it.
 */
const LEGACY_SCAN_BLOCK = 64;

/** A position-shaped id: `<prefix>#<digits>` — 0.9.0's chunk id, and the current one. */
const CHUNK_POSITION = /#\d+$/;

/**
 * Deletes every record of document `id` in `part` — the ones that are provably its — and nothing else:
 *
 *   - by trail (`__gnlDoc === id`): every chunk `chunkDocuments` writes now;
 *   - 0.9.0's one-chunk shape: the document as given, under its RAW id, no trail. A record at that id
 *     is left alone when it carries a trail (another document's current record — `q#x` is stored at
 *     `q%23x`), or an observation's id (`OBSERVATION_VECTOR_KEY`, observational memory's vectors), or — for an id shaped
 *     like a chunk position, `<p>#<n>` — both `source` and `chunk` (that is `p`'s 0.9.0 chunk);
 *   - 0.9.0's multi-chunk shape: `<id>#<n>` carrying `source: id`, scanned in blocks so a missing
 *     position does not end the scan. The id shape AND the label must match, so a record the user
 *     merely labelled `source: id` is left alone.
 *
 * "Left alone when it carries a key" is a filter whose value is `undefined`: it matches a record
 * WITHOUT that key (`DeleteWhere.filter`). The user's own metadata is never matched on its own.
 */
async function removeDocument(store: VectorStore & { delete: NonNullable<VectorStore['delete']> }, id: string, part: Pick<DeleteWhere, 'namespace' | 'outsideOrganizations'>): Promise<number> {
  const removed = await store.delete({ filter: { [DOC_TRAIL_KEY]: id }, ...part });
  return removed + await removeLegacyRecords(store, id, part);
}

/** 0.9.0's records of document `id` — the untrailed shapes `removeDocument` describes. */
async function removeLegacyRecords(store: Pick<Required<VectorStore>, 'delete'>, id: string, part: Pick<DeleteWhere, 'namespace' | 'outsideOrganizations'>): Promise<number> {
  let removed = 0;
  const untrailed = { [DOC_TRAIL_KEY]: undefined, [OBSERVATION_VECTOR_KEY]: undefined };
  if (CHUNK_POSITION.test(id)) {
    removed += await store.delete({ ids: [id], filter: { ...untrailed, chunk: undefined }, ...part });
    removed += await store.delete({ ids: [id], filter: { ...untrailed, source: undefined }, ...part });
  } else {
    removed += await store.delete({ ids: [id], filter: untrailed, ...part });
  }
  for (let from = 0; ; from += LEGACY_SCAN_BLOCK) {
    const block = Array.from({ length: LEGACY_SCAN_BLOCK }, (_, i) => `${id}#${from + i}`);
    const legacy = await store.delete({ ids: block, filter: { source: id }, ...part });
    if (legacy === 0) break;
    removed += legacy;
  }
  return removed;
}

/**
 * A generation stamp: sortable as text, and unique — the time, a per-process counter, and a random
 * part for two processes in the same millisecond. Which of two concurrent ingests wins is decided by
 * comparing these, so every process reaches the same answer.
 */
let genSeq = 0;
function newGeneration(): string {
  const seq = (genSeq = (genSeq + 1) % 36 ** 4).toString(36).padStart(4, '0');
  return `${Date.now().toString(36).padStart(9, '0')}${seq}${Math.random().toString(36).slice(2, 8).padEnd(6, '0')}`;
}

/**
 * The partition a generation belongs to, as text — so a listing that reaches past the partition (a
 * root document's listing sees every namespace) never compares this document's generations with
 * another partition's copy of the same id. Through an organization's view it is `org:<id>`, the
 * namespace the view forces whatever the document names — the key a root write naming that namespace
 * gets too.
 */
function partitionKey(store: VectorStore, namespace: string | undefined): string {
  // The view first: it overwrites a document's own `namespace` with the organization's.
  const org = orgStorageScopeOf(store);
  if (org !== undefined) return `ns:${orgPrefix(org).slice(0, -1)}`;
  if (namespace !== undefined) return `ns:${namespace}`;
  return 'root';
}

/** Enough for "every chunk of one document" on any store; a store that caps `topK` lists fewer. */
const LIST_ALL = 1_000_000;

/** An ingest that failed, naming the document and what was already replaced before it. */
function ingestError(id: string, replaced: string[], what: string, cause: unknown): Error {
  const done = replaced.length ? ` Documents already replaced in this call: ${replaced.map((r) => `'${r}'`).join(', ')}.` : '';
  const err = new Error(`@gnldev/rag: ingestDocuments ${what} document '${id}'; its previous version is still in place.${done} (${(cause as Error)?.message ?? String(cause)})`, { cause });
  return Object.assign(err, { documentId: id, replaced });
}

/**
 * Chunks, embeds and indexes `docs` so each document's stored chunks are exactly one version of it.
 *
 * Invariant: when this resolves or rejects, each named document holds either all of its new chunks or
 * all of its previous ones — never a mix of two versions, and never nothing unless the new text is
 * empty. Per document:
 *
 *   1. its chunks are written as a new GENERATION — ids `<id>#<i>@<gen>`, metadata `__gnlGen` —
 *      beside the previous version, which is untouched;
 *   2. the document's chunks are listed (`query` with its trail as the filter) and every generation
 *      but the newest one listed in this partition is deleted, with the 0.9.0 shapes and the chunks of
 *      a write that had no generation (`indexDocuments(chunkDocuments(…))`);
 *   3. when the write or the cleanup fails, this call's chunks are deleted again and the error names
 *      the document and the documents this call had already replaced.
 *
 * Measured before (delete, then upsert, at the positional ids `<id>#<i>`): two concurrent ingests of
 * one document left chunks of BOTH versions in 10 of 10 runs on four stores, and an upsert that failed
 * after the delete left the document with no chunks. Concurrent ingests now converge: each one keeps
 * the newest generation it lists, and the last to list has seen every write before it. While an
 * ingest runs, a query can see both versions in full (never a part of one).
 *
 * Needs `store.delete`, and a `query` that applies `filter` before `topK` (every store in this repo
 * does) and lists all of a document's chunks — an approximate index (pgvector HNSW/IVFFlat) can miss
 * some, which leaves those chunks of an older version behind until the next ingest; it never removes
 * the newest.
 * A document with no `namespace` written to a root store also needs the store to declare
 * `deleteOutsideOrganizations`; without it this throws before anything changes — give the documents a
 * `namespace`, or make the store honour the flag.
 */
export async function ingestDocuments(store: VectorStore, embed: Embed, docs: VectorDoc[], opts?: ChunkOptions): Promise<IngestResult> {
  requireDelete(store, 'ingestDocuments');
  const parts = docs.map((d) => partitionOf(store, d.namespace, 'ingestDocuments'));
  // Every chunk is checked against the one vector write rule BEFORE anything is embedded or written:
  // an id a store cannot hold used to fail at that document's upsert, after the documents before it
  // had already been replaced.
  const chunked = docs.map((doc) => chunkDocuments([doc], opts));
  vectorWriteBatch(chunked.flat());
  const perDoc: VectorItem[][] = [];
  for (const chunks of chunked) {
    perDoc.push(await Promise.all(chunks.map(async (c) => ({ ...c, embedding: await embed(c.text) }))));
  }
  let removed = 0;
  let indexed = 0;
  const replaced: string[] = [];
  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i]!;
    const part = parts[i]!;
    const items = perDoc[i]!;
    if (items.length === 0) {
      // No text, no version to keep: the document is removed, as `deleteDocuments` would.
      removed += await removeDocument(store, doc.id, part);
      replaced.push(doc.id);
      continue;
    }
    const gen = `${partitionKey(store, doc.namespace)}|${newGeneration()}`;
    const idPart = documentIdPart(doc.id);
    const written = items.map((it) => ({
      ...it,
      id: `${idPart}#${String(it.metadata?.[CHUNK_TRAIL_KEY] ?? 0)}@${gen.slice(gen.indexOf('|') + 1)}`,
      metadata: { ...it.metadata, [GEN_TRAIL_KEY]: gen },
    }));
    const ids = written.map((w) => w.id);
    const undo = async () => { try { await store.delete({ ids, ...part }); } catch { /* the error below says what is left */ } };
    try {
      await store.upsert(written);
    } catch (e) {
      await undo();
      throw ingestError(doc.id, replaced, 'could not write', e);
    }
    // The first delete that removes something is the commit point: before it, undoing this write
    // leaves the previous version whole; after it, the new version is the one to keep.
    const tracked = { removed: 0 };
    const counting = { delete: async (w: DeleteWhere) => { const n = await store.delete(w); tracked.removed += n; return n; } } as typeof store;
    try {
      await removeOtherGenerations(store, counting, doc, gen, written[0]!.embedding, part);
      await removeLegacyRecords(counting, doc.id, part);
    } catch (e) {
      if (tracked.removed === 0) {
        await undo();
        throw ingestError(doc.id, replaced, 'could not remove the previous version of', e);
      }
      throw Object.assign(new Error(
        `@gnldev/rag: ingestDocuments wrote document '${doc.id}' but could not finish removing its previous version — ` +
          `run ingestDocuments again for it.${replaced.length ? ` Documents already replaced in this call: ${replaced.map((r) => `'${r}'`).join(', ')}.` : ''} ` +
          `(${(e as Error)?.message ?? String(e)})`, { cause: e }), { documentId: doc.id, replaced });
    }
    removed += tracked.removed;
    indexed += written.length;
    replaced.push(doc.id);
  }
  return { indexed, removed };
}

/**
 * Deletes every chunk of `doc` in its partition that is not of the newest generation listed — which
 * is `gen` unless a concurrent ingest wrote a newer one, in which case this call's own chunks go. A
 * chunk with no generation (written by `indexDocuments`, or before generations) is never the newest.
 *
 * Only conditions every store reads the same way: the listed ids, guarded by the document's trail
 * (and the stale generation's stamp). NOT by `{ __gnlGen: undefined }`: a store that serialises the filter to JSON drops that key, and the
 * delete would have taken the new generation with the old (measured on a 0.9.0-contract store: the
 * document was left with no chunks).
 */
async function removeOtherGenerations(store: VectorStore, del: Pick<Required<VectorStore>, 'delete'>, doc: VectorDoc, gen: string, probe: number[], part: Pick<DeleteWhere, 'namespace' | 'outsideOrganizations'>): Promise<number> {
  const prefix = gen.slice(0, gen.indexOf('|') + 1);
  const listed = await store.query(probe, LIST_ALL, { filter: { [DOC_TRAIL_KEY]: doc.id }, ...(doc.namespace !== undefined ? { namespace: doc.namespace } : {}) });
  // Listed ids per generation ('' = no generation). The deletes name these ids, so they cost an id
  // lookup rather than another scan of the store; the filter beside the ids is the guard that keeps
  // an id from ever reaching another document's record.
  const byGen = new Map<string, string[]>([[gen, []]]);
  for (const m of listed) {
    const g = m.metadata?.[GEN_TRAIL_KEY];
    const key = typeof g !== 'string' ? '' : g.startsWith(prefix) ? g : undefined;
    if (key === undefined) continue; // another partition's copy of this id
    byGen.set(key, [...(byGen.get(key) ?? []), m.id]);
  }
  const newest = [...byGen.keys()].filter((g) => g !== '').sort().at(-1)!;
  let removed = 0;
  for (const [g, ids] of byGen) {
    if (g === newest || ids.length === 0) continue;
    removed += await del.delete({ ids, filter: { [DOC_TRAIL_KEY]: doc.id, ...(g ? { [GEN_TRAIL_KEY]: g } : {}) }, ...part });
  }
  return removed;
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
