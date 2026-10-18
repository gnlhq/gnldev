import { createHash } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import {
  vectorWriteBatch, assertSameVectorOwner, vectorDeletePlan, vectorDeleteMatcher, vectorQueryScope, vectorInOrganization,
  vectorItemCopy, rankVectorMatches, assertVectorDimension,
} from '@gnldev/durable';
import { refuseUnknownNames } from '@gnldev/options';
import type { VectorStore, VectorItem, VectorMatch, QueryOptions, DeleteWhere } from './vector-store.js';
import { keywordScore } from './vector-store.js';
import { QDRANT_VECTOR_STORE_NAMES, QUERY_NAMES } from './option-names.js';

export interface QdrantVectorStoreOptions {
  /** Qdrant's REST endpoint: `http://localhost:6333`, or `https://…` for a TLS endpoint (Qdrant Cloud). */
  url: string;
  /** Sent as the `api-key` header. Never written to an error message or a log. */
  apiKey?: string;
  /** Collection name (default `gnl_vectors`). Created on the first write, with the first vector's length. */
  collection?: string;
  /** Vector length the collection is created with; otherwise the first vector's. An existing collection's length wins. */
  dimension?: number;
}

/** A point as this store writes it: the document's id and labels are in the payload; the point id is derived (`pointId`). */
interface QdrantPoint { id: string; vector?: number[]; payload: QdrantPayload }
interface QdrantPayload {
  gnl_id: string;
  text: string;
  metadata?: Record<string, unknown>;
  /** Every metadata value as its JSON spelling, under an encoded key: the port's `===` on a scalar is equality of this string. */
  meq: Record<string, string>;
  namespace?: string;
  in_org: boolean;
  owner?: string;
  shared?: true;
}

/**
 * A Qdrant point id (a UUID) for a document under its labels: its namespace, owner, `shared` and id. A
 * write under other labels is another point, so it can never write over this one — Qdrant has no
 * conditional write, and with the document id alone two writers racing on one new id under two owners
 * both landed and the last one took the document (measured: 20 of 20 rounds).
 */
