import { createHash } from 'node:crypto';
import { cosineSimilarity } from 'ai';
import {
  vectorWriteBatch, assertSameVectorOwner, vectorDeletePlan, vectorDeleteMatcher, vectorQueryScope, vectorInOrganization,
  vectorItemCopy, rankVectorMatches, assertVectorDimension,
} from '@gnldev/durable';
import { refuseUnknownNames } from '@gnldev/options';
import type { VectorStore, VectorItem, VectorMatch, QueryOptions, DeleteWhere } from './vector-store.js';
import { keywordScore } from './vector-store.js';
import { CHROMA_VECTOR_STORE_NAMES, QUERY_NAMES } from './option-names.js';
import { restCall, CONFLICT, type RestCall } from './rest-call.js';
import { tieWhole, vectorDigest, TIE_EPSILON } from './tie-whole.js';

export interface ChromaVectorStoreOptions {
  /** Chroma's server address: `http://localhost:8000`, or `https://…` for a TLS endpoint. */
  url: string;
  /** Sent as the `x-chroma-token` header. Never written to an error message or a log. */
  apiKey?: string;
  /** Tenant (default `default_tenant`). */
  tenant?: string;
  /** Database (default `default_database`). */
  database?: string;
  /** Collection name (default `gnl_vectors`). Created on the first write, with the first vector's length. */
  collection?: string;
  /** Vector length the collection is created with; otherwise the first vector's. An existing collection's length wins. */
  dimension?: number;
}

/** A record's metadata as this store writes it: the document's id and labels; the record id is derived (`recordId`). */
interface ChromaMeta {
  gnl_id: string;
  /** The document's metadata as JSON: Chroma's metadata holds scalars and arrays, a document's may hold anything. */
  gnl_meta?: string;
  /** The encoded keys of the metadata's defined values: a filter on `undefined` ("no such key") is `$not_contains`. */
  gnl_keys: string[];
  /** The vector's digest (`vectorDigest`): a tie between copies of one vector is read by it, not by a scan. */
  gnl_vh: string;
  namespace?: string;
  in_org: boolean;
  owner?: string;
  shared?: true;
  /** `m_<key>`: each metadata value as its JSON spelling — the port's `===` on a scalar is equality of this string. */
  [meq: `m_${string}`]: string;
}
interface Collection { id: string; dimension?: number | null; metadata?: { gnl_dim?: number } | null }
interface Hit { id: string; text: string; meta: ChromaMeta; score: number; embedding?: number[] }

/**
 * A Chroma record id for a document under its labels: its namespace, owner, `shared` and id. A write
 * under other labels is another record, so it can never write over this one — Chroma has no conditional
 * write (the same rule, and the same reason, as the Qdrant store's point id).
 */
function recordId(it: { id: string; namespace?: string; owner?: string; shared?: boolean }): string {
  return createHash('sha256').update(JSON.stringify([it.namespace ?? null, it.owner ?? null, it.shared === true, it.id])).digest('hex');
}
/** A metadata key as a field name: letters, digits and `_` only, and injective. */
const metaKey = (k: string) => k.replace(/[^A-Za-z0-9]/g, (c) => `_${c.codePointAt(0)!.toString(16)}_`);
/** A page size for reads. */
const PAGE = 256;
/** Chroma refuses an empty `where`; one clause is itself; more are an `$and`. */
const allOf = (clauses: unknown[]) => (clauses.length === 0 ? undefined : clauses.length === 1 ? clauses[0] : { $and: clauses });

