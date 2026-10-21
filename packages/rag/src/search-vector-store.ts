import { createHash } from 'node:crypto';
import { cosineSimilarity } from 'ai';
import {
  vectorWriteBatch, assertSameVectorOwner, vectorDeletePlan, vectorDeleteMatcher, vectorQueryScope, vectorInOrganization,
  vectorItemCopy, rankVectorMatches, assertVectorDimension,
} from '@gnldev/durable';
import { refuseUnknownNames } from '@gnldev/options';
import type { VectorStore, VectorItem, VectorMatch, QueryOptions, DeleteWhere } from './vector-store.js';
import { keywordScore } from './vector-store.js';
import { ELASTICSEARCH_VECTOR_STORE_NAMES, OPENSEARCH_VECTOR_STORE_NAMES, QUERY_NAMES } from './option-names.js';
import { restCall, NdJson, type RestCall } from './rest-call.js';
import { tieWhole, vectorDigest, TIE_EPSILON } from './tie-whole.js';

export interface ElasticsearchVectorStoreOptions {
  /** Elasticsearch's address: `http://localhost:9200`, or `https://…` (Elastic Cloud). */
  url: string;
  /** An API key, sent as `Authorization: ApiKey …`. Never written to an error message or a log. */
  apiKey?: string;
  /** Index name (default `gnl_vectors`): lowercase letters, digits, `_` and `-`. Created on the first write. */
  index?: string;
  /** Vector length the index is created with; otherwise the first vector's. An existing index's length wins. */
  dimension?: number;
  /** How long one call to the server may take, from sending it to the answer's last byte (default 30 000 ms). Past it the call fails; a write may still have landed, and the same upsert again is safe. */
  timeoutMs?: number;
}

export interface OpenSearchVectorStoreOptions {
  /** OpenSearch's address: `http://localhost:9200`, or `https://…`. */
  url: string;
  /** HTTP basic credentials, sent as `Authorization: Basic …`. Never written to an error message or a log. */
  auth?: { username: string; password: string };
  /** Index name (default `gnl_vectors`): lowercase letters, digits, `_` and `-`. Created on the first write. */
  index?: string;
  /** Vector length the index is created with; otherwise the first vector's. An existing index's length wins. */
  dimension?: number;
  /** How long one call to the server may take, from sending it to the answer's last byte (default 30 000 ms). Past it the call fails; a write may still have landed, and the same upsert again is safe. */
  timeoutMs?: number;
}

/** A document as this store writes it. */
interface SearchDoc {
  /** The vector normalized to length 1 (a zero vector stays zero): what the kNN index searches by inner product. */
  v: number[];
  /** The vector as written: what scores are computed from and what a read hands back. */
  raw: number[];
  /** The record id again, as a sortable keyword: reads page by it. */
  rid: string;
  gnl_id: string;
  text: string;
  /** The document's metadata as JSON. */
  meta?: string;
  /** `<key>=<digest of the value's JSON>` for each defined metadata value: the port's `===` on a scalar is a term. */
  kv: string[];
  /** The encoded keys of the metadata's defined values: a filter on `undefined` ("no such key") is a `must_not` term. */
  keys: string[];
  /** The vector's digest (`vectorDigest`): a tie between copies of one vector is read by it, not by a search. */
  vh: string;
  namespace?: string;
  owner?: string;
  in_org: boolean;
  shared: boolean;
}
interface Hit { id: string; doc: SearchDoc; score: number }
type Clause = Record<string, unknown>;

/** What differs between Elasticsearch and OpenSearch: the vector field and the kNN query. */
interface Dialect {
  name: 'Elasticsearch' | 'OpenSearch';
  vectorField(dimension: number): Record<string, unknown>;
  settings?: Record<string, unknown>;
  /** The length an existing index's vector field was made with. */
  dimensionOf(field: Record<string, unknown> | undefined): number | undefined;
  /** A search body asking for the `k` nearest to `vector` among the documents `filter` selects. */
  knn(vector: number[], k: number, filter: Clause): Record<string, unknown>;
}

