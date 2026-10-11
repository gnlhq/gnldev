/**
 * WHAT GOES WITH WHAT — one model of what a run, a thread, a person and an organization own, and one
 * executor that deletes by it (ADR-0007 decision 4).
 *
 * WHY. "What goes with a thread" used to be written down in eight places — the three stores'
 * `deleteThread`, the organization view's, `purgeThread`, `eraseSubject`'s own thread loop, and the
 * adoption table lists — and the copies had drifted. Measured on 35b70348 with one world on InMemory,
 * Sqlite, pg-mem and real Postgres (raporlar/…/ekler/cplus-c/h5-before-analysis.txt):
 *  - deleting a thread (`MemoryStore.deleteThread`, `AgentMemory.deleteThread`, Studio's
 *    `DELETE /threads/:id`) took its 9 memory-store rows and nothing else: its 6 runs with their 46
 *    journal keys (prompts, tool arguments, the approval waiting on the thread), the observer's
 *    summaries (`om:`), its idempotency window (`xthr:`), its owner record and its observation vector
 *    all stayed;
 *  - `purgeThread` took exactly the other half — the 7 journal records — and left every message;
 *  - only `eraseSubject` reached all of it, through a third list of its own.
 * Each copy was right about something the others missed. One list cannot disagree with itself.
 *
 * THE SHAPE. The model is data (`THREAD_DEPENDENTS`, `RUN_DEPENDENTS`, `PERSON_FAMILIES`,
 * `SCOPE_TABLES`). The planner reads the store only to FIND entities — the runs on a thread by their
 * relation column, a run's sub-agent children by its tool records — and turns "delete thread T" or
 * "purge run R" into an ordered list of concrete steps. The executor runs that list against the stores
 * it is handed. Each adapter keeps its own primitives (a prefix DELETE, the memory store's own
 * `deleteThread` of its rows): the model decides WHAT, the adapter HOW.
 *
 * ORDER — what makes a deletion safe to kill and run again:
 *  - children before parents: a sub-agent before the run that called it (the parent's tool record is
 *    how a second attempt finds the child), every run on a thread before the thread;
 *  - the thread's owner record LAST. Until it goes the thread is gated: a half-deleted thread is still
 *    its owner's, and nobody else can open it and read what is left. Deleted first, a crash left the
 *    remains of the conversation to the next caller who named the thread (dependents-model.test.ts P6);
 *  - every step is idempotent: deleting what is already gone deletes nothing, and a run's usage is
 *    subtracted after its records (the counted-marker among them) are gone, so a retry never subtracts
 *    it again.
 */
import { runKeys, nestedAgentRunId, runIdOfKey, executedHere, listRunsWhere } from './journal.js';
import type { Journal, JournalReader, RunSummary } from './journal.js';
import { MEM_LEAVES, OM_LEAVES, SEMANTIC_LOG_PREFIX, SEMANTIC_LOG_SUFFIX, OM_VECTOR_SOURCE } from './memory.js';
import { threadOwnerKey, threadSeenKey } from './thread-owner.js';
import { isOrganizationKey } from './organization.js';
import { ThreadRunsInFlightError } from './errors.js';
import type { MemoryStore, VectorStore } from './storage.js';
import { getRunCost } from './cost.js';
import { metricsRunKey, metricsDoneKey, metricsScoresDoneKey } from './metrics.js';
import { USAGE_KEY, usageCountedKey } from './budget.js';
import type { OrganizationUsage } from './budget.js';
import { fenceRun, runErasedSince } from './erasure-fence.js';
import type { ErasureBaseline } from './erasure-fence.js';

// ── How a thread id is read back out of a key ────────────────────────────────────────────────────
// Thread ids may contain ':' (memory.ts keeps it legal on purpose), so a thread's keys are recognised
// by a KNOWN boundary — a leaf or a family the writer uses — never by splitting.
// BasicMemory's known key suffixes (memory.ts schema): `mem:<threadId>:messages|:working`.
// threadId itself may contain ':' → the extraction is done via known-suffix matching, NOT split.
//
// DERIVED, not retyped. A second copy of this list drifts silently in the direction that is hardest
// to notice: an unlisted leaf makes its thread invisible to `threadIdsFromMemory`, and a thread that
// is not known is reported ORPHANED even though its memory is sitting right beside its dedup state.
export const MEM_PREFIX = 'mem:';
const MEM_SUFFIXES = MEM_LEAVES.map((leaf) => `:${leaf}`);

// The `xthr:<threadId>:<family>-…` families, listed so a threadId can be recovered from a key the
// same way MEM_SUFFIXES recovers one from `mem:` — by matching a KNOWN boundary rather than
// splitting on ':', because a threadId may contain ':' itself (memory.ts says so explicitly).
// Ordered longest-first so ':semtomb-' is never mistaken for ':sem-' + 'tomb-'.
export const XTHR_PREFIX = 'xthr:';
const XTHR_FAMILIES = [':semjudge-', ':semtomb-', ':sem-', ':dup-', ':args-'] as const;

// `om:<threadId>:<leaf>` and `om:<threadId>:proc:<step>`. The step names (`observe:0`, `vec:0:1`)
// never contain ':proc:', so the LAST ':proc:' is the boundary, whatever the thread id holds.
export const OM_PREFIX = 'om:';
const OM_SUFFIXES = OM_LEAVES.map((leaf) => `:${leaf}`);

