// Multi-organization support: partition the journal by organization. All keys are written/read with the
// `org:<orgId>:` prefix → runs, memory, queue, cache — EVERYTHING is isolated per organization. ALL of
// the journal's optional capabilities (putIfAbsent/listKeys/deletePrefix/putIfMatch/now/incrBy/
// getCounters/listStaleRuns) and JournalReader's (readRun/listRuns/readRunStats) — if the underlying
// journal supports them — are bridged → exactly-once/atomic-CAS/atomic-counter guarantees are also
// PRESERVED in the organization view (the same Journal interface). A highly requested feature that has no
// counterpart in most agent frameworks.
import { listRunsArray } from './journal.js';
import { decodeRunCursor, encodeRunCursor } from './run-cursor.js';
import type { Journal, JournalBatch, JournalReader, JournalEntry, RunSummary } from './journal.js';

/** An organization-prefixed key. orgId must not contain ':' (it would break the key schema). */
/**
 * Meta keys the ENGINE writes about the deployment, which `adoptIntoOrg` must never move.
 *
 * `MetaStore` is a port an organization can write through, so most of `gnl_meta` is ordinary data and
 * belongs to whoever is adopting it. `schema_version` is not: every adapter writes it at init to record
 * which schema the file is on. Prefixing it to `org:acme:schema_version` leaves the deployment looking
 * unversioned on the next boot, so the migration would corrupt the thing it is migrating. Caught in a
 * dry run against a real free-tier database, where it was the ONLY meta row present.
 *
 * Shared rather than repeated per adapter: three copies of this list is three chances to add the next
 * engine-level key to two of them.
 */
export const ENGINE_META_KEYS: readonly string[] = ['schema_version'];

/**
 * Reserved `__…__` keys that ARE an organization's data and so may be adopted — measured, not assumed.
 *
 * On a live multi-organization deployment these are the only reserved keys ever seen written under an
 * `org:<id>:` prefix. Everything else in the reserved space is platform-level and must stay at the
 * root: `__org__` (registration records), `__agent_registry__` (is this code-agent allowed to serve at
 * all), `__eeuser__`/`__eetoken__`/`__eeaudit__` (the paid user store), `__budget__` (set BY the
 * operator, keyed by organization id already), `__policy__` and `__pricing__` (platform-admin
 * endpoints).
 *
 * Moving any of those would not be a cosmetic mistake: `__org__:acme` becoming
 * `org:acme:__org__:acme` makes `requireRegistration` reject every organization, and the token rows
 * becoming org-scoped means nobody can authenticate at all.
 *
 * An ALLOW list rather than a deny list, deliberately. A reserved key added later and forgotten here
 * stays where it is — the operator still sees it and nothing breaks — where a forgotten DENY entry
 * would move platform state into one organization. `adoptIntoOrg` reports what it skipped by name so the
 * decision is visible rather than silent.
 */
export const ADOPTABLE_RESERVED_PREFIXES: readonly string[] = [
  '__usage__', '__metrics__',
  // Managed workflow definitions and managed agent versions. Studio writes both through its
  // ALS-SCOPED reader (`rw.put(WF_STORE_PRE + …)`, the agent store's prefixer), so on a deployment
  // with organizations they are per-organization by construction and read back through the same
  // scope. Left at the root by an upgrade they are not deleted — they are UNREACHABLE, and the
  // operator sees an empty list and concludes the migration dropped them.
  //
  // Both were missing from this list when it was first written, which is the failure mode an allow
  // list has: it leaves data behind. That is the trade it is chosen for — a missing DENY entry moves
  // platform state into one organization and breaks authentication.
  '__studio_wf__', '__studio_agent__',
];

/**
 * Organization registration record prefix. `@gnldev/studio`'s `POST /organizations` writes
 * `__org__:<id>`; a `null` value is a deletion tombstone.
 *
 * Declared here because `adoptIntoOrg` reads it and both server and studio already had their own copy
 * of the literal.
 */
export const ORG_RECORD_PRE = '__org__:';