function pointId(it: { id: string; namespace?: string; owner?: string; shared?: boolean }): string {
  const h = createHash('sha256').update(JSON.stringify([it.namespace ?? null, it.owner ?? null, it.shared === true, it.id])).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
/** A metadata key as a payload path segment: letters, digits and `_` only, and injective. */
const metaKey = (k: string) => k.replace(/[^A-Za-z0-9]/g, (c) => `_${c.codePointAt(0)!.toString(16)}_`);
/** A page size for scrolls. */
const PAGE = 256;

/**
 * VectorStore on Qdrant, through its REST API with `node:http`/`node:https` and no dependency.
 *
 * The rules are the port's, imported from @gnldev/durable and not restated: the write rule
 * (`vectorWriteBatch`, `assertSameVectorOwner`), the length rule (`assertVectorDimension`), the filter
 * and partition rule (`vectorQueryScope`, `vectorDeletePlan`, `vectorDeleteMatcher`), the ranking rule
 * (`rankVectorMatches`: score, then id). The vector kit (`vectorStoreConformance`) holds it to them.
 *
 * What Qdrant needs translated, and how:
 * - Ids: Qdrant takes UUIDs; the document's id is in the payload (`gnl_id`), the point is `pointId`.
 * - The filter's `===`: Qdrant's `match` on an array field matches ANY element, which is not `===`, so every
 *   metadata value is also stored as its JSON spelling (`meq.<key>`) and a scalar filter matches that.
 *   A key whose filter value is `undefined` is "no such key": `is_empty` on the spelled field.
 * - The filter narrows BEFORE ranking: it is the search's filter, not a pass over the results.
 * - Ties: Qdrant cuts `limit` in its own order among equal scores; the port orders them by id. So when the
 *   last match ties others, every match at that score is read and the port's ranking cuts topK.
 * - A zero query vector has no direction for cosine: its matches score 0 and are read by scrolling.
 *
 * NOT `fetch`, and measured why: the global `fetch` (undici) on a kept-alive connection waited ~40 ms on
 * every response that carried a payload (43 ms against 1.1 ms through `node:http`, the same query, the
 * same server; `curl` 1.5 ms) — 100 queries took 4.4 s instead of 77 ms.
 */
export class QdrantVectorStore implements VectorStore {
  readonly rootOutsideOrganizations = true;
  private readonly collection: string;
  private dimension?: number;
  private ready?: Promise<void>;
  private readonly call: Call;

  constructor(opts: QdrantVectorStoreOptions) {
    refuseUnknownNames('QdrantVectorStore', opts, QDRANT_VECTOR_STORE_NAMES);
    if (typeof opts.url !== 'string' || !/^https?:\/\//.test(opts.url)) {
      throw new TypeError('@gnldev/rag: QdrantVectorStore needs `url`, an http:// or https:// address of Qdrant\'s REST API');
    }
    this.collection = opts.collection ?? 'gnl_vectors';
    if (!/^[A-Za-z0-9_-]+$/.test(this.collection)) {
      throw new TypeError('@gnldev/rag: a Qdrant collection name holds letters, digits, `_` and `-` only');
    }
    this.dimension = opts.dimension;
    this.call = httpCall(opts.url, opts.apiKey);
  }

  /**
   * The collection's vector length, or `undefined` when there is no collection yet. A collection another
   * process is creating answers 500 for a moment ("0 of 0 read operations failed", measured on 1.19 with
   * two stores making one collection at once): that one answer is asked again, a few times, briefly.
   */
  private async existing(): Promise<number | undefined> {
    for (let attempt = 0; ; attempt++) {
      try {
        const c = await this.call('GET', `/collections/${this.collection}`, undefined, true) as { config?: { params?: { vectors?: { size?: number } } } } | undefined;
        return c?.config?.params?.vectors?.size;
      } catch (e) {
        if ((e as { status?: number }).status !== 500 || attempt >= 5) throw e;
        await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
      }
    }
  }

  /** The collection, made with `dim` if there is none. Two processes making it at once: the loser reads the winner's. */
  private ensureReady(dim: number): Promise<void> {
    if (!this.ready) {
      const booting = (async () => {
        const size = await this.existing();
        if (size !== undefined) { this.dimension = size; return; }
        const want = this.dimension ?? dim;
        const made = await this.call('PUT', `/collections/${this.collection}`, { vectors: { size: want, distance: 'Cosine' } }, false, true);
        if (made === CONFLICT) { this.dimension = await this.existing(); return; }
        this.dimension = want;
        for (const [field, schema] of [['gnl_id', 'keyword'], ['namespace', 'keyword'], ['owner', 'keyword'], ['in_org', 'bool'], ['shared', 'bool']] as const) {
          await this.call('PUT', `/collections/${this.collection}/index?wait=true`, { field_name: field, field_schema: schema });
        }
      })();
      this.ready = booting;
      booting.catch(() => { if (this.ready === booting) this.ready = undefined; });
    }
    return this.ready;
  }

  async upsert(items: VectorItem[]): Promise<void> {
    if (items.length === 0) return;
    const batch = vectorWriteBatch(items).map(vectorItemCopy);
    // The length rule against what the collection holds, before anything is written.
    assertVectorDimension(this.ready ? this.dimension : (await this.existing()) ?? this.dimension, batch[0]!.embedding.length, 'write');
    await this.ensureReady(batch[0]!.embedding.length);
    assertVectorDimension(this.dimension, batch[0]!.embedding.length, 'write');
    const before = await this.byDocumentId(batch.map((it) => it.id));
    for (const it of batch) assertSameVectorOwner(before.find((p) => p.payload.gnl_id === it.id)?.payload, it);
    await this.call('PUT', `/collections/${this.collection}/points?wait=true`, {
      points: batch.map((it) => ({ id: pointId(it), vector: it.embedding, payload: toPayload(it) })),
    });
    // After the write: a racing writer that made the same id under other labels in the meantime. Both
    // sides see the other and withdraw their NEW points, so nobody gets the id — the rule one batch naming
    // one id under two owners follows. A point that was there before under the same labels is not new and stays.
    const after = await this.byDocumentId(batch.map((it) => it.id));
    const clash = batch.find((it) => after.some((p) => p.payload.gnl_id === it.id && p.id !== pointId(it)));
    if (clash) {
      const existed = new Set(before.map((p) => p.id));
      const fresh = batch.map(pointId).filter((id) => !existed.has(id));
      if (fresh.length) await this.call('POST', `/collections/${this.collection}/points/delete?wait=true`, { points: fresh });
      assertSameVectorOwner(after.find((p) => p.payload.gnl_id === clash.id && p.id !== pointId(clash))!.payload, clash);
    }
  }

  /** Every point carrying one of these document ids, under any labels. */
  private async byDocumentId(ids: string[]): Promise<QdrantPoint[]> {
    if (ids.length === 0) return [];
    return this.scrollAll({ must: [{ key: 'gnl_id', match: { any: [...new Set(ids)] } }] });
  }

  private async scrollAll(filter: unknown): Promise<QdrantPoint[]> {
    const out: QdrantPoint[] = [];
    let offset: unknown;
    do {
      const r = await this.call('POST', `/collections/${this.collection}/points/scroll`, { filter, limit: PAGE, with_payload: true, ...(offset !== undefined ? { offset } : {}) }) as { points?: QdrantPoint[]; next_page_offset?: unknown } | undefined;
      out.push(...(r?.points ?? []));
      offset = r?.next_page_offset ?? undefined;
    } while (offset !== undefined && offset !== null);
    return out;
  }

  async query(embedding: number[], topK: number, opts?: QueryOptions): Promise<VectorMatch[]> {
    refuseUnknownNames('query', opts, QUERY_NAMES);
    const scope = vectorQueryScope(opts);
    const stored = this.ready ? this.dimension : (await this.existing()) ?? this.dimension;
    assertVectorDimension(stored, embedding.length, 'query');
    if (scope.none || topK <= 0 || stored === undefined && !this.ready) return [];
    const must: unknown[] = [];
    const mustNot: unknown[] = [];
    if (scope.namespace !== undefined) must.push({ key: 'namespace', match: { value: scope.namespace } });
    if (scope.outsideOrganizations) mustNot.push({ key: 'in_org', match: { value: true } });
    if (scope.visibleTo !== undefined) must.push({ should: [{ key: 'shared', match: { value: true } }, { key: 'owner', match: { value: scope.visibleTo } }] });
    for (const [k, v] of Object.entries(opts?.filter ?? {})) {
      if (v === undefined) must.push({ is_empty: { key: `meq.${metaKey(k)}` } });
      else must.push({ key: `meq.${metaKey(k)}`, match: { value: JSON.stringify(v) } });
    }
    const filter = { must, must_not: mustNot };
    const w = opts?.keywordWeight ?? 0;
    const hybrid = w > 0 && !!opts?.text;
    let hits: Array<{ payload: QdrantPayload; score: number }>;
    if (embedding.every((x) => x === 0)) {
      hits = (await this.scrollAll(filter)).map((p) => ({ payload: p.payload, score: 0 }));
    } else {
      const limit = hybrid ? Math.max(topK * 4, 50) : topK;
      // One more than asked: when the one past the cut scores what the last one does, the cut falls inside
      // a tie Qdrant ordered its own way, so every match at that score is read and the port's ranking
      // (equal scores by id) cuts topK. Otherwise one call answers (measured: a second call on every query
      // made 100 queries 250 ms instead of half that).
      hits = await this.search(embedding, filter, limit + 1);
      const last = hits[limit - 1];
      const next = hits[limit];
      if (!hybrid && last && next && next.score >= last.score - 1e-6) {
        const ties = await this.atLeast(embedding, filter, last.score, limit);
        if (ties.length > hits.length) hits = ties;
      }
    }
    let out = hits.map((h) => toMatch(h.payload, hybrid ? (1 - w) * h.score + w * keywordScore(opts!.text!, h.payload.text) : h.score));
    if (opts?.minScore !== undefined) out = out.filter((m) => m.score >= opts.minScore!);
    return rankVectorMatches(out, topK);
  }

  private async search(vector: number[], filter: unknown, limit: number, extra: Record<string, unknown> = {}): Promise<Array<{ payload: QdrantPayload; score: number }>> {
    const r = await this.call('POST', `/collections/${this.collection}/points/query`, { query: vector, filter, limit, with_payload: true, ...extra }) as { points?: Array<{ payload: QdrantPayload; score: number }> } | undefined;
    return r?.points ?? [];
  }

  /**
   * Every match scoring at least `score`, paged until a page comes back short. Qdrant's `score_threshold`
   * leaves out a score EQUAL to it (measured on 1.19: four identical points at 0.99999994, threshold
   * 0.99999994, none returned), so the threshold is set a hair below; a match a hair lower that comes with
   * it ranks after the ties and is cut by `rankVectorMatches`.
   */
  private async atLeast(vector: number[], filter: unknown, score: number, from: number): Promise<Array<{ payload: QdrantPayload; score: number }>> {
    const out: Array<{ payload: QdrantPayload; score: number }> = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = await this.search(vector, filter, PAGE, { score_threshold: score - 1e-6, offset });
      out.push(...page);
      if (page.length < PAGE) return out.length >= from ? out : [];
    }
  }

  async delete(where: DeleteWhere): Promise<number> {
    const w = vectorDeletePlan(where);
    if (!w) return 0;
    if (!this.ready && (await this.existing()) === undefined) return 0;
    // Narrowed in Qdrant by what it can answer exactly, then held to the port's matcher in code: the
    // matcher decides, the narrowing only saves reading points the matcher would not take.
    const must: unknown[] = [];
    const mustNot: unknown[] = [];
    if (w.ids) must.push({ key: 'gnl_id', match: { any: [...new Set(w.ids)] } });
    if (w.namespace !== undefined) must.push({ key: 'namespace', match: { value: w.namespace } });
    if (w.owner !== undefined) must.push({ key: 'owner', match: { value: w.owner } });
    if (w.outsideOrganizations) mustNot.push({ key: 'in_org', match: { value: true } });
    for (const [k, v] of Object.entries(w.filter ?? {})) {
      if (v === undefined) must.push({ is_empty: { key: `meq.${metaKey(k)}` } });
      else must.push({ key: `meq.${metaKey(k)}`, match: { value: JSON.stringify(v) } });
    }
    const gone = vectorDeleteMatcher(w);
    const doomed = (await this.scrollAll({ must, must_not: mustNot }))
      .filter(({ payload: p }) => gone({ id: p.gnl_id, namespace: p.namespace, owner: p.owner, metadata: p.metadata }));
    if (doomed.length) await this.call('POST', `/collections/${this.collection}/points/delete?wait=true`, { points: doomed.map((p) => p.id) });
    return doomed.length;
  }
}