/** threadId out of SemanticMemory's `sem:<threadId>:log` (`semanticLogKey`). */
export function threadIdOfSemKey(key: string): string | undefined {
  const rest = key.slice(SEMANTIC_LOG_PREFIX.length);
  return rest.endsWith(SEMANTIC_LOG_SUFFIX) && rest.length > SEMANTIC_LOG_SUFFIX.length ? rest.slice(0, -SEMANTIC_LOG_SUFFIX.length) : undefined;
}

export function threadIdOfOmKey(key: string): string | undefined {
  const rest = key.slice(OM_PREFIX.length);
  for (const suffix of OM_SUFFIXES) if (rest.endsWith(suffix) && rest.length > suffix.length) return rest.slice(0, -suffix.length);
  const cut = rest.lastIndexOf(':proc:');
  return cut > 0 ? rest.slice(0, cut) : undefined;
}

/** threadId out of `xthr:<threadId>:<family>-…`, or undefined when no known family boundary is found. */
export function threadIdOfXthrKey(key: string): string | undefined {
  const rest = key.slice(XTHR_PREFIX.length);
  // LAST boundary wins: a threadId that itself contains ':dup-…' keeps its own text, and the family
  // written by this runtime is always the final segment.
  let cut = -1;
  for (const fam of XTHR_FAMILIES) {
    const i = rest.lastIndexOf(fam);
    if (i > cut) cut = i;
  }
  return cut > 0 ? rest.slice(0, cut) : undefined;
}

/** threadId out of `mem:<threadId>:<leaf>` — the known-LEAF counterpart of threadIdOfXthrKey, and
 *  the answer purgeThreadNamespace needs to tell its own keys from a descendant thread's. */
export function threadIdOfMemKey(key: string): string | undefined {
  const rest = key.slice(MEM_PREFIX.length);
  for (const suffix of MEM_SUFFIXES) {
    if (rest.endsWith(suffix) && rest.length > suffix.length) return rest.slice(0, -suffix.length);
  }
  return undefined;
}

// ── The journal primitives the executor runs ────────────────────────────────────────────────────

export function requireDelete(journal: Journal): NonNullable<Journal['deletePrefix']> {
  if (typeof journal.deletePrefix !== 'function') {
    throw new Error("@gnldev/durable: journal must support 'deletePrefix' for purge (InMemory/Sqlite/Postgres provide it)");
  }
  return journal.deletePrefix.bind(journal);
}

/**
 * The workflow run-registry key, derived exactly the way @gnldev/workflow's `statusKey` WRITES it
 * (`wfrun:<runId>`). Mirrored rather than imported: this package stays structurally decoupled from
 * @gnldev/workflow (see registry.ts's WorkflowLike JSDoc), and the same mirroring already happens in
 * registry.ts's FLOW-08 comment and its tests. The record is deliberately NOT under `<runId>:` — a
 * top-level key so ONE prefix scan enumerates every workflow run — which is precisely why the
 * `${runId}:` deletes in purgeRun never reached it.
 */
export const workflowStatusKey = (runId: string) => `wfrun:${runId}`;

/**
 * Deletes ONE key on a port that only offers PREFIX deletion. `wfrun:<runId>` ends where the runId
 * ends, so `deletePrefix('wfrun:r-1')` also takes `wfrun:r-10` — a DIFFERENT run's record, and that
 * boundary is the property purge.test.ts exists to protect. Extension neighbors are therefore read
 * back and rewritten around the delete. The rewrite is sound because the value is the one just read
 * and the record is an advisory mirror (@gnldev/workflow's `putStatus` is best-effort; the
 * WorkflowResult return value is the source of truth) — a status transition landing inside the window
 * loses one advisory update, which the run's next transition overwrites.
 *
 * Without listKeys the neighbors cannot be seen at all, so the delete is attempted only when the EXACT
 * record exists: a purge can then never turn a runId that owns no record into a prefix sweep of other
 * runs' records. The remaining case (the record exists AND a longer runId extends it on a journal with
 * no listKeys) is stated, not hidden — every adapter shipped here provides listKeys.
 */
export async function deleteExactKey(journal: Journal, key: string): Promise<number> {
  const del = requireDelete(journal);
  if ((await journal.get(key)) === undefined) return 0;
  const lk = journal.listKeys;
  if (typeof lk !== 'function') return del(key);
  const neighbors: Array<[string, unknown]> = [];
  for (const k of await lk.call(journal, key)) {
    if (k === key) continue;
    neighbors.push([k, await journal.get(k)]);
  }
  // CRASH WINDOW, stated: between this delete (which takes the neighbours too — delete is a prefix
  // operation) and the re-puts below, a process death loses the neighbours' records with no trace.
  // Accepted for now because the window is a handful of point-writes inside a rare, deliberate
  // operation; closing it for real needs a `deleteExact` port on the adapters (backlog).
  const deleted = await del(key);
  for (const [k, value] of neighbors) {
    if (value !== undefined) await journal.put(k, value);
  }
  return Math.max(0, deleted - neighbors.length);
}