/**
 * Refuses to adopt into an organization that was never registered.
 *
 * `orgPrefix` checks the SHAPE of an id and nothing else, which leaves a one-keystroke, irreversible
 * mistake: an operator typing `acmee` for `acme` moves every row under `org:acmee:`, the real
 * organization sees nothing, and running it again with the right name FIXES NOTHING — those rows now
 * carry a prefix, so they count as `alreadyScoped` and are skipped. Measured end to end. The dry run
 * does not help either: it prints `acmee` and reads as an ordinary success.
 *
 * So the check happens where the name is still correctable. On a free-to-paid upgrade the natural
 * order is: install the paid tier, create the organization, then adopt — and this makes that order
 * required rather than assumed.
 *
 * `allowUnregistered` exists for the deployment that has no registration path at all (no studio, no
 * `__org__` writer). It is a deliberate opt-out, not a default.
 */
export async function assertOrgRegistered(
  read: { get<T = unknown>(key: string): Promise<T | undefined> },
  orgId: string,
  allowUnregistered?: boolean,
): Promise<void> {
  if (allowUnregistered) return;
  const rec = await read.get(ORG_RECORD_PRE + orgId);
  if (rec != null) return;
  throw new Error(
    `@gnldev/durable: organization '${orgId}' is not registered, so adopting into it would move every row `
    + `under 'org:${orgId}:' where nothing reads them — and a second run with the right name would not `
    + `undo it, because the rows would already carry a prefix. Create the organization first `
    + `(studio: POST /organizations), or pass { allowUnregistered: true } if this deployment has no `
    + 'registration path at all.',
  );
}

/**
 * Refuses to adopt while a run is still executing.
 *
 * Measured, on SQLite with a real model call in flight: the migration moved three of the run's keys
 * into the organization, the run then wrote its next key at the ROOT, and the store ended with the
 * SAME logical key in both places —
 *
 *   canli-kosu:proc:__gnl_model_claim:0            (root, written after the migration)
 *   org:acme:canli-kosu:proc:__gnl_model_claim:0   (moved)
 *
 * — which is the exactly-once claim marker, duplicated. That is the worst of the three outcomes: no
 * error, and no whole record either. The transaction does not help, because the run is not inside it;
 * it protects the migration from failing halfway, not the store from being written to meanwhile.
 *
 * So this is a refusal, not a warning. "Stop writes before upgrading" is advice a deployment can
 * follow accidentally; the store is the only place that knows whether it actually did.
 *
 * Detected from the outcome records rather than `listRuns`, because the summary shape differs between
 * adapters while `{status:'running'}` is written by the engine itself and is identical everywhere.
 */
export async function assertNoRunsInFlight(
  read: {
    listKeys?(prefix: string): Promise<string[]>;
    get<T = unknown>(key: string): Promise<T | undefined>;
  },
  allowInFlight?: boolean,
): Promise<void> {
  if (allowInFlight || typeof read.listKeys !== 'function') return;
  const keys = await read.listKeys('');
  const inFlight: string[] = [];
  for (const k of keys) {
    if (!k.endsWith(':outcome')) continue;
    const rec = await read.get<{ status?: string }>(k);
    if (rec && typeof rec === 'object' && (rec as { status?: string }).status === 'running') {
      inFlight.push(k.slice(0, -':outcome'.length));
    }
  }
  if (inFlight.length === 0) return;
  throw new Error(
    `@gnldev/durable: ${inFlight.length} run(s) are still executing (${inFlight.slice(0, 3).join(', ')}` +
    `${inFlight.length > 3 ? ', …' : ''}), and adopting now would SPLIT them: the migration moves the keys `
    + 'they have already written while they go on writing unprefixed ones, leaving the same exactly-once '
    + 'claim marker in two places. Measured. Stop accepting work, let the runs finish, then adopt — or '
    + 'pass { allowInFlight: true } if you know these runs are abandoned.',
  );
}

/** True when a root-level key belongs to the platform and `adoptIntoOrg` must leave it alone. */
export function isPlatformKey(key: string): boolean {
  if (!key.startsWith('__')) return false;                       // ordinary data — adoptable
  return !ADOPTABLE_RESERVED_PREFIXES.some((p) => key.startsWith(p));
}

/**
 * Where every organization's rows live in the root store: `org:<id>:…`. The ONE spelling of the
 * reserved space — `orgPrefix` builds an organization's key under it, `isOrganizationKey` and
 * `orgSpaceSql` ask whether a key is in it. Read through those, never restated: eight restatements
 * (`startsWith('org:')`, `LIKE 'org:%'`, two local constants) had drifted by the time they were
 * counted — SQLite's `LIKE` ignores case, so its adopt treated a root key `ORG:x` as already scoped and
 * never moved it.
 */
