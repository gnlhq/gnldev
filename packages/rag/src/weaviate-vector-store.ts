import { createHash } from 'node:crypto';
import { cosineSimilarity } from 'ai';
import {
  vectorWriteBatch, assertSameVectorOwner, vectorDeletePlan, vectorDeleteMatcher, vectorQueryScope, vectorInOrganization,
  vectorItemCopy, rankVectorMatches, assertVectorDimension,
} from '@gnldev/durable';
import { refuseUnknownNames } from '@gnldev/options';
import type { VectorStore, VectorItem, VectorMatch, QueryOptions, DeleteWhere } from './vector-store.js';
import { keywordScore } from './vector-store.js';
import { WEAVIATE_VECTOR_STORE_NAMES, QUERY_NAMES } from './option-names.js';
import { restCall, type RestCall } from './rest-call.js';
import { tieWhole, vectorDigest, TIE_EPSILON } from './tie-whole.js';

export interface WeaviateVectorStoreOptions {
  /** Weaviate's REST address: `http://localhost:8080`, or `https://…` for a TLS endpoint (Weaviate Cloud). */
  url: string;
  /** Sent as `Authorization: Bearer …`. Never written to an error message or a log. */
  apiKey?: string;
  /** Collection (class) name (default `GnlVectors`): a capital letter, then letters, digits and `_`. Created on the first write. */
  collection?: string;
  /** Vector length the collection is created with; otherwise the first vector's. An existing collection's length wins. */
  dimension?: number;
}

/**
 * An object's properties as this store writes them. Weaviate's exact-match tokenization (`field`) trims
 * whitespace, so `"a"`, `" a"` and `"a "` would be one value: every label a filter compares — the
 * document id, namespace, owner, each metadata value — is stored as its JSON spelling, which a trim
 * cannot reach (a string's spelling starts and ends with `"`).
 */
interface WeaviateProps {
  /** The document's id, as JSON. */
  gnl_id: string;
  text: string;
  /** The document's metadata as JSON: the stored form of any value, the scalar fields below are what filters read. */
  gnl_meta?: string;
  /** `<key>=<value as JSON>` for each defined metadata value: the port's `===` on a scalar is membership of this string. */
  gnl_kv: string[];
  /** The encoded keys of the metadata's defined values: a filter on `undefined` ("no such key") is `ContainsNone`. */
  gnl_keys: string[];
  /** The vector's digest (`vectorDigest`): a tie between copies of one vector is read by it, not by a search. */
  gnl_vh: string;
  /** Namespace and owner as JSON, absent when the document has none. */
  gnl_ns?: string;
  gnl_owner?: string;
  in_org: boolean;
  shared: boolean;
}
interface Hit { id: string; props: WeaviateProps; score: number; vector?: number[] }
/** A Weaviate filter (its `where` input), written as GraphQL by `gql`. */
type Where = Record<string, unknown>;

/**
 * A Weaviate object id (a UUID) for a document under its labels: its namespace, owner, `shared` and id.
 * A write under other labels is another object, so it can never write over this one — Weaviate has no
 * conditional write (the same rule, and the same reason, as the Qdrant store's point id).
 */