/**
 * Deletes everything under `${runId}:` WITHOUT taking a run whose id extends this one.
 *
 * `${runId}:` looks like a safe prefix because it carries the separator — and against `r-1` vs `r-10`
 * it is (purge.test.ts pins that). The case it does not cover is the one where the neighbour's id
 * IS this id plus more: run `conv` and run `conv:msg1` are two ordinary runs, and every key of the
 * second lives under the prefix of the first. MEASURED on InMemoryJournal and SqliteStorage:
 * `purgeRun('conv')` removed `conv:msg1`'s model record, its tool record, its frozen input and its
 * frozen model choice. That pair is not contrived — @gnldev/chat-adapter DERIVES its per-turn runId as
 * `${conversationId}:${messageId}`, so any host that also runs something under the bare conversation
 * id has it.
 *
 * The fix uses the journal's own answer to "whose key is this": `runIdOfKey` (journal.ts), which is
 * already `_v`-corroborated and already the function the run index trusts. A key under our prefix
 * whose owner is a LONGER runId that starts with our prefix belongs to a neighbour; everything that
 * neighbour owns is then left alone wholesale, not just the three families runIdOfKey can name.
 *
 * TWO honest bounds, both deliberate:
 *  • Without `listKeys` there is nothing to filter on, so the single prefix delete stands — today's
 *    behaviour, stated rather than silently degraded. Every adapter shipped here provides listKeys.
 *  • With listKeys and NO neighbour found — the overwhelmingly common case — this is the old single
 *    `deletePrefix` call plus one key listing and a point-read per `:input` key (the only family
 *    whose owner needs the value; `:model:`/`:tool:` decide from the key text alone). The per-key
 *    delete path only runs when a neighbour actually exists; purge is a rare, deliberate operation
 *    (GDPR erasure / retention sweep), never a request path.
 */
export async function purgeOwnNamespace(journal: Journal & Partial<JournalReader>, runId: string): Promise<number> {
  const del = requireDelete(journal);
  const prefix = `${runId}:`;
  const lk = journal.listKeys;
  if (typeof lk !== 'function') return del(prefix);
  const keys = await lk.call(journal, prefix);
  const neighbours = new Set<string>();
  for (const k of keys) {
    // runIdOfKey reads the value only for `:input` keys — a point-read on every key here turned a
    // nightly sweep over a large namespace into O(keys) round-trips for values it never looked at.
    const owner = runIdOfKey(k, k.endsWith(':input') ? await journal.get(k) : undefined);
    if (owner && owner !== runId && owner.startsWith(prefix)) neighbours.add(owner);
  }
  if (neighbours.size === 0) return del(prefix);
  let total = 0;
  for (const k of keys) {
    let foreign = false;
    for (const n of neighbours) if (k === n || k.startsWith(`${n}:`)) { foreign = true; break; }
    if (foreign) continue;
    // deleteExactKey rather than del(k): a key is a prefix too, and one of OUR keys can be a proper
    // prefix of a neighbour's id (`conv:ms` against `conv:msg1`). The same boundary, one level down.
    total += await deleteExactKey(journal, k);
  }
  return total;
}

/**
 * Does a DERIVED child runId actually have a trace? Keys first, because listKeys sees a workflow
 * child's `<runId>:wf:<step>` records and readRun cannot (they are not `:model:`/`:tool:` entries, so
 * parseJournalKey is blind to them by design). The run-registry record is the last probe: a workflow
 * whose steps all live behind a suspend, or one built with no steps at all, has written nothing else.
 */
export async function hasTrace(journal: Journal & Partial<JournalReader>, runId: string): Promise<boolean> {
  const lk = journal.listKeys;
  const rr = journal.readRun;
  if (typeof lk === 'function') {
    if ((await lk.call(journal, `${runId}:`)).length > 0) return true;
  } else if (typeof rr === 'function' && (await rr.call(journal, runId)).length > 0) {
    return true;
  }
  return (await journal.get(workflowStatusKey(runId))) !== undefined;
}

/**
 * 1.1: a purged run's cost comes OFF the usage counter (H4: otherwise `__usage__` goes stale after
 * purge — the deleted run's cost keeps being counted as a ghost). Only when the `usage-counted` marker
 * EXISTS (i.e. it was actually added to the counter) — this avoids pushing a never-counted run (e.g.
 * still suspended) into the negative. Best-effort: skipped if the journal read surface isn't
 * supported (the purge itself still runs).
 *
 * TWO HALVES, because the order is what keeps a retry honest: what to subtract is read BEFORE the run
 * goes (`getRunCost` reads its records), and subtracted AFTER its records — the marker among them —
 * are gone. Killed in between, the retry finds no marker and subtracts nothing: the counter keeps one
 * run's usage (an over-count, the side a budget can live with). The old order — subtract, then delete
 * the run — left the marker to a retry, which subtracted the same run a second time (an under-count:
 * spend the budget never sees). Measured: dependents-model.test.ts P10. It costs no statement: the
 * marker goes with the run's namespace, in the same DELETE.
 */