export const ORG_KEY_PREFIX = 'org:';

/**
 * Whether `id` — a journal key, a run id, a thread id, a work namespace — is in the organizations'
 * reserved space. Case-sensitive, and the same answer `orgSpaceSql` gives in SQL.
 */
export function isOrganizationKey(id: string): boolean {
  return id.startsWith(ORG_KEY_PREFIX);
}

/**
 * The ONE reading of an id in the reserved space: `org:<orgId>:<rest>` → `{ orgId, rest }`, the id an
 * organization's view writes for its own `rest` (a thread, a run, a key). `undefined` for an id no
 * organization's view can produce: outside the space, or `org:123` (no second separator), or `org::x`
 * (an empty organization id, which `orgPrefix` refuses). `rest` may be empty (`org:acme:`, a prefix).
 * Each regex that parsed this shape by hand answered a slightly different question.
 */
export function parseOrganizationKey(id: string): { orgId: string; rest: string } | undefined {
  if (!isOrganizationKey(id)) return undefined;
  const end = id.indexOf(':', ORG_KEY_PREFIX.length);
  if (end <= ORG_KEY_PREFIX.length) return undefined;
  return { orgId: id.slice(ORG_KEY_PREFIX.length, end), rest: id.slice(end + 1) };
}

/**
 * The SQL twin of `isOrganizationKey` (and of `id.startsWith(orgPrefix(orgId))` with `orgId`): a
 * condition on column `col` for the two SQL adapters. `ph()` renders the next placeholder in the
 * adapter's syntax (`?` or `$k`); `params` fill them in order. `outside: true` negates it.
 *
 * NOT `LIKE`: an organization id may hold `_` or `%`, and SQLite's `LIKE` ignores case. And the
 * length is counted in CHARACTERS (code points), which is what SQL `substring` counts on SQLite and
 * Postgres — not `prefix.length`, which counts UTF-16 code units: for an id outside the BMP (`🚀team`)
 * that compared one character too many and the organization listed NOTHING of its own (measured on
 * SQLite and Postgres). Bound rather than measured by the database because pg-mem has no `length()`.
 * @internal — SQL builder shared by the storage adapters.
 */
export function orgSpaceSql(col: string, ph: () => string, opts: { orgId?: string; outside?: boolean } = {}): { cond: string; params: unknown[] } {
  return prefixSql(col, opts.orgId === undefined ? ORG_KEY_PREFIX : orgPrefix(opts.orgId), ph, opts.outside === true);
}

/** `col` starts (or, with `negate`, does not start) with the bound `prefix` — characters, compared exactly. */
export function prefixSql(col: string, prefix: string, ph: () => string, negate = false): { cond: string; params: unknown[] } {
  const n = ph();
  const p = ph();
  return { cond: `substring(${col}, 1, ${n}) ${negate ? '<>' : '='} ${p}`, params: [Array.from(prefix).length, prefix] };
}

/**
 * The key prefix for an organization, and the single place an organization id is validated.
 *
 * EXPORTED so `withOrgStorage` shares this guard rather than computing its own prefix. Six ports
 * each deriving `` `org:${id}:` `` inline is six places the empty-string check can be forgotten, and
 * `''` produces `org::` — one shared partition that every organization writes into and none notices.
 */
export function orgPrefix(orgId: string): string {
  if (!orgId || orgId.includes(':')) {
    throw new Error(`@gnldev/durable: invalid orgId '${orgId}' — must be non-empty and must not contain ':'`);
  }
  return `${ORG_KEY_PREFIX}${orgId}:`;
}

/**
 * Scope a journal to an organization. The returned journal implements the same interface (putIfAbsent/
 * listKeys/readRun/listRuns are bridged if present) → it's handed as-is to runDurable/createGnl/
 * BasicMemory/queue. Organizations CANNOT SEE each other's keys; the same runId is independent across
 * different organizations.
 */
/**
 * Marks a journal as scoped to an organization, so code holding only the `Journal` can still tell.
 *
 * Needed because org isolation is implemented as a key prefix captured in a closure: everything
 * downstream sees a plain `Journal` and cannot know an org is in play. That is fine for storage —
 * the prefix does the isolating — but NOT for a value that leaves this process. The cross-run
 * idempotency key is handed to the PROVIDER (Stripe et al.), and without the org in it two isolated
 * orgs charging the same orderId produce the same provider key, so the second charge is deduped
 * against the first: org B is told it succeeded, org A paid, and both journals record success.
 * Money-shaped and silent. Read by durable-tool.ts.
 */