function toPayload(it: VectorItem): QdrantPayload {
  const meq: Record<string, string> = {};
  for (const [k, v] of Object.entries(it.metadata ?? {})) if (v !== undefined) meq[metaKey(k)] = JSON.stringify(v);
  return {
    gnl_id: it.id, text: it.text, meq, in_org: vectorInOrganization(it.namespace),
    ...(it.metadata ? { metadata: it.metadata } : {}),
    ...(it.namespace !== undefined ? { namespace: it.namespace } : {}),
    ...(it.owner !== undefined ? { owner: it.owner } : {}),
    ...(it.shared ? { shared: true as const } : {}),
  };
}

function toMatch(p: QdrantPayload, score: number): VectorMatch {
  return {
    id: p.gnl_id, text: p.text, metadata: p.metadata, namespace: p.namespace,
    ...(p.owner !== undefined ? { owner: p.owner } : {}), ...(p.shared ? { shared: true } : {}), score,
  };
}

const CONFLICT = Symbol('conflict');
type Call = (method: string, path: string, body?: unknown, missingIsUndefined?: boolean, conflictIsSymbol?: boolean) => Promise<unknown>;

/** One REST call; the result is Qdrant's `result`. The API key goes in a header and never into a message. */
function httpCall(url: string, apiKey?: string): Call {
  const base = new URL(url);
  const lib = base.protocol === 'https:' ? https : http;
  const agent = new lib.Agent({ keepAlive: true });
  const prefix = base.pathname.replace(/\/+$/, '');
  return (method, path, body, missingIsUndefined = false, conflictIsSymbol = false) => new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = lib.request({
      protocol: base.protocol, hostname: base.hostname, port: base.port, path: `${prefix}${path}`, method, agent,
      headers: { 'content-type': 'application/json', ...(data ? { 'content-length': Buffer.byteLength(data) } : {}), ...(apiKey ? { 'api-key': apiKey } : {}) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        if (missingIsUndefined && status === 404) return resolve(undefined);
        if (conflictIsSymbol && status === 409) return resolve(CONFLICT);
        let j: { result?: unknown; status?: unknown } = {};
        try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not JSON: reported below by status */ }
        if (status < 200 || status >= 300) {
          return reject(Object.assign(new Error(`@gnldev/rag: Qdrant ${method} ${path.split('?')[0]} answered ${status} ${JSON.stringify(j?.status ?? '').slice(0, 200)}`), { status }));
        }
        resolve(j.result);
      });
    });
    req.on('error', (e) => reject(new Error(`@gnldev/rag: Qdrant ${method} ${path.split('?')[0]} failed: ${e.message}`)));
    req.end(data);
  });
}