const ELASTICSEARCH: Dialect = {
  name: 'Elasticsearch',
  // Inner product over normalized vectors is cosine — and, unlike `cosine`, it takes a zero vector
  // (`cosine` refuses one at write, measured on 9.4). `hnsw`, not the default quantized index: a
  // quantized score moved 1 to 2.0000067 and 0 to 0.9988 (measured), and a tie is decided on scores.
  vectorField: (dims) => ({ type: 'dense_vector', dims, index: true, similarity: 'max_inner_product', index_options: { type: 'hnsw' } }),
  dimensionOf: (f) => f?.dims as number | undefined,
  knn: (vector, k, filter) => ({ knn: { field: 'v', query_vector: vector, k, num_candidates: Math.max(100, k), filter }, size: k }),
};
const OPENSEARCH: Dialect = {
  name: 'OpenSearch',
  // `cosinesimil` refuses a zero vector at write as `cosine` does (measured on 3.9); inner product over
  // normalized vectors is cosine and takes it.
  vectorField: (dimension) => ({ type: 'knn_vector', dimension, space_type: 'innerproduct', method: { name: 'hnsw', engine: 'lucene' } }),
  settings: { index: { knn: true } },
  dimensionOf: (f) => f?.dimension as number | undefined,
  knn: (vector, k, filter) => ({ size: k, query: { knn: { v: { vector, k, filter } } } }),
};

/**
 * A document id for a document under its labels: its namespace, owner, `shared` and id. A write under
 * other labels is another document, so it can never write over this one (the same rule, and the same
 * reason, as the Qdrant store's point id).
 */
function recordId(it: { id: string; namespace?: string; owner?: string; shared?: boolean }): string {
  return createHash('sha256').update(JSON.stringify([it.namespace ?? null, it.owner ?? null, it.shared === true, it.id])).digest('hex');
}
/** A metadata key as a term: letters, digits and `_` only, and injective (so never `=`). */
const metaKey = (k: string) => k.replace(/[^A-Za-z0-9]/g, (c) => `_${c.codePointAt(0)!.toString(16)}_`);
/** A metadata value as a term of bounded length: a keyword term holds at most 32 766 bytes, a value may not. */
const valueTerm = (k: string, v: unknown) => `${metaKey(k)}=${createHash('sha256').update(JSON.stringify(v)).digest('hex')}`;
const normalized = (v: number[]) => {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return n === 0 ? v.map(() => 0) : v.map((x) => x / n);
};
/** A page size for reads and bulk writes. */
const PAGE = 500;
const keyword = { type: 'keyword' };
const stored = { type: 'keyword', index: false, doc_values: false };

/**
 * VectorStore on Elasticsearch (9.x) or OpenSearch (3.x), through the REST API, with no dependency.
 * `ElasticsearchVectorStore` and `OpenSearchVectorStore` differ only in the vector field and the kNN
 * query (`Dialect`); everything else is this class.
 *
 * The rules are the port's, imported from @gnldev/durable and not restated: the write rule
 * (`vectorWriteBatch`, `assertSameVectorOwner`), the length rule (`assertVectorDimension`), the filter
 * and partition rule (`vectorQueryScope`, `vectorDeletePlan`, `vectorDeleteMatcher`), the ranking rule
 * (`rankVectorMatches`: score, then id). The vector kit (`vectorStoreConformance`) holds it to them.
 *
 * What the servers need translated, and how (measured on Elasticsearch 9.4 and OpenSearch 3.9,
 * raporlar/2026-10-21-search):
 * - Ids: the document id is `recordId`; the document's own id is a keyword (`gnl_id`).
 * - Exact match: labels are keyword fields (no analyzer: case and whitespace kept, measured); the index
 *   is `dynamic: strict`, so a field it does not declare is refused rather than guessed.
 * - The filter's `===`: each metadata value as `<key>=<digest of its JSON>` in one keyword list (`kv`),
 *   a scalar filter is a term: 1 and "1" differ, null is a value, a scalar never matches inside an
 *   array. "No such key" is `must_not` a term on `keys`.
 * - The filter narrows BEFORE ranking: it is the kNN query's filter, not a pass over the results.
 * - Scores: computed here, cosine of the vectors as written (`raw`); the index only finds candidates.
 * - Ties: the kNN search orders equal scores its own way, not by id (3,000 copies of one vector came back
 *   d2454, d66, d1941…; it did reach all 3,000 here, unlike Weaviate's search, but HNSW does not promise
 *   to), so a cut inside a tie is decided on exact scores (`tieWhole`, shared with the Chroma and
 *   Weaviate stores), read by the vectors' digests (`vh`).
 * - Visibility: a write is searchable only after a refresh (measured: 0 of 10 found at once), and the
 *   owner check reads back what was just written, so every write and delete asks `refresh=true`.
 * - Reads page by `rid` (`search_after`), exact, any size.
 */