interface PendingUsage { cost: { totalTokens: number; costUsd: number }; legacy?: OrganizationUsage }
async function usageToSubtract(journal: Journal & Partial<JournalReader>, runId: string): Promise<PendingUsage | undefined> {
  if (typeof journal.get !== 'function' || typeof journal.put !== 'function' || typeof journal.readRun !== 'function') return undefined;
  if ((await journal.get(usageCountedKey(runId))) === undefined) return undefined; // never counted → nothing to subtract
  // H8a fix: usage can live in the legacy USAGE_KEY OR in atomic counters — the old guard, which
  // only looked at legacy, silently skipped the subtraction in the counter-only case (caught by a test).
  const legacy = await journal.get<OrganizationUsage>(USAGE_KEY);
  const counters =
    typeof (journal as Journal).getCounters === 'function'
      ? await (journal as Journal).getCounters!(USAGE_KEY)
      : undefined;
  if (!legacy && !counters) return undefined; // no counter at all → nothing to subtract
  const cost = await getRunCost(journal as unknown as JournalReader, runId);
  return { cost, ...(legacy ? { legacy } : {}) };
}
async function subtractUsage(journal: Journal, pending: PendingUsage | undefined): Promise<void> {
  if (!pending) return;
  const { cost, legacy } = pending;
  // H8a: if incrBy exists, subtract ATOMICALLY with a negative delta (reads are clamped to 0 on
  // the readUsageCounter side); otherwise legacy get→put + clamp (single-process safe).
  if (typeof journal.incrBy === 'function') {
    try {
      await journal.incrBy(USAGE_KEY, { runs: -1, tokens: -cost.totalTokens, costUsd: -cost.costUsd });
      return;
    } catch { /* fall back to legacy */ }
  }
  if (!legacy) return; // no legacy record → no legacy subtraction either
  await journal.put(USAGE_KEY, {
    runs: Math.max(0, legacy.runs - 1),
    tokens: Math.max(0, legacy.tokens - cost.totalTokens),
    costUsd: Math.max(0, legacy.costUsd - cost.costUsd),
  });
}

/**
 * `resthr:<resourceId>:<threadId>` — who a thread belonged to, kept AFTER the run that said so.
 *
 * The resourceId part is ESCAPED (`%` and `:`), because both halves may contain ':' and the key has
 * to say where one ends. Unescaped, `resthr:bob:evil:th1` read as bob's trace of thread `evil:th1`,
 * and erasing `bob` deleted `bob:evil`'s trace. An id with neither character is written byte for byte
 * as before.
 */
export const escOwnerPart = (v: string) => v.replace(/%/g, '%25').replace(/:/g, '%3A');
export const ownershipTraceKey = (resourceId: string, threadId: string): string =>
  `resthr:${escOwnerPart(resourceId)}:${threadId}`;

/**
 * Everything under `<prefix><threadId>:` that belongs to THIS thread — and nothing belonging to a
 * thread whose id merely EXTENDS it.
 *
 * `mem:tenant:7:` is not a boundary. 'tenant:7' and 'tenant:7:chat' are two legitimate threads —
 * memory.ts keeps ':' legal on purpose and a test pins it — and every key of the second sits under
 * the prefix of the first. Measured before this existed: purging 'tenant:7' took all six keys, the
 * neighbour's three among them, and the report named only 'tenant:7'.
 *
 * The same shape `purgeOwnNamespace` uses for runs, with the owner rule passed in, because the
 * recovery differs per namespace: a `mem:` key ends in a known LEAF, an `xthr:` key carries a known
 * FAMILY. Both are known-boundary matches rather than a split on ':' — the rule this file's own
 * `resthr:` block already states two blocks below, and the one the raw prefix delete above it
 * skipped.
 *
 * TWO bounds, the same two purgeOwnNamespace states:
 *  • No `listKeys` → nothing to filter on, so the single prefix delete stands. Stated, not hidden.
 *  • No neighbour found (the overwhelmingly common case) → one `deletePrefix`, today's cost, plus
 *    one listing. The per-key path runs only when a descendant thread actually exists.
 */
async function purgeThreadNamespace(
  journal: Journal,
  prefix: string,
  threadId: string,
  ownerOf: (key: string) => string | undefined,
): Promise<number> {
  const del = requireDelete(journal);
  const scope = `${prefix}${threadId}:`;
  const lk = journal.listKeys;
  if (typeof lk !== 'function') return del(scope);

  const keys = await lk.call(journal, scope);
  const mine: string[] = [];
  let foreign = false;
  for (const k of keys) {
    const owner = ownerOf(k);
    if (owner === threadId) { mine.push(k); continue; }
    if (owner !== undefined) { foreign = true; continue; } // a descendant thread's key
    // Owner unknown — a leaf or family this build cannot name. ONE remaining segment can only be
    // our own unrecognised leaf (`mem:tenant:7:summary`); one that still contains ':' is
    // indistinguishable from a descendant's key, and guessing there is how a live thread dies.
    if (k.slice(scope.length).includes(':')) foreign = true; else mine.push(k);
  }
  if (!foreign) return del(scope);

  let total = 0;
  // deleteExactKey rather than del(k): a key is a prefix too — `mem:t:messages` is a proper prefix
  // of `mem:t:messagesX:working`, which belongs to thread 't:messagesX'. The same boundary, one
  // level down; purgeOwnNamespace makes the identical call for the identical reason.
  for (const k of mine) total += await deleteExactKey(journal, k);
  return total;
}

// ── The model: what each entity owns ─────────────────────────────────────────────────────────────

/** A journal namespace keyed by thread: the thread's keys are `<prefix><threadId>:…`. */
export interface ThreadNamespace {
  prefix: string;
  /** The thread a key under `prefix` belongs to (a descendant thread shares the prefix), or undefined when no known boundary is found. */
  ownerOf(key: string): string | undefined;
  /** What it holds. */
  holds: string;
}