function objectId(it: { id: string; namespace?: string; owner?: string; shared?: boolean }): string {
  const h = createHash('sha256').update(JSON.stringify([it.namespace ?? null, it.owner ?? null, it.shared === true, it.id])).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
/** A metadata key as a field name: letters, digits and `_` only, and injective (so never `=`). */
const metaKey = (k: string) => k.replace(/[^A-Za-z0-9]/g, (c) => `_${c.codePointAt(0)!.toString(16)}_`);
/** A page size for reads and deletes. */
const PAGE = 256;
const PROPS = 'gnl_id text gnl_meta gnl_vh gnl_ns gnl_owner shared';

const eq = (path: string, valueText: string): Where => ({ path: [path], operator: 'Equal', valueText });
const isTrue = (path: string, valueBoolean: boolean): Where => ({ path: [path], operator: 'Equal', valueBoolean });
const anyOf = (path: string, valueText: string[]): Where => ({ path: [path], operator: 'ContainsAny', valueText });
const noneOf = (path: string, valueText: string[]): Where => ({ path: [path], operator: 'ContainsNone', valueText });
/** No clause is no filter; one is itself; more are an `And`. */
const allOf = (clauses: Where[]): Where | undefined => (clauses.length === 0 ? undefined : clauses.length === 1 ? clauses[0] : { operator: 'And', operands: clauses });

/** A value as a GraphQL input literal: `operator` and `order` are enums, strings are JSON strings (GraphQL's escapes are JSON's). */
function gql(v: unknown, key?: string): string {
  if (Array.isArray(v)) return `[${v.map((x) => gql(x)).join(',')}]`;
  if (v !== null && typeof v === 'object') return `{${Object.entries(v).map(([k, x]) => `${k}:${gql(x, k)}`).join(',')}}`;
  if (key === 'operator' || key === 'order') return String(v);
  return JSON.stringify(v);
}

/**
 * VectorStore on Weaviate (1.x), through its REST and GraphQL API, with no dependency.
 *
 * The rules are the port's, imported from @gnldev/durable and not restated: the write rule
 * (`vectorWriteBatch`, `assertSameVectorOwner`), the length rule (`assertVectorDimension`), the filter
 * and partition rule (`vectorQueryScope`, `vectorDeletePlan`, `vectorDeleteMatcher`), the ranking rule
 * (`rankVectorMatches`: score, then id). The vector kit (`vectorStoreConformance`) holds it to them.
 *
 * What Weaviate needs translated, and how (measured on 1.40, raporlar/2026-10-20-weaviate):
 * - Ids: Weaviate takes UUIDs; the document's id is a property (`gnl_id`), the object is `objectId`.
 * - Exact match: the collection's properties are declared (no auto-schema) with `field` tokenization,
 *   which keeps case but trims whitespace — so labels are stored as their JSON spelling (`WeaviateProps`).
 * - The filter's `===`: each metadata value as `<key>=<JSON>` in one list (`gnl_kv`), a scalar filter is
 *   `ContainsAny` of that one string: 1 and "1" differ, null is a value, a scalar never matches inside an
 *   array. "No such key" is `ContainsNone` on `gnl_keys`. One list instead of a property per key, so a
 *   filter on a key no document has is a filter, not an unknown property.
 * - The filter narrows BEFORE ranking: it is the search's `where`, not a pass over the results.
 * - Scores: the collection is cosine; Weaviate answers a distance, the score is 1 − distance. A zero vector
 *   on either side answers distance 1, so it scores 0.
 * - Ties: the search is approximate (HNSW) and does not reach every copy of one vector (3,000 copies, a
 *   limit of 4,000: 2,974–2,989 came back over two collections), nor order equal scores by id — so a cut
 *   inside a tie is decided on exact scores (`tieWhole`, shared with the Chroma store), read by the
 *   vectors' digests (`gnl_vh`).
 * - A batch write answers 200 with an error per object: any error fails the call.
 * - Reads page by object id (`id` greater than the last, in id order): Weaviate refuses an offset past
 *   10,000 and its cursor takes no filter.
 */
export class WeaviateVectorStore implements VectorStore {
  readonly rootOutsideOrganizations = true;
  private readonly name: string;
  private dimension?: number;
  private ready?: Promise<void>;
  private readonly call: RestCall;

  constructor(opts: WeaviateVectorStoreOptions) {
    refuseUnknownNames('WeaviateVectorStore', opts, WEAVIATE_VECTOR_STORE_NAMES);
    if (typeof opts.url !== 'string' || !/^https?:\/\//.test(opts.url)) {
      throw new TypeError('@gnldev/rag: WeaviateVectorStore needs `url`, an http:// or https:// address of Weaviate\'s REST API');
    }
    this.name = opts.collection ?? 'GnlVectors';
    if (!/^[A-Z][A-Za-z0-9_]*$/.test(this.name)) {
      throw new TypeError('@gnldev/rag: a Weaviate collection name starts with a capital letter, then letters, digits and `_` only');
    }
    this.dimension = opts.dimension;
    this.call = restCall(opts.url, {
      name: 'Weaviate', headers: opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}, result: (j) => j,
      detail: (j) => j?.error?.[0]?.message ?? j?.message,
    });
  }

  /** The collection's vector length (kept in its description), `null` when it has none, `undefined` when there is no collection. */
  private async existing(): Promise<number | null | undefined> {
    const c = await this.call('GET', `/v1/schema/${this.name}`, undefined, true) as { description?: string } | undefined;
    if (!c) return undefined;
    const m = /gnl_dim=(\d+)/.exec(c.description ?? '');
    return m ? Number(m[1]) : null;
  }

  /** The collection, made with `dim` if there is none. Two processes making it at once: the loser reads the winner's. */
  private ensureReady(dim: number): Promise<void> {
    if (!this.ready) {
      const booting = (async () => {
        const size = await this.existing();
        if (size !== undefined) { this.dimension = size ?? this.dimension ?? dim; return; }
        const want = this.dimension ?? dim;
        const text = (name: string, dataType = 'text') => ({ name, dataType: [dataType], tokenization: 'field', indexFilterable: true, indexSearchable: false });
        const stored = (name: string) => ({ name, dataType: ['text'], indexFilterable: false, indexSearchable: false });
        try {
          await this.call('POST', '/v1/schema', {
            class: this.name, description: `@gnldev/rag vectors, gnl_dim=${want}`, vectorizer: 'none', vectorIndexConfig: { distance: 'cosine' },
            properties: [
              text('gnl_id'), stored('text'), stored('gnl_meta'), text('gnl_kv', 'text[]'), text('gnl_keys', 'text[]'), text('gnl_vh'),
              text('gnl_ns'), text('gnl_owner'), { name: 'in_org', dataType: ['boolean'] }, { name: 'shared', dataType: ['boolean'] },
            ],
          });
          this.dimension = want;
        } catch (e) {
          // 422 "already exists": another process made it first, and its length wins.
          const theirs = (e as { status?: number }).status === 422 ? await this.existing() : undefined;
          if (theirs === undefined) throw e;
          this.dimension = theirs ?? want;
        }
      })();
      this.ready = booting;
      booting.catch(() => { if (this.ready === booting) this.ready = undefined; });
    }
    return this.ready;
  }

  /** Whether the collection exists, and its length, without making it. */
  private async current(): Promise<{ dimension?: number } | undefined> {
    if (this.ready) { await this.ready; return { dimension: this.dimension }; }
    const size = await this.existing();
    return size === undefined ? undefined : { dimension: size ?? undefined };
  }

  async upsert(items: VectorItem[]): Promise<void> {
    if (items.length === 0) return;
    const batch = vectorWriteBatch(items).map(vectorItemCopy);
    // The length rule against what the collection holds, before anything is written.
    assertVectorDimension((await this.current())?.dimension ?? this.dimension, batch[0]!.embedding.length, 'write');
    await this.ensureReady(batch[0]!.embedding.length);
    assertVectorDimension(this.dimension, batch[0]!.embedding.length, 'write');
    const before = await this.byDocumentId(batch.map((it) => it.id));
    for (const it of batch) {
      const had = before.find((r) => idOf(r) === it.id);
      assertSameVectorOwner(had && labelsOf(had), it);
    }
    for (let i = 0; i < batch.length; i += PAGE) {
      const part = batch.slice(i, i + PAGE);
      const r = await this.call('POST', '/v1/batch/objects', {
        objects: part.map((it) => ({ class: this.name, id: objectId(it), vector: it.embedding, properties: toProps(it) })),
      }) as Array<{ result?: { errors?: { error?: Array<{ message?: string }> } } }>;
      const failed = r.find((o) => o.result?.errors);
      if (failed) throw new Error(`@gnldev/rag: Weaviate batch write refused an object: ${String(failed.result!.errors!.error?.[0]?.message ?? '').slice(0, 200)}`);
    }
    // After the write: a racing writer that made the same id under other labels in the meantime. Both
    // sides see the other and withdraw their NEW objects, so nobody gets the id — the rule one batch naming
    // one id under two owners follows. An object that was there before under the same labels is not new and stays.
    const after = await this.byDocumentId(batch.map((it) => it.id));
    const clash = batch.find((it) => after.some((r) => idOf(r) === it.id && r.id !== objectId(it)));
    if (clash) {
      const existed = new Set(before.map((r) => r.id));
      await this.deleteObjects(batch.map(objectId).filter((id) => !existed.has(id)));
      assertSameVectorOwner(labelsOf(after.find((r) => idOf(r) === clash.id && r.id !== objectId(clash))!), clash);
    }
  }

  /** Every object carrying one of these document ids, under any labels. */
  private byDocumentId(ids: string[]): Promise<Hit[]> {
    return this.readAll(anyOf('gnl_id', [...new Set(ids)].map((id) => JSON.stringify(id))));
  }

  /** One GraphQL `Get` on the collection: its hits, or the error Weaviate answered. */
  private async get(args: string, vector = false): Promise<Hit[]> {
    const r = await this.call('POST', '/v1/graphql', {
      query: `{Get{${this.name}(${args}){${PROPS} _additional{id distance${vector ? ' vector' : ''}}}}}`,
    }) as { data?: { Get?: Record<string, Array<WeaviateProps & { _additional: { id: string; distance?: number | null; vector?: number[] } }> | null> }; errors?: Array<{ message?: string }> };
    if (r.errors?.length) throw new Error(`@gnldev/rag: Weaviate POST /v1/graphql answered ${JSON.stringify(r.errors[0]!.message ?? '').slice(0, 200)}`);
    return (r.data?.Get?.[this.name] ?? []).map(({ _additional: a, ...props }) => ({
      id: a.id, props: props as WeaviateProps, score: a.distance == null ? 0 : 1 - a.distance, ...(vector ? { vector: a.vector } : {}),
    }));
  }

  /** Every object `where` selects, a page at a time in id order. */
  private async readAll(where: Where | undefined, vector = false): Promise<Hit[]> {
    const out: Hit[] = [];
    for (let last: string | undefined; ;) {
      const w = allOf([...(where ? [where] : []), ...(last ? [{ path: ['id'], operator: 'GreaterThan', valueText: last }] : [])]);
      const page = await this.get(`${w ? `where:${gql(w)} ` : ''}sort:${gql([{ path: ['_id'], order: 'asc' }])} limit:${PAGE}`, vector);
      out.push(...page);
      if (page.length < PAGE) return out;
      last = page[page.length - 1]!.id;
    }
  }

  private search(vector: number[], where: Where | undefined, n: number): Promise<Hit[]> {
    return this.get(`nearVector:{vector:${JSON.stringify(vector)}} ${where ? `where:${gql(where)} ` : ''}limit:${n}`);
  }

  async query(embedding: number[], topK: number, opts?: QueryOptions): Promise<VectorMatch[]> {
    refuseUnknownNames('query', opts, QUERY_NAMES);
    const scope = vectorQueryScope(opts);
    const c = await this.current();
    assertVectorDimension(c?.dimension ?? this.dimension, embedding.length, 'query');
    if (scope.none || topK <= 0 || !c) return [];
    const where: Where[] = [];
    if (scope.namespace !== undefined) where.push(eq('gnl_ns', JSON.stringify(scope.namespace)));
    if (scope.outsideOrganizations) where.push(isTrue('in_org', false));
    if (scope.visibleTo !== undefined) where.push({ operator: 'Or', operands: [isTrue('shared', true), eq('gnl_owner', JSON.stringify(scope.visibleTo))] });
    where.push(...filterClauses(opts?.filter));
    const w = opts?.keywordWeight ?? 0;
    const hybrid = w > 0 && !!opts?.text;
    const limit = hybrid ? Math.max(topK * 4, 50) : topK;
    // One more than asked: when the one past the cut scores what the last one does, the cut falls inside
    // a tie, which Weaviate neither orders by id nor answers whole — so it is decided on the exact scores.
    let hits = await this.search(embedding, allOf(where), limit + 1);
    const last = hits[limit - 1];
    const next = hits[limit];
    if (!hybrid && last && next && next.score >= last.score - TIE_EPSILON) {
      hits = await tieWhole(hits, last.score, {
        score: (h) => h.score,
        digest: (h) => h.props.gnl_vh,
        bestOutside: async (digests) => (await this.search(embedding, allOf([...where, noneOf('gnl_vh', digests)]), 1))[0],
        scored: async (digests) => (await this.readAll(allOf(digests ? [...where, anyOf('gnl_vh', digests)] : where), true))
          .map((h) => ({ ...h, score: cosineSimilarity(embedding, h.vector!) })),
      });
    }
    let out = hits.map((h) => toMatch(h, hybrid ? (1 - w) * h.score + w * keywordScore(opts!.text!, h.props.text) : h.score));
    if (opts?.minScore !== undefined) out = out.filter((m) => m.score >= opts.minScore!);
    return rankVectorMatches(out, topK);
  }

  async delete(where: DeleteWhere): Promise<number> {
    const w = vectorDeletePlan(where);
    if (!w) return 0;
    if (!await this.current()) return 0;
    // Narrowed in Weaviate by what it can answer exactly, then held to the port's matcher in code: the
    // matcher decides, the narrowing only saves reading objects the matcher would not take.
    const clauses: Where[] = [];
    if (w.ids) clauses.push(anyOf('gnl_id', [...new Set(w.ids)].map((id) => JSON.stringify(id))));
    if (w.namespace !== undefined) clauses.push(eq('gnl_ns', JSON.stringify(w.namespace)));
    if (w.owner !== undefined) clauses.push(eq('gnl_owner', JSON.stringify(w.owner)));
    if (w.outsideOrganizations) clauses.push(isTrue('in_org', false));
    clauses.push(...filterClauses(w.filter));
    const gone = vectorDeleteMatcher(w);
    const doomed = (await this.readAll(allOf(clauses)))
      .filter((h) => gone({ id: idOf(h), ...labelsOf(h), metadata: metadataOf(h.props) }));
    await this.deleteObjects(doomed.map((h) => h.id));
    return doomed.length;
  }

  private async deleteObjects(ids: string[]): Promise<void> {
    for (let i = 0; i < ids.length; i += PAGE) {
      await this.call('DELETE', '/v1/batch/objects', {
        match: { class: this.name, where: { path: ['id'], operator: 'ContainsAny', valueTextArray: ids.slice(i, i + PAGE) } }, output: 'minimal',
      });
    }
  }
}