class SearchVectorStore implements VectorStore {
  readonly rootOutsideOrganizations = true;
  private readonly index: string;
  private dimension?: number;
  private ready?: Promise<void>;
  private active?: Promise<void>;
  private readonly call: RestCall;

  constructor(private readonly dialect: Dialect, opts: { url: string; index?: string; dimension?: number; timeoutMs?: number }, headers: Record<string, string>) {
    if (typeof opts.url !== 'string' || !/^https?:\/\//.test(opts.url)) {
      throw new TypeError(`@gnldev/rag: ${dialect.name}VectorStore needs \`url\`, an http:// or https:// address of ${dialect.name}`);
    }
    this.index = opts.index ?? 'gnl_vectors';
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(this.index)) {
      throw new TypeError(`@gnldev/rag: a ${dialect.name} index name holds lowercase letters, digits, \`_\` and \`-\`, and does not start with \`_\` or \`-\``);
    }
    this.dimension = opts.dimension;
    this.call = restCall(opts.url, {
      name: dialect.name, timeoutMs: opts.timeoutMs, headers, result: (j) => j,
      detail: (j) => j?.error?.root_cause?.[0]?.reason ?? j?.error?.reason ?? j?.error?.type ?? j?.error,
    });
  }

  /** The index's vector length, or `undefined` when there is no index yet. */
  private async existing(): Promise<number | undefined> {
    const m = await this.call('GET', `/${this.index}/_mapping`, undefined, true) as Record<string, { mappings?: { properties?: Record<string, Record<string, unknown>> } }> | undefined;
    if (!m) return undefined;
    await this.whenActive();
    const props = Object.values(m)[0]?.mappings?.properties;
    const dims = this.dialect.dimensionOf(props?.v);
    if (!props?.gnl_id || dims === undefined) {
      throw new Error(`@gnldev/rag: ${this.dialect.name} index ${this.index} exists but was not made by this store (no \`v\`/\`gnl_id\` fields); use another index name`);
    }
    return dims;
  }

  /**
   * Waits, once, until every primary shard of the index is active. An index another process has just
   * made exists before it can answer: the maker's create returns when its shards are up, but a second
   * maker is told "already exists" at once, and its first search answered 503
   * `no_shard_available_action_exception` — 20 of 20 races on Elasticsearch 9.4 and OpenSearch 3.9. A
   * health wait for `yellow` does not help: the cluster is already yellow, and it answered at once with
   * `active_primary_shards: 0` (raporlar/2026-10-21-search, race*.txt). So the index's own count is read
   * until its primaries are all active, every 50 ms, for at most 30 s.
   */
  private whenActive(): Promise<void> {
    if (!this.active) {
      const waiting = (async () => {
        for (const until = Date.now() + 30_000; ;) {
          const h = await this.call('GET', `/_cluster/health/${this.index}?level=indices`) as { indices?: Record<string, { number_of_shards?: number; active_primary_shards?: number }> };
          const i = h.indices?.[this.index];
          if (i && (i.number_of_shards ?? 0) > 0 && i.active_primary_shards === i.number_of_shards) return;
          if (Date.now() > until) throw new Error(`@gnldev/rag: ${this.dialect.name} index ${this.index}'s shards did not become active within 30 s`);
          await new Promise((r) => setTimeout(r, 50));
        }
      })();
      this.active = waiting;
      waiting.catch(() => { if (this.active === waiting) this.active = undefined; });
    }
    return this.active;
  }

  /** The index, made with `dim` if there is none. Two processes making it at once: the loser reads the winner's. */
  private ensureReady(dim: number): Promise<void> {
    if (!this.ready) {
      const booting = (async () => {
        const size = await this.existing();
        if (size !== undefined) { this.dimension = size; return; }
        const want = this.dimension ?? dim;
        try {
          await this.call('PUT', `/${this.index}`, {
            ...(this.dialect.settings ? { settings: this.dialect.settings } : {}),
            mappings: {
              dynamic: 'strict',
              properties: {
                v: this.dialect.vectorField(want), raw: { type: 'float', index: false, doc_values: false }, rid: keyword,
                gnl_id: keyword, text: stored, meta: stored, kv: keyword, keys: keyword, vh: keyword,
                namespace: keyword, owner: keyword, in_org: { type: 'boolean' }, shared: { type: 'boolean' },
              },
            },
          });
          this.dimension = want;
        } catch (e) {
          // 400 resource_already_exists_exception: another process made it first, and its length wins.
          if ((e as { status?: number }).status !== 400 || !/already.exists/i.test(String((e as Error).message))) throw e;
          this.dimension = await this.existing();
        }
      })();
      this.ready = booting;
      booting.catch(() => { if (this.ready === booting) this.ready = undefined; });
    }
    return this.ready;
  }

  /** Whether the index exists, and its length, without making it. */
  private async current(): Promise<{ dimension?: number } | undefined> {
    if (this.ready) { await this.ready; return { dimension: this.dimension }; }
    const size = await this.existing();
    return size === undefined ? undefined : { dimension: size };
  }

  async upsert(items: VectorItem[]): Promise<void> {
    if (items.length === 0) return;
    const batch = vectorWriteBatch(items).map(vectorItemCopy);
    // The length rule against what the index holds, before anything is written.
    assertVectorDimension((await this.current())?.dimension ?? this.dimension, batch[0]!.embedding.length, 'write');
    await this.ensureReady(batch[0]!.embedding.length);
    assertVectorDimension(this.dimension, batch[0]!.embedding.length, 'write');
    const before = await this.byDocumentId(batch.map((it) => it.id));
    for (const it of batch) assertSameVectorOwner(before.find((r) => r.doc.gnl_id === it.id)?.doc, it);
    for (let i = 0; i < batch.length; i += PAGE) {
      await this.bulk(batch.slice(i, i + PAGE).flatMap((it) => [{ index: { _id: recordId(it) } }, toDoc(it)]));
    }
    // After the write: a racing writer that made the same id under other labels in the meantime. Both
    // sides see the other and withdraw their NEW documents, so nobody gets the id — the rule one batch
    // naming one id under two owners follows. A document that was there before under the same labels stays.
    const after = await this.byDocumentId(batch.map((it) => it.id));
    const clash = batch.find((it) => after.some((r) => r.doc.gnl_id === it.id && r.id !== recordId(it)));
    if (clash) {
      const existed = new Set(before.map((r) => r.id));
      await this.remove(batch.map(recordId).filter((id) => !existed.has(id)));
      assertSameVectorOwner(after.find((r) => r.doc.gnl_id === clash.id && r.id !== recordId(clash))!.doc, clash);
    }
  }

  /** One `_bulk` call, visible to search when it returns; any item the server refused fails the call. */
  private async bulk(lines: unknown[]): Promise<void> {
    if (lines.length === 0) return;
    const r = await this.call('POST', `/${this.index}/_bulk?refresh=true`, new NdJson(lines)) as { errors?: boolean; items?: Array<Record<string, { status?: number; error?: { reason?: string; type?: string } }>> };
    if (!r.errors) return;
    const failed = r.items?.map((it) => Object.values(it)[0]!).find((it) => it.error && it.status !== 404);
    if (failed) throw new Error(`@gnldev/rag: ${this.dialect.name} bulk write refused a document: ${String(failed.error!.reason ?? failed.error!.type).slice(0, 200)}`);
  }

  private remove(ids: string[]): Promise<void> {
    return this.bulk(ids.map((id) => ({ delete: { _id: id } })));
  }

  /** Every document carrying one of these document ids, under any labels. */
  private byDocumentId(ids: string[]): Promise<Hit[]> {
    return this.readAll([{ terms: { gnl_id: [...new Set(ids)] } }]);
  }

  /** Every document the clauses select, a page at a time in `rid` order — exact, any size. */
  private async readAll(filter: Clause[]): Promise<Hit[]> {
    const out: Hit[] = [];
    for (let after: unknown[] | undefined; ;) {
      const r = await this.search({
        size: PAGE, sort: [{ rid: 'asc' }], query: { bool: { filter } }, ...(after ? { search_after: after } : {}),
      });
      out.push(...r.map((h) => h.hit));
      if (r.length < PAGE) return out;
      after = r[r.length - 1]!.sort;
    }
  }

  private async search(body: Record<string, unknown>): Promise<Array<{ hit: Hit; sort?: unknown[] }>> {
    const r = await this.call('POST', `/${this.index}/_search`, { ...body, _source: { excludes: ['v'] } }) as { hits: { hits: Array<{ _id: string; _source: SearchDoc; sort?: unknown[] }> } };
    return r.hits.hits.map((h) => ({ hit: { id: h._id, doc: h._source, score: 0 }, sort: h.sort }));
  }

  /** The `k` nearest to `embedding` among what `filter` selects, scored here from the vectors as written. */
  private async nearest(embedding: number[], filter: Clause[], k: number): Promise<Hit[]> {
    const found = await this.search(this.dialect.knn(normalized(embedding), k, { bool: { filter } }));
    return found.map(({ hit }) => ({ ...hit, score: cosineSimilarity(embedding, hit.doc.raw) }))
      .sort((a, b) => b.score - a.score);
  }

  async query(embedding: number[], topK: number, opts?: QueryOptions): Promise<VectorMatch[]> {
    refuseUnknownNames('query', opts, QUERY_NAMES);
    const scope = vectorQueryScope(opts);
    const c = await this.current();
    assertVectorDimension(c?.dimension ?? this.dimension, embedding.length, 'query');
    if (scope.none || topK <= 0 || !c) return [];
    const filter: Clause[] = [];
    if (scope.namespace !== undefined) filter.push({ term: { namespace: scope.namespace } });
    if (scope.outsideOrganizations) filter.push({ term: { in_org: false } });
    if (scope.visibleTo !== undefined) filter.push({ bool: { should: [{ term: { shared: true } }, { term: { owner: scope.visibleTo } }], minimum_should_match: 1 } });
    filter.push(...filterClauses(opts?.filter));
    const w = opts?.keywordWeight ?? 0;
    const hybrid = w > 0 && !!opts?.text;
    const limit = hybrid ? Math.max(topK * 4, 50) : topK;
    // One more than asked: when the one past the cut scores what the last one does, the cut falls inside
    // a tie, which the index neither orders by id nor answers whole — so it is decided on exact scores.
    let hits = await this.nearest(embedding, filter, limit + 1);
    const last = hits[limit - 1];
    const next = hits[limit];
    if (!hybrid && last && next && next.score >= last.score - TIE_EPSILON) {
      hits = await tieWhole(hits, last.score, {
        score: (h) => h.score,
        digest: (h) => h.doc.vh,
        bestOutside: async (digests) => (await this.nearest(embedding, [...filter, { bool: { must_not: [{ terms: { vh: digests } }] } }], 1))[0],
        scored: async (digests) => (await this.readAll(digests ? [...filter, { terms: { vh: digests } }] : filter))
          .map((h) => ({ ...h, score: cosineSimilarity(embedding, h.doc.raw) })),
      });
    }
    let out = hits.map((h) => toMatch(h, hybrid ? (1 - w) * h.score + w * keywordScore(opts!.text!, h.doc.text) : h.score));
    if (opts?.minScore !== undefined) out = out.filter((m) => m.score >= opts.minScore!);
    return rankVectorMatches(out, topK);
  }

  async delete(where: DeleteWhere): Promise<number> {
    const w = vectorDeletePlan(where);
    if (!w) return 0;
    if (!await this.current()) return 0;
    // Narrowed by the server with what it answers exactly, then held to the port's matcher in code: the
    // matcher decides, the narrowing only saves reading documents the matcher would not take.
    const filter: Clause[] = [];
    if (w.ids) filter.push({ terms: { gnl_id: [...new Set(w.ids)] } });
    if (w.namespace !== undefined) filter.push({ term: { namespace: w.namespace } });
    if (w.owner !== undefined) filter.push({ term: { owner: w.owner } });
    if (w.outsideOrganizations) filter.push({ term: { in_org: false } });
    filter.push(...filterClauses(w.filter));
    const gone = vectorDeleteMatcher(w);
    const doomed = (await this.readAll(filter))
      .filter(({ doc: d }) => gone({ id: d.gnl_id, namespace: d.namespace, owner: d.owner, metadata: metadataOf(d) }));
    for (let i = 0; i < doomed.length; i += PAGE) await this.remove(doomed.slice(i, i + PAGE).map((h) => h.id));
    return doomed.length;
  }
}