export const ORG_SCOPE = Symbol.for('@gnldev/durable.orgScope');

/**
 * The journal a scoped view wraps.
 *
 * `withOrg` prefixes EVERY key, with no exemptions, which is right for run data and wrong for the few
 * documents that are deliberately global. `__pricing__` is one: Studio's PUT requires a platform admin
 * (an unbound identity, so no scope) and writes it at the root, while a multi-org runtime reads through
 * a scoped journal and therefore looks for `org:<id>:__pricing__`. Measured: the document was written,
 * and `effectivePricingTable` on a scoped journal did not see it — so the spend ceiling a customer just
 * configured went on counting $0 in exactly the deployments that have organizations.
 *
 * Exposing the parent lets a global-document reader fall back without needing the caller to thread a
 * second journal through every call site. `__policy__` has the same shape and is not changed here —
 * naming it so the next person knows it is the same question, not a different one.
 */
export const ORG_PARENT = Symbol.for('@gnldev/durable.orgParent');

/** The unscoped journal behind a `withOrg` view, or undefined if this journal is not a scoped view. */
export function orgParentOf(journal: unknown): Partial<Journal> | undefined {
  return (journal as Record<symbol, Partial<Journal>> | null | undefined)?.[ORG_PARENT];
}

/** The organization a journal is scoped to, if any. */
export function orgScopeOf(journal: unknown): string | undefined {
  const v = (journal as Record<symbol, unknown> | null | undefined)?.[ORG_SCOPE];
  return typeof v === 'string' ? v : undefined;
}

/**
 * One page of `listRunsPaged` over a source that also holds rows the caller may not see.
 *
 * The underlying `listRunsPaged` has NO concept of an organization — keys are prefixed BEFORE reaching
 * it, so its index mixes every organization's runs (and the root's) in ONE keyspace. A single
 * underlying page cannot just be filtered and returned: that under-fills the requested `limit`, or —
 * combined with the underlying `nextCursor` — skips this caller's runs that fell in a page dominated by
 * others (the "filter after slicing" bug the P0.3 filter contract exists to avoid). So this WALKS the
 * source's pages forward, keeping what `keep` maps, until `limit` is reached or the source is
 * exhausted. Its cursor is a cursor of the SOURCE (run-cursor.ts), naming the last source run it
 * read — kept or not — so the next page resumes right after it, whichever way the source orders.
 * Honest cost: a caller holding a small slice of a large shared keyspace pays for walking the rest.
 * Shared by `withOrg` (an organization's runs) and `withRootScope` (the root's).
 */
async function walkRunPages(
  reader: Partial<JournalReader>,
  journal: unknown,
  q: Parameters<NonNullable<JournalReader['listRunsPaged']>>[0],
  keep: (r: RunSummary) => RunSummary | undefined,
): Promise<{ items: RunSummary[]; nextCursor?: string }> {
  const limit = q?.limit ?? 50;
  const chunk = Math.max(limit, 50); // read the underlying (mixed) store in reasonably sized chunks
  let seen = decodeRunCursor(q?.cursor)?.seen ?? 0;
  let cursor = q?.cursor;
  const items: RunSummary[] = [];
  for (;;) {
    const page = await reader.listRunsPaged!.call(journal, { ...q, cursor, limit: chunk });
    for (let i = 0; i < page.items.length; i++) {
      const r = page.items[i]!;
      seen++;
      const mine = keep(r);
      if (!mine) continue;
      items.push(mine);
      if (items.length >= limit) {
        const exhausted = i === page.items.length - 1 && !page.nextCursor;
        const next = page.items[i + 1]?.runId;
        return { items, ...(exhausted ? {} : { nextCursor: encodeRunCursor({ runId: r.runId, ...(next !== undefined ? { next } : {}), seen }) }) };
      }
    }
    if (!page.nextCursor) return { items }; // underlying store exhausted
    cursor = page.nextCursor;
  }
}