/** The journal namespaces a thread owns. */
export const THREAD_NAMESPACES: readonly ThreadNamespace[] = [
  { prefix: MEM_PREFIX, ownerOf: threadIdOfMemKey, holds: 'BasicMemory: the messages and the working memory (`mem:<t>:messages|working`)' },
  { prefix: XTHR_PREFIX, ownerOf: threadIdOfXthrKey, holds: 'the thread idempotency window, duplicate markers, semantic records, tombstones and judge verdicts' },
  { prefix: OM_PREFIX, ownerOf: threadIdOfOmKey, holds: "observational memory's counters and memoized observer output — the model's summary of the conversation" },
  { prefix: SEMANTIC_LOG_PREFIX, ownerOf: threadIdOfSemKey, holds: "SemanticMemory's message log (@gnldev/rag)" },
];

/**
 * Everything a THREAD owns, by store. A thread delete takes all of it (0.x, breaking: before this it
 * took one store's half — see the file header), in this order:
 */
export const THREAD_DEPENDENTS = {
  /**
   * 1. Its runs: every run whose `:input` names the thread — found by the relation column
   * (`listRunsWhere({ threadId })`, indexed on Sqlite and Postgres), so a sub-agent, a fork and a
   * rollover that carry the thread go too — each with its own children (`RUN_DEPENDENTS`).
   */
  runs: 'listRunsWhere({ threadId })',
  /** 2. Its journal state, and the ownership traces retention left pointing at it (`resthr:<person>:<threadId>`). */
  journal: THREAD_NAMESPACES,
  traces: 'resthr:',
  /** 3. Its observation vectors, by `{ source, threadId }` — whoever they were labelled for. */
  vectors: { source: OM_VECTOR_SOURCE },
  /**
   * 4. Its memory-store half, through the store's own `MemoryStore.deleteThread`: the record (kept as a
   * tombstone with no title or metadata), the messages, the thread's working memory (0.7 and 0.6 keys),
   * the observations, the batch markers.
   */
  memoryStore: 'MemoryStore.deleteThread',
  /** 5. Last: the records that say the thread exists and whose it is — the mark, then the owner. */
  records: [threadSeenKey, threadOwnerKey] as const,
} as const;

/**
 * Everything a RUN owns. A fork or a rollover is not here: it is a run of its own (its own `:input`),
 * and goes with its thread or its person, never with the run it was made from.
 */
export const RUN_DEPENDENTS = {
  /** Every record under its own id (`<runId>:…`), a run whose id extends it excepted (`purgeOwnNamespace`). */
  namespace: (runId: string): string => `${runId}:`,
  /** Prefix families outside the namespace: the request window it opened, its network steps. */
  prefixes: [runKeys.toolRequestPrefix, (runId: string): string => `net:${runId}:`] as const,
  /** Keys outside the namespace that END where the run id ends — deleted exactly, never as a prefix (`deleteExactKey`). */
  exactKeys: [runKeys.memAppended, runKeys.memUserAppended, workflowStatusKey, metricsRunKey, metricsDoneKey, metricsScoresDoneKey] as const,
  /**
   * Its child runs, read from its own tool records before it goes: a sub-agent and a workflow-as-tool,
   * each in the parent-scoped shape and the bare legacy one, and its network steps (`net:<runId>:<i>`).
   */
  children: (runId: string, toolCallId: string): string[] => [
    nestedAgentRunId(runId, toolCallId), `agent:${toolCallId}`, nestedAgentRunId(runId, toolCallId, 'wf'), `wf:${toolCallId}`,
  ],
  /** A request-window record this run EXECUTED (`executedHere`): its output, kept under the request's family. */
  mirrors: 'executedHere',
  /** Its share of the usage counter, subtracted before it goes (`usageCountedKey` marks that it was counted). */
  usage: usageCountedKey,
} as const;

/** The record families a PERSON's id names (`<prefix><resourceId>:…`): cross-channel ids, lessons, lesson counters. */
export const PERSON_FAMILIES = ['xid:res:', 'lesson:res:', 'suggstats:lesson:res:'] as const;

/**
 * Everything a PERSON owns: their threads (by owner record — the one owner source — and by the memory's
 * listing), each deleted as a thread is; their runs on no thread of theirs (`listRunsWhere({ resourceId })`);
 * the families their id names; their working memory; their documents (`owner`); their owned jobs and
 * events (`ownedPrefix`); and what each background package's eraser holds. `eraseSubject` runs it.
 */
export const PERSON_DEPENDENTS = {
  threads: 'owner records (listOwnerRecords) + MemoryStore.listThreads({ resourceId })',
  runs: 'listRunsWhere({ resourceId })',
  families: PERSON_FAMILIES,
  workingMemory: 'workingMemoryScope.resource + legacyWorkingMemoryScope.resource',
  vectors: 'delete({ owner })',
  work: 'deleteIdPrefix(ownedPrefix(owner))',
  traces: 'resthr:<person>:',
} as const;