/**
 * VectorStore on Chroma (1.x), through its v2 REST API, with no dependency.
 *
 * The rules are the port's, imported from @gnldev/durable and not restated: the write rule
 * (`vectorWriteBatch`, `assertSameVectorOwner`), the length rule (`assertVectorDimension`), the filter
 * and partition rule (`vectorQueryScope`, `vectorDeletePlan`, `vectorDeleteMatcher`), the ranking rule
 * (`rankVectorMatches`: score, then id). The vector kit (`vectorStoreConformance`) holds it to them.
 *
 * What Chroma needs translated, and how (measured on 1.0, raporlar/2026-10-19-chroma):
 * - Ids: the document's id is in the metadata (`gnl_id`); the record is `recordId`, so labels never collide.
 * - The filter's `===`: every metadata value is also stored as its JSON spelling (`m_<key>`), and a scalar
 *   filter is equality of that string: 1 and "1" differ, null is a value, a scalar never matches inside an
 *   array. "No such key" is `$not_contains` on `gnl_keys` — Chroma's `$ne` also matches a record
 *   without the key, which is the opposite question.
 * - The filter narrows BEFORE ranking: it is the query's `where`, not a pass over the results.
 * - Scores: the collection is cosine; Chroma answers a distance, the score is 1 − distance. A zero vector
 *   on either side answers distance 1, so it scores 0 (finite).
 * - Ties: Chroma's search is approximate (HNSW), and among equal vectors it does not even reach them all:
 *   300 identical vectors, `n_results` 384, came back 212–300 of 300 (10 rounds, `ef_search` 1000 no
 *   better). So when the one past the cut ties the last one, the tie is read whole and scored here, and
 *   the port's ranking (equal scores by id) cuts topK. A tie between copies of one vector — the usual
 *   one, a text ingested twice — is read by the vectors' digests (`gnl_vh`), within the same `where`
 *   (`tieWhole`, shared with the Weaviate store). Away from a tie the answer is Chroma's, approximate as
 *   any HNSW index is.
 */
export class ChromaVectorStore implements VectorStore {
  readonly rootOutsideOrganizations = true;
  private readonly name: string;
  private readonly base: string;
  private dimension?: number;
  private id?: string;
  private ready?: Promise<void>;
  private readonly call: RestCall;

  constructor(opts: ChromaVectorStoreOptions) {
    refuseUnknownNames('ChromaVectorStore', opts, CHROMA_VECTOR_STORE_NAMES);
    if (typeof opts.url !== 'string' || !/^https?:\/\//.test(opts.url)) {
      throw new TypeError('@gnldev/rag: ChromaVectorStore needs `url`, an http:// or https:// address of Chroma\'s server');
    }
    this.name = opts.collection ?? 'gnl_vectors';
    const tenant = opts.tenant ?? 'default_tenant';
    const database = opts.database ?? 'default_database';
    for (const [what, v] of [['collection', this.name], ['tenant', tenant], ['database', database]] as const) {
      if (!/^[A-Za-z0-9_-]+$/.test(v)) throw new TypeError(`@gnldev/rag: a Chroma ${what} name holds letters, digits, \`_\` and \`-\` only`);
    }
    this.base = `/api/v2/tenants/${tenant}/databases/${database}/collections`;
    this.dimension = opts.dimension;
    this.call = restCall(opts.url, {
      name: 'Chroma', headers: opts.apiKey ? { 'x-chroma-token': opts.apiKey } : {}, result: (j) => j, detail: (j) => j?.message ?? j?.error,
    });
  }

  /** The collection as Chroma holds it, or `undefined` when there is none yet. Its length is Chroma's, else the one it was made with. */
  private async existing(): Promise<{ id: string; dimension?: number } | undefined> {
    const c = await this.call('GET', `${this.base}/${this.name}`, undefined, true) as Collection | undefined;
    if (!c) return undefined;
    return { id: c.id, dimension: c.dimension ?? c.metadata?.gnl_dim ?? undefined };
  }

  /** The collection, made with `dim` if there is none. Two processes making it at once: the loser reads the winner's. */
  private ensureReady(dim: number): Promise<void> {
    if (!this.ready) {
      const booting = (async () => {
        let c = await this.existing();
        if (!c) {
          const want = this.dimension ?? dim;
          const made = await this.call('POST', this.base, { name: this.name, configuration: { hnsw: { space: 'cosine' } }, metadata: { gnl_dim: want } }, false, true);
          c = made === CONFLICT ? await this.existing() : { id: (made as Collection).id, dimension: want };
          if (!c) throw new Error(`@gnldev/rag: Chroma collection ${this.name} was made by another process and is gone again`);
        }
        this.id = c.id;
        this.dimension = c.dimension ?? this.dimension ?? dim;
      })();
      this.ready = booting;
      booting.catch(() => { if (this.ready === booting) this.ready = undefined; });
    }
    return this.ready;
  }

  /** The collection's id and length when it exists, without making it. */
  private async current(): Promise<{ id: string; dimension?: number } | undefined> {
    if (this.ready) { await this.ready; return { id: this.id!, dimension: this.dimension }; }
    return this.existing();
  }