function filterClauses(filter: Record<string, unknown> | undefined): Where[] {
  return Object.entries(filter ?? {}).map(([k, v]) => (v === undefined
    ? noneOf('gnl_keys', [metaKey(k)])
    : anyOf('gnl_kv', [`${metaKey(k)}=${JSON.stringify(v)}`])));
}

function toProps(it: VectorItem): WeaviateProps {
  const props: WeaviateProps = {
    gnl_id: JSON.stringify(it.id), text: it.text, gnl_kv: [], gnl_keys: [], gnl_vh: vectorDigest(it.embedding),
    in_org: vectorInOrganization(it.namespace), shared: it.shared === true,
  };
  for (const [k, v] of Object.entries(it.metadata ?? {})) {
    if (v === undefined) continue;
    props.gnl_kv.push(`${metaKey(k)}=${JSON.stringify(v)}`);
    props.gnl_keys.push(metaKey(k));
  }
  if (it.metadata) props.gnl_meta = JSON.stringify(it.metadata);
  if (it.namespace !== undefined) props.gnl_ns = JSON.stringify(it.namespace);
  if (it.owner !== undefined) props.gnl_owner = JSON.stringify(it.owner);
  return props;
}

const idOf = (h: Hit): string => JSON.parse(h.props.gnl_id);
const labelsOf = (h: Hit) => ({
  namespace: h.props.gnl_ns == null ? undefined : JSON.parse(h.props.gnl_ns) as string,
  owner: h.props.gnl_owner == null ? undefined : JSON.parse(h.props.gnl_owner) as string,
  shared: h.props.shared === true,
});
const metadataOf = (p: WeaviateProps): Record<string, unknown> | undefined => (p.gnl_meta == null ? undefined : JSON.parse(p.gnl_meta));

function toMatch(h: Hit, score: number): VectorMatch {
  const { namespace, owner, shared } = labelsOf(h);
  return {
    id: idOf(h), text: h.props.text ?? '', metadata: metadataOf(h.props), namespace,
    ...(owner !== undefined ? { owner } : {}), ...(shared ? { shared: true } : {}), score,
  };
}