/**
 * Every table whose rows belong to a scope by one key column — what `adoptIntoOrg` moves into an
 * organization, on Sqlite and Postgres alike (InMemory moves the same things out of its maps).
 * `counted`: whether the moved rows add to the report (a second column of a table already counted does not).
 *
 * Two columns were missing from both adapters' copies of this list: `gnl_run_journal.run_id` — every
 * adopted run's `readRun` came back empty (time travel, cost, a purge's child discovery), while
 * InMemory, which reads the key, answered in full — and `gnl_threads.parent_thread_id`, which left an
 * adopted clone pointing at the root's id.
 */
export const SCOPE_TABLES: ReadonlyArray<readonly [table: string, column: string, store: 'runs' | 'memory' | 'work' | 'cache', counted: boolean]> = [
  ['gnl_run_journal', 'key', 'runs', true],
  ['gnl_run_journal', 'run_id', 'runs', false],
  ['gnl_runs', 'run_id', 'runs', true],
  ['gnl_counters', 'key', 'runs', true],
  ['gnl_threads', 'id', 'memory', true],
  ['gnl_threads', 'parent_thread_id', 'memory', false],
  ['gnl_messages', 'thread_id', 'memory', true],
  ['gnl_working_memory', 'scope_id', 'memory', true],
  ['gnl_observations', 'thread_id', 'memory', true],
  // Missed here, an adopted thread keeps its batch markers under the OLD id: a retry of an in-flight
  // batch is then unmarked and applies twice, and the stale rows sit in the global partition forever.
  ['gnl_message_batches', 'thread_id', 'memory', true],
  ['gnl_work_log', 'ns', 'work', true],
  ['gnl_work_kv', 'key', 'work', true],
  ['gnl_cache', 'key', 'cache', true],
];

// ── The planner: "delete this" → concrete steps, in order ────────────────────────────────────────

/** One concrete step of a deletion. */
export type DeleteStep =
  /** One run's own footprint (`RUN_DEPENDENTS`), its children already planned before it. `mirrors`: request-window records it executed. */
  | { kind: 'run'; runId: string; mirrors: string[] }
  /** A thread's journal state and the ownership traces pointing at it. */
  | { kind: 'thread-state'; threadId: string }
  /** A thread's observation vectors. */
  | { kind: 'thread-vectors'; threadId: string }
  /** A thread's memory-store half. */
  | { kind: 'thread-store'; threadId: string }
  /** The thread's mark and owner record — always the last step for its thread. */
  | { kind: 'thread-records'; threadId: string };

/**
 * A run and every run under it, children first. Reads the run's tool records (and its `net:` keys) to
 * find them, exactly as the purge always has; `seen` keeps a cycle, or a run reached twice, to one step.
 */
export async function planRun(journal: Journal & Partial<JournalReader>, runId: string, seen: Set<string> = new Set()): Promise<DeleteStep[]> {
  if (seen.has(runId)) return [];
  seen.add(runId);
  const steps: DeleteStep[] = [];
  const mirrors: string[] = [];
  const rr = journal.readRun;
  if (typeof rr === 'function') {
    for (const e of await rr.call(journal, runId)) {
      if (e.kind !== 'tool') continue;
      const tcid = e.key.slice(e.key.lastIndexOf(':tool:') + ':tool:'.length);
      // A request-window record this run EXECUTED (journal.ts ranBy) holds this run's output under the
      // request's family: erasing the run erases it (measured: purging a sub-agent left its output, a
      // person's data, behind). A record another run executed is that run's; cross-run and thread
      // records are shared by design and have their own erasure (deletePrefix / purgeThread).
      const v = e.value as { mirrorOf?: string; ranBy?: { runId: string; toolCallId: string } } | undefined;
      if (executedHere(v, runId, tcid)) mirrors.push(v!.mirrorOf!);
      // Both KINDS of nested run (sub-agent and workflow-as-tool) in both SHAPES: the parent-scoped id
      // they use now, and the bare legacy one still in journals written before it was scoped — a purge
      // that misses any of them leaves orphaned PII.
      for (const child of new Set(RUN_DEPENDENTS.children(runId, tcid))) {
        if (await hasTrace(journal, child)) steps.push(...(await planRun(journal, child, seen)));
      }
    }
  }
  const lk = journal.listKeys;
  if (typeof lk === 'function') {
    const kids = new Set<string>();
    for (const k of await lk.call(journal, `net:${runId}:`)) {
      const rest = k.slice(`net:${runId}:`.length);
      const cut = rest.indexOf(':');
      if (cut > 0) kids.add(`net:${runId}:${rest.slice(0, cut)}`);
    }
    for (const kid of kids) steps.push(...(await planRun(journal, kid, seen)));
  }
  steps.push({ kind: 'run', runId, mirrors });
  return steps;
}

/** What a thread deletion reaches beside the journal: the memory store holding the thread's other half, and its observation vectors. */
export interface ThreadTarget {
  journal: Journal & Partial<JournalReader>;
  memory?: Pick<MemoryStore, 'deleteThread'>;
  /** Called with `{ filter: { source, threadId } }`; a caller adds its scope (an organization's namespace, `outsideOrganizations`). */
  vectors?: Pick<VectorStore, 'delete'>;
}