  async upsert(items: VectorItem[]): Promise<void> {
    if (items.length === 0) return;
    const batch = vectorWriteBatch(items).map(vectorItemCopy);
    // The length rule against what the collection holds, before anything is written.
    assertVectorDimension((await this.current())?.dimension ?? this.dimension, batch[0]!.embedding.length, 'write');
    await this.ensureReady(batch[0]!.embedding.length);
    assertVectorDimension(this.dimension, batch[0]!.embedding.length, 'write');
    const before = await this.byDocumentId(this.id!, batch.map((it) => it.id));
    for (const it of batch) assertSameVectorOwner(before.find((r) => r.meta.gnl_id === it.id)?.meta, it);
    await this.call('POST', `${this.base}/${this.id}/upsert`, {
      ids: batch.map(recordId), embeddings: batch.map((it) => it.embedding), documents: batch.map((it) => it.text), metadatas: batch.map(toMeta),
    });
    // After the write: a racing writer that made the same id under other labels in the meantime. Both
    // sides see the other and withdraw their NEW records, so nobody gets the id — the rule one batch naming
    // one id under two owners follows. A record that was there before under the same labels is not new and stays.
    const after = await this.byDocumentId(this.id!, batch.map((it) => it.id));
    const clash = batch.find((it) => after.some((r) => r.meta.gnl_id === it.id && r.id !== recordId(it)));
    if (clash) {
      const existed = new Set(before.map((r) => r.id));
      const fresh = batch.map(recordId).filter((id) => !existed.has(id));
      if (fresh.length) await this.call('POST', `${this.base}/${this.id}/delete`, { ids: fresh });
      assertSameVectorOwner(after.find((r) => r.meta.gnl_id === clash.id && r.id !== recordId(clash))!.meta, clash);
    }
  }

  /** Every record carrying one of these document ids, under any labels. */
  private byDocumentId(id: string, ids: string[]): Promise<Hit[]> {
    return this.readAll(id, { gnl_id: { $in: [...new Set(ids)] } });
  }

  private async readAll(id: string, where: unknown, embeddings = false): Promise<Hit[]> {
    const out: Hit[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const r = await this.call('POST', `${this.base}/${id}/get`, {
        ...(where ? { where } : {}), limit: PAGE, offset, include: ['metadatas', 'documents', ...(embeddings ? ['embeddings'] : [])],
      }) as { ids: string[]; documents: string[]; metadatas: ChromaMeta[]; embeddings?: number[][] };
      r.ids.forEach((rid, i) => out.push({ id: rid, text: r.documents[i] ?? '', meta: r.metadatas[i]!, score: 0, ...(embeddings ? { embedding: r.embeddings![i]! } : {}) }));
      if (r.ids.length < PAGE) return out;
    }
  }

  async query(embedding: number[], topK: number, opts?: QueryOptions): Promise<VectorMatch[]> {
    refuseUnknownNames('query', opts, QUERY_NAMES);
    const scope = vectorQueryScope(opts);
    const c = await this.current();
    assertVectorDimension(c?.dimension ?? this.dimension, embedding.length, 'query');
    if (scope.none || topK <= 0 || !c) return [];
    const where: unknown[] = [];
    if (scope.namespace !== undefined) where.push({ namespace: scope.namespace });
    if (scope.outsideOrganizations) where.push({ in_org: false });
    if (scope.visibleTo !== undefined) where.push({ $or: [{ shared: true }, { owner: scope.visibleTo }] });
    where.push(...filterClauses(opts?.filter));
    const w = opts?.keywordWeight ?? 0;
    const hybrid = w > 0 && !!opts?.text;
    const limit = hybrid ? Math.max(topK * 4, 50) : topK;
    // One more than asked: when the one past the cut scores what the last one does, the cut falls inside
    // a tie, which Chroma neither orders by id nor answers whole — so it is decided on the exact scores.
    let hits = await this.search(c.id, embedding, allOf(where), limit + 1);
    const last = hits[limit - 1];
    const next = hits[limit];
    if (!hybrid && last && next && next.score >= last.score - TIE_EPSILON) {
      hits = await tieWhole(hits, last.score, {
        score: (h) => h.score,
        digest: (h) => h.meta.gnl_vh,
        bestOutside: async (digests) => (await this.search(c.id, embedding, allOf([...where, { gnl_vh: { $nin: digests } }]), 1))[0],
        scored: (digests) => this.scored(c.id, embedding, allOf(digests ? [...where, { gnl_vh: { $in: digests } }] : where)),
      });
    }
    let out = hits.map((h) => toMatch(h, hybrid ? (1 - w) * h.score + w * keywordScore(opts!.text!, h.text) : h.score));
    if (opts?.minScore !== undefined) out = out.filter((m) => m.score >= opts.minScore!);
    return rankVectorMatches(out, topK);
  }