function filterClauses(filter: Record<string, unknown> | undefined): Clause[] {
  return Object.entries(filter ?? {}).map(([k, v]) => (v === undefined
    ? { bool: { must_not: [{ term: { keys: metaKey(k) } }] } }
    : { term: { kv: valueTerm(k, v) } }));
}

function toDoc(it: VectorItem): SearchDoc {
  const doc: SearchDoc = {
    v: normalized(it.embedding), raw: it.embedding, rid: recordId(it), gnl_id: it.id, text: it.text, kv: [], keys: [],
    vh: vectorDigest(it.embedding), in_org: vectorInOrganization(it.namespace), shared: it.shared === true,
  };
  for (const [k, v] of Object.entries(it.metadata ?? {})) {
    if (v === undefined) continue;
    doc.kv.push(valueTerm(k, v));
    doc.keys.push(metaKey(k));
  }
  if (it.metadata) doc.meta = JSON.stringify(it.metadata);
  if (it.namespace !== undefined) doc.namespace = it.namespace;
  if (it.owner !== undefined) doc.owner = it.owner;
  return doc;
}

const metadataOf = (d: SearchDoc): Record<string, unknown> | undefined => (d.meta == null ? undefined : JSON.parse(d.meta));

function toMatch(h: Hit, score: number): VectorMatch {
  return {
    id: h.doc.gnl_id, text: h.doc.text ?? '', metadata: metadataOf(h.doc), namespace: h.doc.namespace,
    ...(h.doc.owner !== undefined ? { owner: h.doc.owner } : {}), ...(h.doc.shared ? { shared: true } : {}), score,
  };
}

/** VectorStore on Elasticsearch 9.x (REST, no dependency). See `SearchVectorStore` for what is translated, and how. */
export class ElasticsearchVectorStore extends SearchVectorStore {
  constructor(opts: ElasticsearchVectorStoreOptions) {
    refuseUnknownNames('ElasticsearchVectorStore', opts, ELASTICSEARCH_VECTOR_STORE_NAMES);
    super(ELASTICSEARCH, opts, opts.apiKey ? { authorization: `ApiKey ${opts.apiKey}` } : {});
  }
}

/** VectorStore on OpenSearch 3.x (REST, no dependency). See `SearchVectorStore` for what is translated, and how. */
export class OpenSearchVectorStore extends SearchVectorStore {
  constructor(opts: OpenSearchVectorStoreOptions) {
    refuseUnknownNames('OpenSearchVectorStore', opts, OPENSEARCH_VECTOR_STORE_NAMES);
    const a = opts.auth;
    super(OPENSEARCH, opts, a ? { authorization: `Basic ${Buffer.from(`${a.username}:${a.password}`).toString('base64')}` } : {});
  }
}