export function withOrg(scopedFrom: Journal, orgId: string): Journal & Partial<JournalReader> {
  // An organization's view of the root scope's view is the organization's view of the root: the root
  // view hides `org:` keys, and every key this view reads is one.
  const journal = rootScopeParentOf(scopedFrom) ?? scopedFrom;
  // Refuse to scope a journal that is ALREADY scoped. Nesting produces `org:acme:org:globex:<key>`:
  // the marker says 'globex' and the data sits inside acme, so acme can list, read and DELETE it —
  // measured, including `acme.deletePrefix('')` sweeping globex's rows. That is the exact opposite of
  // this module's contract ("Organizations CANNOT SEE each other's keys"), and the provider-facing
  // idempotency key would carry only `org:globex:` while the record lives under acme.
  //
  // No first-party code nests (studio and server both wrap the root journal). It became reachable as a
  // PATTERN because a test wrote `withOrg({ ...withOrg(base, 'acme') }, 'globex')` and asserted only
  // that the label had changed. Detecting it costs one line now that the marker is readable, and a
  // caller that wants a different organization should scope the ROOT journal again.
  const already = orgScopeOf(journal);
  if (already !== undefined) {
    throw new Error(
      `@gnldev/durable: this journal is already scoped to organization '${already}' — scoping it again ` +
      `as '${orgId}' would nest the prefixes (org:${already}:org:${orgId}:…), leaving the data inside ` +
      `'${already}' where that organization can read and delete it. Scope the unscoped journal instead.`,
    );
  }
  const prefix = orgPrefix(orgId);
  const out: Journal & Partial<JournalReader> = {
    get: <T = unknown>(key: string) => journal.get<T>(prefix + key),
    put: (key: string, value: unknown) => journal.put(prefix + key, value),
  };
  // Enumerable, deliberately — and this used to be `enumerable: false` on the reasoning that a marker
  // for in-process code "must not appear in a spread, a JSON round-trip, or a key listing". Two of
  // those three are free: this is a SYMBOL, and symbols are invisible to JSON.stringify, Object.keys
  // and for-in whatever their enumerability. Only the spread was actually affected — and there,
  // hiding it is the dangerous direction. `{ ...journal, put: log(journal.put) }` is the obvious way
  // to wrap a journal, and with a hidden marker it silently returns an org-scoped journal that no
  // longer reports its org: durable-tool then builds the provider-facing idempotency key WITHOUT the
  // `org:<id>:` part, and two isolated orgs charging the same orderId collide at the provider. That
  // is the money-shaped failure this symbol exists to prevent, reintroduced by the wrapper.
  //
  // Carrying it through a spread cannot produce the opposite mistake: re-wrapping with withOrg
  // defines its own value over the copy, so a journal never keeps a stale org.
  Object.defineProperty(out, ORG_SCOPE, { value: orgId, enumerable: true, configurable: true });
  // Same enumerability, same reason: a wrapper built by spreading this object must keep both markers or
  // it silently becomes a journal that cannot answer where its global documents live.
  Object.defineProperty(out, ORG_PARENT, { value: journal, enumerable: true, configurable: true });
  if (journal.putIfAbsent) {
    out.putIfAbsent = (key, value) => journal.putIfAbsent!(prefix + key, value);
  }
  if (journal.listKeys) {
    out.listKeys = async (p, opts) => (await journal.listKeys!(prefix + p, opts)).map((k) => k.slice(prefix.length));
  }
  // The person's owner records in THIS organization: the prefix goes down to the store, so another
  // organization's record naming the same id — somebody else — is never read.
  if (journal.listOwnerRecords) {
    out.listOwnerRecords = async (rid, opts) =>
      (await journal.listOwnerRecords!(rid, { prefix: prefix + (opts?.prefix ?? '') })).map((k) => k.slice(prefix.length));
  }
  if (journal.deletePrefix) {
    out.deletePrefix = (p) => journal.deletePrefix!(prefix + p); // an organization can only delete its own scope
  }
  // H1 (atomic conditional replace): the prefixed key, expected/value are delegated as-is — run-lock.ts's
  // expired-lock takeover CAS also stays atomic in the org view (if not bridged it would fall back to
  // best-effort get→put, creating a split-brain risk in a multi-organization deployment).
  if (journal.putIfMatch) {
    out.putIfMatch = (key, expected, value) => journal.putIfMatch!(prefix + key, expected, value);
  }
  // H2 (storage clock): NO prefix — time isn't organization-specific, delegated as-is.
  if (journal.now) {
    out.now = () => journal.now!();
  }
  // H8a (atomic counter): the key is prefixed → budget.ts:incrBy/getOrgUsage also use an
  // engine-internal atomic increment in the org view (would fall back to legacy get→put if not bridged).
  if (journal.incrBy) {
    out.incrBy = (key, fields) => journal.incrBy!(prefix + key, fields);
  }
  if (journal.getCounters) {
    out.getCounters = (key) => journal.getCounters!(prefix + key);
  }
  // P1.6b: atomic batch — every key inside `batch` (claim/incrs/puts) is prefixed the SAME way put()/
  // incrBy() prefix their own single key, so the org isolation guarantee carries over unchanged.
  if (journal.applyBatch) {
    out.applyBatch = (batch: JournalBatch) => journal.applyBatch!({
      ...(batch.claim ? { claim: { key: prefix + batch.claim.key, value: batch.claim.value } } : {}),
      ...(batch.incrs ? { incrs: batch.incrs.map((i) => ({ key: prefix + i.key, fields: i.fields })) } : {}),
      ...(batch.puts ? { puts: batch.puts.map((p) => ({ key: prefix + p.key, value: p.value })) } : {}),
    });
  }
  // P1.6b: batch point-read — keys prefixed the same way get() prefixes a single key; order preserved (contract).
  if (journal.getMany) {
    out.getMany = (keys: string[]) => journal.getMany!(keys.map((k) => prefix + k));
  }
  // P1.6b: `countRunsByStatus` is DELIBERATELY NOT bridged here (unlike every other optional capability
  // above) — it's an ENGINE-LEVEL aggregate over the WHOLE underlying store (e.g. SQL `GROUP BY` on
  // `gnl_runs`), with NO per-organization filter parameter to push the `org:<id>:` prefix into. Bridging
  // it naively would leak EVERY organization's counts into this one's view (a real cross-organization data
  // leak) — so it's left undefined; callers (studio's /metrics) fall back to the already org-safe
  // `listRuns`-based count.
  // H8b (stale run scan): the underlying result physically comes back as `org:<orgId>:<runId>`
  // (parseJournalKey counts the ENTIRE prefixed key as the runId — see the run_id column in
  // sqlite/postgres-storage.ts). ONLY the ones belonging to THIS organization are FILTERED and the
  // prefix is STRIPPED before returning — the same isolation pattern as readRun/listRuns (other
  // organizations' runs don't leak).
  if (journal.listStaleRuns) {
    out.listStaleRuns = async (cutoffTs, opts) =>
      (await journal.listStaleRuns!(cutoffTs, opts))
        .filter((runId) => runId.startsWith(prefix))
        .map((runId) => runId.slice(prefix.length));
  }
  const reader = journal as unknown as Partial<JournalReader>;
  if (typeof reader.readRun === 'function') {
    out.readRun = async (runId: string): Promise<JournalEntry[]> =>
      (await reader.readRun!.call(journal, prefix + runId)).map((e) => ({
        ...e,
        key: e.key.startsWith(prefix) ? e.key.slice(prefix.length) : e.key,
        runId: e.runId.startsWith(prefix) ? e.runId.slice(prefix.length) : e.runId,
      }));
  }
  if (typeof reader.listRuns === 'function') {
    // listRunsArray, not a direct `.filter`: the underlying reader may hand back a Page (every
    // first-party `storage.runs` does, and that is what the README's quickstart passes as `journal`).
    // Calling `.filter` on it threw, which took the ORG USAGE/quota path down with it.
    out.listRuns = async (): Promise<RunSummary[]> =>
      (await listRunsArray({ listRuns: (q) => (reader.listRuns as (qq?: unknown) => Promise<unknown>).call(journal, q) }))
        .filter((r) => r.runId.startsWith(prefix))
        .map((r) => ({ ...r, runId: r.runId.slice(prefix.length) }));
  }
  // Paged: walked, not filtered per page — see `walkRunPages`.
  if (typeof reader.listRunsPaged === 'function') {
    // The organization's own range of the run id (`runIdPrefix`): Sqlite and Postgres read just that
    // slice of their index, so an organization with few runs on a large store is not answered by
    // walking everyone else's (measured: an empty organization's first page read 4 000 pages of
    // 200 000 root runs, 661 ms). `keep` still decides each row — a journal that ignores the filter
    // stays exact, and only walks.
    out.listRunsPaged = (q) => walkRunPages(reader, journal, { ...q, runIdPrefix: prefix + (q?.runIdPrefix ?? '') }, (r) => (r.runId.startsWith(prefix) ? { ...r, runId: r.runId.slice(prefix.length) } : undefined));
  }
  // H8c (run size statistics): runId is prefixed, the result (entries/bytes) is independent of the
  // organization — returned as-is. If not bridged, retention/budget's stats path would silently disappear in the org view.
  if (typeof reader.readRunStats === 'function') {
    out.readRunStats = (runId: string) => reader.readRunStats!.call(journal, prefix + runId);
  }
  return out;
}