/**
 * The runs on a thread that may still write — what a thread deletion refuses to pull out from under.
 *
 * In flight: the run's status is `running` (its write-ahead outcome with nothing suspended — a turn
 * that is executing, or whose worker died and nobody canceled), or one of its model steps or tool calls
 * is claimed `running` right now (the step a canceled run is still inside). A SUSPENDED run is not: it
 * writes nothing until someone answers it, and its approval goes with the thread.
 *
 * A `completed` run's claims are not read: its outcome is the run's own LAST write, so nothing of it
 * runs after it — and it is the common case (on the 1M store every run of the deleted threads), where
 * the claim listing was most of what this check cost.
 */
export async function threadRunsInFlight(journal: Journal & Partial<JournalReader>, runs: RunSummary[]): Promise<string[]> {
  const out: string[] = [];
  for (const r of runs) {
    if (r.status === 'running' || (r.status !== 'completed' && (await hasRunningClaim(journal, r.runId)))) out.push(r.runId);
  }
  return out;
}

/** The run-scoped pointer to a tool claim held under a window (`xreq:`/`xthr:`/`xrun:`) — see `hasRunningClaim`. */
export const windowClaimPointerKey = (runId: string, toolCallId: string): string => runKeys.proc(runId, `__gnl_window_claim:${toolCallId}`);

/**
 * Is any model-step or tool claim of this run `running` at this moment?
 *
 * A tool under an idempotency window claims under the WINDOW's key (`xreq:<request>:`,
 * `xthr:<thread>:`, `xrun:`), not under the run — so a run executing one used to read as idle, and the
 * erasure order deleted the person while the call ran (measured: `subjectRuns` said `inFlight: false`
 * with the tool body executing). Such a call leaves a pointer under its run before it claims
 * (`windowClaimPointerKey`); the claim it points to is read here, so the answer is the claim's own state.
 */
export async function hasRunningClaim(journal: Journal, runId: string): Promise<boolean> {
  if (typeof journal.listKeys !== 'function') return false;
  for (const k of await journal.listKeys(`${runId}:`)) {
    if (!k.includes(':proc:') && !k.includes(':tool:')) continue;
    const v = await journal.get<{ status?: unknown; claim?: unknown }>(k);
    if (v && typeof v === 'object' && v.status === 'running') return true;
    if (k.includes(':proc:__gnl_window_claim:') && v && typeof v.claim === 'string') {
      const claimed = await journal.get<{ status?: unknown }>(v.claim);
      if (claimed && typeof claimed === 'object' && claimed.status === 'running') return true;
    }
  }
  return false;
}

/**
 * The last thing an attempt of a run does: when the run was deleted while the attempt ran (its fence,
 * or its organization's purge since `baseline`), delete again what the attempt wrote into it — the same
 * plan the deletion ran — and answer true. Read AFTER the attempt's last write: that order is what
 * makes the fence close the run's own key space (erasure-fence.ts).
 */
export async function settleErasedRun(journal: Journal & Partial<JournalReader>, runId: string, baseline: ErasureBaseline | undefined): Promise<boolean> {
  if (!(await runErasedSince(journal, runId, baseline))) return false;
  if (typeof journal.deletePrefix === 'function') await executePlan({ journal }, await planRun(journal, runId));
  return true;
}

/**
 * The runs on a thread. In the root scope an organization's run never counts: a root journal lists
 * every organization's runs too (`org:<id>:…`), and acme's `t-a` is another thread than the root's.
 */
async function runsOnThread(journal: Journal, threadId: string): Promise<RunSummary[]> {
  return ((await listRunsWhere(journal, { threadId })) ?? []).filter((r) => !isOrganizationKey(r.runId));
}

/**
 * A thread deletion, as steps: its runs (children first), its journal state, its vectors, its
 * memory-store half, its records. `runs: false` is a thread MOVE's half (`purgeThreadState`): the state
 * goes, the runs stay with the id they name.
 */
export async function planThread(target: ThreadTarget, threadId: string, opts: { runs?: boolean; allowInFlight?: boolean } = {}): Promise<DeleteStep[]> {
  const steps: DeleteStep[] = [];
  if (opts.runs !== false) {
    const runs = await runsOnThread(target.journal, threadId);
    if (!opts.allowInFlight) {
      const inFlight = await threadRunsInFlight(target.journal, runs);
      if (inFlight.length > 0) throw new ThreadRunsInFlightError(threadId, inFlight);
    }
    const seen = new Set<string>();
    for (const r of runs) steps.push(...(await planRun(target.journal, r.runId, seen)));
  }
  steps.push({ kind: 'thread-state', threadId });
  if (target.vectors) steps.push({ kind: 'thread-vectors', threadId });
  if (target.memory) steps.push({ kind: 'thread-store', threadId });
  steps.push({ kind: 'thread-records', threadId });
  return steps;
}

// ── The executor ─────────────────────────────────────────────────────────────────────────────────

/**
 * Runs a plan, in its order, and returns the rows it deleted (journal records and documents).
 * `ownershipTrace`: before the plan's FIRST run goes, record whose thread it was (`purgeRun`'s option).
 * `fence: false`: write no fence for the runs (erasure-fence.ts) — retention's own sweeps, whose runs
 * have been idle for longer than the horizon after which a fence is swept anyway.
 */