  /** The records `where` selects, scored here against `embedding`. */
  private async scored(id: string, embedding: number[], where: unknown): Promise<Hit[]> {
    return (await this.readAll(id, where, true)).map((h) => ({ ...h, score: cosineSimilarity(embedding, h.embedding!) }));
  }

  private async search(id: string, vector: number[], where: unknown, n: number): Promise<Hit[]> {
    const r = await this.call('POST', `${this.base}/${id}/query`, {
      query_embeddings: [vector], n_results: n, include: ['metadatas', 'documents', 'distances'], ...(where ? { where } : {}),
    }) as { ids: string[][]; documents: string[][]; metadatas: ChromaMeta[][]; distances: number[][] };
    return (r.ids[0] ?? []).map((rid, i) => ({ id: rid, text: r.documents[0]![i] ?? '', meta: r.metadatas[0]![i]!, score: 1 - r.distances[0]![i]! }));
  }

  async delete(where: DeleteWhere): Promise<number> {
    const w = vectorDeletePlan(where);
    if (!w) return 0;
    const c = await this.current();
    if (!c) return 0;
    // Narrowed in Chroma by what it can answer exactly, then held to the port's matcher in code: the
    // matcher decides, the narrowing only saves reading records the matcher would not take.
    const clauses: unknown[] = [];
    if (w.ids) clauses.push({ gnl_id: { $in: [...new Set(w.ids)] } });
    if (w.namespace !== undefined) clauses.push({ namespace: w.namespace });
    if (w.owner !== undefined) clauses.push({ owner: w.owner });
    if (w.outsideOrganizations) clauses.push({ in_org: false });
    clauses.push(...filterClauses(w.filter));
    const gone = vectorDeleteMatcher(w);
    const doomed = (await this.readAll(c.id, allOf(clauses)))
      .filter(({ meta: m }) => gone({ id: m.gnl_id, namespace: m.namespace, owner: m.owner, metadata: metadataOf(m) }));
    if (doomed.length) await this.call('POST', `${this.base}/${c.id}/delete`, { ids: doomed.map((r) => r.id) });
    return doomed.length;
  }
}

function filterClauses(filter: Record<string, unknown> | undefined): unknown[] {
  return Object.entries(filter ?? {}).map(([k, v]) => (v === undefined
    ? { gnl_keys: { $not_contains: metaKey(k) } }
    : { [`m_${metaKey(k)}`]: JSON.stringify(v) }));
}

function toMeta(it: VectorItem): ChromaMeta {
  const meta: ChromaMeta = { gnl_id: it.id, gnl_keys: [], gnl_vh: vectorDigest(it.embedding), in_org: vectorInOrganization(it.namespace) };
  for (const [k, v] of Object.entries(it.metadata ?? {})) {
    if (v === undefined) continue;
    meta[`m_${metaKey(k)}`] = JSON.stringify(v);
    meta.gnl_keys.push(metaKey(k));
  }
  if (it.metadata) meta.gnl_meta = JSON.stringify(it.metadata);
  if (it.namespace !== undefined) meta.namespace = it.namespace;
  if (it.owner !== undefined) meta.owner = it.owner;
  if (it.shared) meta.shared = true;
  return meta;
}

const metadataOf = (m: ChromaMeta): Record<string, unknown> | undefined => (m.gnl_meta === undefined ? undefined : JSON.parse(m.gnl_meta));

function toMatch(h: Hit, score: number): VectorMatch {
  return {
    id: h.meta.gnl_id, text: h.text, metadata: metadataOf(h.meta), namespace: h.meta.namespace,
    ...(h.meta.owner !== undefined ? { owner: h.meta.owner } : {}), ...(h.meta.shared ? { shared: true } : {}), score,
  };
}