/** The journal a `withRootScope` view hides organizations' rows of. */
const ROOT_SCOPE_OF = Symbol.for('@gnldev/durable.rootScopeOf');

/**
 * The journal behind a `withRootScope` view, or undefined if `journal` is not one.
 * @internal — thread-owner.ts probes the raw store under a root view in bounded pages.
 */
export function rootScopeParentOf(journal: unknown): Journal | undefined {
  return (journal as Record<symbol, Journal> | null | undefined)?.[ROOT_SCOPE_OF];
}

/**
 * The ROOT scope's reader: the same journal, with every organization's rows hidden from its reads.
 *
 * ADR-0001: "In the root scope, every organization's rows are hidden." Memory held that from the
 * store's own methods (`MEMORY_PARTITION`); runs did not. An organization's run sits physically in the
 * root journal as `org:<id>:<runId>`, and the root scope read through the raw journal — so Studio's and
 * the REST API's `GET /runs` at the root listed `org:acme:r-acme`, and `GET /runs/org:acme:r-acme`
 * returned acme's journal (measured: the model's answer, the prompt). This is the one owner of that
 * rule for runs; a door hands it out wherever it serves the root scope.
 *
 * READS ONLY. `get`, `getMany`, `getCounters`, `listKeys`, `listOwnerRecords`, `readRun`, `readRunStats`, `listRuns`,
 * `listRunsPaged` and `listStaleRuns` answer as if no `org:` key existed (`isOrganizationKey`);
 * `countRunsByStatus` answers only while no organization holds a row — it counts every organization's
 * runs and takes no filter — and otherwise resolves `undefined` (a caller falls back to `listRuns`, as
 * it does under `withOrg`). Writes pass through unchanged: a
 * root caller cannot name an `org:` run in the first place (`assertRunId`), and root management that is
 * DEFINED over every organization — a retention sweep, a platform admin's purge — takes the raw journal
 * on purpose.
 *
 * THE WAY THROUGH, for an operator who must read an organization's runs: that organization's scope.
 * `withOrg(view, orgId)` scopes the journal underneath (it does not stack on the hiding), and a door
 * serves it to a platform admin who names the organization (`x-gnl-org`).
 */