export async function executePlan(
  target: ThreadTarget,
  steps: DeleteStep[],
  opts: { ownershipTrace?: string; fence?: boolean } = {},
): Promise<number> {
  const journal = target.journal;
  const del = requireDelete(journal);
  let total = 0;
  for (const step of steps) {
    switch (step.kind) {
      case 'run': {
        // FIRST, before anything of the run goes: a worker still running it reads this and stops, and
        // deletes again what it wrote in between (erasure-fence.ts). Written last, a write of the worker
        // that landed after the delete and before the fence would stay.
        if (opts.fence !== false) await fenceRun(journal, step.runId);
        if (opts.ownershipTrace === step.runId) await writeOwnershipTrace(journal, step.runId);
        // What its usage was, read while its records are still there; subtracted once they are gone.
        const usage = await usageToSubtract(journal, step.runId);
        for (const key of step.mirrors) total += await deleteExactKey(journal, key);
        // The request's own window (`xreq:<runId>:args-…`), when this run started one: every record its
        // tree deduped against. `args-` closes the prefix — run 'a' must not reach run 'a:b''s request.
        for (const prefix of RUN_DEPENDENTS.prefixes) total += await del(prefix(step.runId));
        // MEASURED, on both InMemoryJournal and SqliteStorage: `del('mem-appended:r-1')` also removed
        // `mem-appended:r-10`. These keys end where the runId ends, so a prefix delete of one is a prefix
        // delete of a neighbour's — the wfrun: boundary deleteExactKey was written for. The per-run metrics
        // rows are top-level too, and their keys carry the runId — which for an owned job or trigger run
        // is its owner's name (`job:~o~acme:ayse:…`). The aggregate counters stay.
        for (const key of RUN_DEPENDENTS.exactKeys) total += await deleteExactKey(journal, key(step.runId));
        // The run's own records LAST: they are how a second attempt finds it (its `:input` lists it on its
        // thread and its person, its keys answer `hasTrace` from its parent). Gone first, a deletion killed
        // just after left its metrics rows behind for good — measured, dependents-model.test.ts P6.
        total += await purgeOwnNamespace(journal, step.runId);
        await subtractUsage(journal, usage);
        break;
      }
      case 'thread-state':
        for (const ns of THREAD_NAMESPACES) total += await purgeThreadNamespace(journal, ns.prefix, step.threadId, ns.ownerOf);
        total += await purgeTracesTo(journal, step.threadId);
        break;
      case 'thread-vectors':
        // By thread, not by owner: one indexed while the thread was anonymous has no owner label.
        total += await target.vectors!.delete!({ filter: { source: THREAD_DEPENDENTS.vectors.source, threadId: step.threadId } });
        break;
      case 'thread-store':
        await target.memory!.deleteThread(step.threadId);
        break;
      case 'thread-records':
        // The owner record names a person, and with the thread gone it guards nothing — so it goes, and
        // it goes LAST: until here it is what keeps everyone but the owner out of what is left.
        // Exactly, not as a prefix: thread ids may contain ':', so `thread:x:owner` is a prefix of thread
        // `x:owner:y`'s record — a prefix delete of x's took y's owner, and y stood ungated.
        for (const key of THREAD_DEPENDENTS.records) total += await deleteExactKey(journal, key(step.threadId));
        break;
    }
  }
  return total;
}

/** `resthr:<resourceId>:<threadId>` before a run goes — see purgeRun's `ownershipTrace`. */
async function writeOwnershipTrace(journal: Journal, runId: string): Promise<void> {
  // BEFORE the delete: `<runId>:input` is one of the keys about to go.
  const input = await journal.get<{ resourceId?: string; threadId?: string }>(runKeys.input(runId)).catch(() => undefined);
  if (input?.resourceId && input.threadId) {
    await journal.put(ownershipTraceKey(input.resourceId, input.threadId), { at: Date.now() })
      .catch(() => {}); // best-effort: a trace that cannot be written must not block the sweep
  }
}

/**
 * The ownership traces pointing at a thread. Once its state is gone they identify nothing — and they
 * are not inert: `resthr:<resourceId>:<threadId>` names a person, so a dead pointer is a personal-data
 * record kept for no reason, which is the shape retention exists to remove.
 *
 * Measured before this existed: after `purgeThread('th-1')` the thread held zero keys and its trace was
 * still there. `sweepThreads` deletes through `purgeThread`, so every age-swept thread left one behind.
 *
 * Parsed rather than matched by suffix: a threadId can contain ':' ('tenant:7:chat'), so
 * `endsWith(':th-1')` would also hit `resthr:p:other:th-1`, whose thread is `other:th-1`. The
 * resourceId ends at the first ':' (it is escaped, `ownershipTraceKey`) and everything after it is the
 * threadId, colons and all. No `.catch`: this runs on the erasure path, where a swallowed error is a
 * silent half-deletion.
 */
async function purgeTracesTo(journal: Journal, threadId: string): Promise<number> {
  const lk = journal.listKeys;
  if (typeof lk !== 'function') return 0;
  let total = 0;
  const pre = ownershipTraceKey('', '').slice(0, -1); // 'resthr:'
  for (const key of await lk.call(journal, pre)) {
    const rest = key.slice(pre.length);
    const cut = rest.indexOf(':');
    if (cut < 0 || rest.slice(cut + 1) !== threadId) continue;
    // deleteExactKey, not del: a key is a prefix too, and `resthr:p:th-1` would take
    // `resthr:p:th-10` with it — another person's thread, erased by a name collision.
    total += await deleteExactKey(journal, key);
  }
  return total;
}