export function withRootScope<J extends Partial<Journal> & Partial<JournalReader>>(journal: J): J {
  if (rootScopeParentOf(journal) !== undefined) return journal;
  const org = orgScopeOf(journal);
  if (org !== undefined) {
    throw new Error(`@gnldev/durable: withRootScope was handed organization '${org}''s journal. It hides organizations' rows from the ROOT journal; an organization's view already holds only its own.`);
  }
  const j = journal as Partial<Journal> & Partial<JournalReader>;
  const hidden = isOrganizationKey;
  const overrides: Record<PropertyKey, unknown> = {
    [ROOT_SCOPE_OF]: journal,
    get: j.get && (async (key: string) => (hidden(key) ? undefined : j.get!(key))),
    getMany: j.getMany && (async (keys: string[]) => {
      const shown = keys.filter((k) => !hidden(k));
      const got = shown.length ? await j.getMany!(shown) : [];
      let i = 0;
      return keys.map((k) => (hidden(k) ? undefined : got[i++]));
    }),
    getCounters: j.getCounters && (async (key: string) => (hidden(key) ? undefined : j.getCounters!(key))),
    listKeys: j.listKeys && (async (p: string, o?: unknown) =>
      (hidden(p) ? [] : (await (j.listKeys as (pp: string, oo?: unknown) => Promise<string[]>)(p, o)).filter((k) => !hidden(k)))),
    listOwnerRecords: j.listOwnerRecords && (async (rid: string, o?: { prefix?: string }) =>
      (hidden(o?.prefix ?? '') ? [] : (await j.listOwnerRecords!(rid, o)).filter((k) => !hidden(k)))),
    readRun: j.readRun && (async (runId: string) => (hidden(runId) ? [] : j.readRun!(runId))),
    readRunStats: j.readRunStats && (async (runId: string) => (hidden(runId) ? { entries: 0, bytes: 0 } : j.readRunStats!(runId))),
    listRuns: j.listRuns && (async () =>
      (await listRunsArray({ listRuns: (q) => (j.listRuns as (qq?: unknown) => Promise<unknown>).call(journal, q) }))
        .filter((r) => !hidden(r.runId))),
    listRunsPaged: j.listRunsPaged
      && ((q?: Parameters<NonNullable<JournalReader['listRunsPaged']>>[0]) => walkRunPages(j, journal, q, (r) => (hidden(r.runId) ? undefined : r))),
    listStaleRuns: j.listStaleRuns && (async (cutoffTs: number, o?: { includeSuspended?: boolean }) =>
      (await j.listStaleRuns!(cutoffTs, o)).filter((runId) => !hidden(runId))),
    // Counted by the store only while no organization holds a row: then the store's count IS the
    // root's. Once one does, `undefined` — the store's aggregate takes no filter — and a caller falls
    // back to `listRuns`, as under `withOrg`. One indexed probe, so a single-tenant deployment keeps
    // the cheap count. A reader that cannot list keys cannot be probed, and keeps its count: a number,
    // never a row, and the push-down paging that depends on it (Studio's `GET /runs?limit=`).
    countRunsByStatus: j.countRunsByStatus && (async () => {
      if (typeof j.listKeys === 'function' && (await j.listKeys(ORG_KEY_PREFIX, { limit: 1 })).length > 0) return undefined;
      return j.countRunsByStatus!();
    }),
  };
  return new Proxy(journal, {
    get(t, prop) {
      if (Object.prototype.hasOwnProperty.call(overrides, prop)) return overrides[prop];
      const v = Reflect.get(t, prop, t);
      return typeof v === 'function' ? v.bind(t) : v;
    },
    has: (t, prop) => (Object.prototype.hasOwnProperty.call(overrides, prop) ? overrides[prop] !== undefined : Reflect.has(t, prop)),
  });
}

/**
 * The exclusive upper bound of a prefix range, for a store that orders strings by BYTES.
 *
 * Every prefix scan here is `key >= prefix AND key < bound`. The bound used to be `prefix + U+FFFF`,
 * on the assumption that U+FFFF sorts above anything that can follow the prefix. In UTF-16 (what JS
 * string comparison uses) it does — an astral character is a surrogate pair starting at U+D800, which
 * is below U+FFFF. In UTF-8, which is what SQLite and Postgres actually compare, it does NOT: U+FFFF
 * encodes as EF BF BF and any astral character starts with F0 or higher.
 *
 * Measured on SQLite, three keys under `org:acme:` where one run id begins with an emoji:
 *   listKeys('org:acme:')   → 2 of 3
 *   deletePrefix('org:acme:') → deleted 2, returned 2, and the third key was still there
 *
 * So an organization purge or a GDPR erasure reported success while leaving rows behind, for run ids
 * that are perfectly legal — the same silent, "succeeded" shape as the collation bug, reached through
 * a different door.
 *
 * Incrementing the prefix's last code point is exact rather than a taller sentinel: no suffix can sort
 * at or above it, because any key that did would no longer start with the prefix.
 */
export function prefixUpperBound(prefix: string): string | undefined {
  // An empty prefix means EVERY key, so there is no upper bound to compute — and returning '' was a
  // regression: `key < ''` is never true, so `listKeys('')` returned nothing and `deletePrefix('')`
  // deleted nothing while reporting 0. Measured on SQLite: 0 of 2 keys. That is the same silent-success
  // shape this function exists to remove, reintroduced at the one input that means "all of it".
  // `undefined` forces the caller to omit the upper bound rather than compare against a sentinel.
  if (!prefix) return undefined;
  const cps = Array.from(prefix);
  const last = cps.pop()!;
  let next = last.codePointAt(0)! + 1;
  // Lone surrogates are not valid scalar values and do not survive a UTF-8 round trip.
  if (next >= 0xD800 && next <= 0xDFFF) next = 0xE000;
  if (next > 0x10FFFF) {
    // The prefix ends at the highest code point there is, so nothing can be incremented. Fall back to
    // appending the maximum character: the range is then everything from `prefix` up to
    // `prefix + U+10FFFF`, which covers every suffix except one that begins with U+10FFFF itself.
    return prefix + '\u{10FFFF}';
  }
  return cps.join('') + String.fromCodePoint(next);
}
