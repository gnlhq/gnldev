// Journal: the single substrate of durability. Append-only key→value storage.
// The core uses this in-memory; the SQLite/Postgres adapters implement the same interface.

import type { Guard } from './guard.js';
import type { RunLimits, ToolSeat } from './limits.js';
import type { Processor } from './processor.js';
import { stableStringify } from './hash.js';
import { pageRunsFromArray, compareRunKey, decodeChangeCursor, encodeChangeCursor, type RunOrder } from './run-cursor.js';
import { isVersionedKey, upgradeFormat } from './format.js';
import { runRecordKey, RECORD_KEY_RE, REPLAYED_SEGMENT_RE, leafSuffix, composeRunId, RUN_KEYED_FAMILIES } from './run-id-grammar.js';
import { PROCESS_LOCAL } from './process-liveness.js';
import { withBirth } from './run-identity.js';

export type ToolJournalRecord = (
  // ToolName — carried so loop detection (checkToolLoop) can match SUCCEEDED records by
  // tool. Optional: absent from old records → checks that require a toolName match (which only run
  // WHEN limits.loopDetection IS ON) simply treat those records as "a different tool" (harmless, breaks the streak).
  //
  // `resolvedToolCallIds` — every REAL
  // AI SDK toolCallId that has been SERVED this record's output (the winner that produced it, plus any
  // later toolCallId that consumed it via the exactly-once/dedup fast paths — same-turn duplicates,
  // the documented duplicate-toolCallId pattern, or a repeat call that a custom `idempotencyKey` collapses onto the same key). In
  // 'call' mode this is always exactly `[toolCallId]` (the key IS the toolCallId, no other id can ever
  // land here). In 'args' mode it's the ONLY way to know which toolCallId(s) a record resolves when the
  // dedupe key was derived from a custom `idempotencyKey` function — that function lives in the tool
  // definition, not the journal, so reconstructState (pure, journal-only) cannot recompute it (see
  // time-travel.ts). Optional: absent from records written before this field existed → reconstructState
  // falls back to its previous (best-effort) hash-recompute matching for those.
  // `input` — the tool's RAW arguments, stored ONLY for tools that declare
  // a `compensate` hook (opt-in journal cost): the unwind needs the original args (e.g. which
  // reservation to release), and the hash alone can't reproduce them. Absent on other/older records →
  // compensateRun falls back to recovering args from the model steps' tool-call parts.
  | { status: 'succeeded'; output: unknown; argsHash?: string; toolName?: string; input?: unknown; resolvedToolCallIds?: string[] }
  // `toolName` on the NON-success statuses too. A denial is the entry an auditor
  // most needs to identify — a human refused a tool — and it used to be the one carrying the least:
  // the key holds the toolCallId, the output holds `{__denied, reason}`, and the name appeared
  // nowhere, so answering "what was refused" meant correlating with the model step. 'suspended' got
  // away with it only because its sentinel repeats the name inside the output. Stamped at the single
  // choke point (writeToolTerminal) rather than per call site, so a new terminal path cannot forget.
  // Inert for loop detection: applyToolOutcomeToChain reads toolName only for succeeded/reflected.
  | { status: 'denied'; output: unknown; toolName?: string; resolvedToolCallIds?: string[] }
  // The call was NOT executed; instead a
  // "reconsider" nudge was returned to the model as this call's tool result (see limits.ts / durable-tool.ts).
  // Terminal like 'denied' (time-travel treats it as resolved: status !== suspended/running), and the
  // nudge output must replay IDENTICALLY on resume → hence a journaled terminal record, not a transient.
  // argsHash/toolName are stamped like on 'succeeded' — seedFromHistory needs them to re-arm the chain's
  // `reflected` flag on the MATCHING chain after an internal-state loss (match-only, see limits.ts).
  | { status: 'reflected'; output: unknown; argsHash?: string; toolName?: string; resolvedToolCallIds?: string[] }
  // `attempts` — set when the question was asked over a 'failed' or stale 'running' attempt: the counter
  // of that attempt, kept so the approved resume continues it (maxRetries) and meets the crash ladder
  // (recover) instead of starting as a first call. Absent: the question came before the call ever ran.
  | { status: 'suspended'; output: unknown; toolName?: string; attempts?: number }
  // Attempts — the number of FAILED attempts made so far for this key (to enforce the
  // retry limit). Optional: absent from old records → durable-tool.ts assumes 1.
  // `sideEffect` — whether this failed call was a SIDE-EFFECT tool (its execute was
  // actually invoked and may have posted an effect). A failed side-effect ATTEMPT counts toward
  // maxToolCalls (see limits.ts recordToolOutcome/seedFromHistory); a failed read-only tool does not.
  // Stored so seedFromHistory can reconstruct the SAME count from the journal on a first-encounter scan.
  // Optional: absent from old records → treated as not-a-side-effect (harmless, the pre-C3 behavior).
  | { status: 'failed'; error: string; attempts?: number; sideEffect?: boolean; toolName?: string }
  // M4: atomic claim marker (execute in-flight). `attempts` counts how many times this key has been
  // claimed — it survives a stale-claim TAKEOVER so a crash loop ("it ran but died before writing")
  // is bounded by the same maxRetries ladder as 'failed'. Without it every takeover stamped a fresh
  // marker and the counter reset, so a wedged worker re-ran the tool once per restart, forever.
  // Optional: absent from old records → durable-tool.ts assumes 1, like 'failed'.
  // `claimTtlMs`: how long this claim stays live — the threshold its writer holds it by (the tool's
  // own, from `claimTtlMs` / `timeoutMs`). Every other reader judges the claim by it, so a reader
  // that does not know the tool (run.ts hasRunProbe) cannot call a live claim stale. Absent from old
  // records → the reader's own threshold, as before.
  | { status: 'running'; startedAt: number; attempts?: number; toolName?: string; claimTtlMs?: number }
) & {
  /**
   * Set on a delegation's success (`agent_<name>`, a network target): the call handed work to a child
   * run and did none itself. Limits count the child's calls, not the hand-over — the same work run
   * directly would show only the child's calls (limits.ts recordToolOutcome/seedFromHistory).
   */
  delegation?: true;
  /**
   * Set on a SHADOW copy written under `${runId}:tool:` for a record whose authoritative key is not
   * run-scoped — today only the `cross-run` idempotency window (`xrun:args-…`). Holds that key.
   *
   * The shadow exists because a run with nothing under its own prefix has no history: `readRun` misses
   * the step, `listRuns` cannot derive 'suspended', and Studio's approval inbox shows nothing to click
   * while the run sits waiting for a decision. It is NOT authoritative — the exactly-once read always
   * uses the real key — and nothing consults it to decide whether to execute.
   *
   * It must be invisible to a SINGLE RUN'S UNWIND. A cross-run record is shared: other runs may depend
   * on the action, which is why the record was kept out of the run's key space in the first place.
   * `compensateRun` therefore skips anything carrying this field — without that, mirroring a succeeded
   * record made one run's rollback refund a charge another run was still relying on.
   */
  mirrorOf?: string;
  /**
   * The call that EXECUTED it, on a request-window record (`runKeys.toolRequest`): which run, and which
   * of that run's calls. The record is the request's — every call under it dedups against it — but the
   * action was this one call's: that call's mirror is what its run unwinds (compensateRun), counts
   * (limits seed) and erases (purgeRun). A mirror written for a deduplicated call carries the same
   * stamp and is told apart by its own toolCallId — three calls, one execution, one unwind (measured:
   * keyed by run alone, all three mirrors were unwound).
   */
  ranBy?: { runId: string; toolCallId: string };
  /**
   * The call's idempotency key — what the tool's body, `recover()` and `lookup()` are handed, and what
   * `compensateRun` asks the provider about. Decided once, by the call's first record, and carried by
   * every record written over it (durable-tool.ts idempotencyKeyOf); never derived again. Absent from
   * records written before it was kept here.
   */
  idempotencyKey?: string;
  /**
   * Set on a result an OPERATOR declared (`declareInDoubtDone`, `gnl pending`): the call's effect was
   * in doubt and a person said it happened. Who, when, and what they noted — the declaration is the
   * record of it.
   */
  declaredBy?: { by: string; at: number; note?: string };
};

/**
 * Whether a run's tool entry is the mirror of a request-window record that THIS call executed
 * (`ranBy`). The one predicate the unwind, the limits seed and the erasure read — `suffix` is the
 * entry's key after `${runId}:tool:`, which for a mirror is the call's toolCallId.
 */
export function executedHere(record: { mirrorOf?: string; ranBy?: { runId: string; toolCallId: string } } | undefined, runId: string, suffix: string): boolean {
  return typeof record?.mirrorOf === 'string' && runKeys.isToolRequest(record.mirrorOf) &&
    record.ranBy?.runId === runId && record.ranBy.toolCallId === suffix;
}

/**
 * Every optional concurrency primitive
 * below, per first-party adapter, with its ATOMICITY MECHANISM. All three first-party adapters
 * implement all four primitives ENGINE-ATOMICALLY on their primary paths — the "single-process safe
 * fallback" bounds documented in limits.ts/budget.ts/claim() apply ONLY to custom third-party
 * journals that omit a primitive.
 *
 *   primitive     InMemory        SQLite (multi-process via WAL)     Postgres
 *   ─────────     ────────        ──────────────────────────────     ────────
 *   putIfAbsent   sync Map        INSERT ON CONFLICT DO NOTHING      INSERT ON CONFLICT DO NOTHING
 *   putIfMatch    sync Map        UPDATE WHERE value=?               UPDATE WHERE value=$
 *   incrBy        sync Map        UPSERT arithmetic                  UPSERT arithmetic
 *   claim (M4)    putIfAbsent     putIfAbsent                        putIfAbsent
 *
 * PROOF, not prose: cross-PROCESS races on SQLite run in EVERY CI (multi-process-race.test.ts — two
 * OS processes, file barrier: run-lock / tool-claim / putIfAbsent grid / putIfMatch takeover / incrBy
 * storm, all exact). The REAL Postgres twins live in integration-real.test.ts (two pools,
 * GNL_INTEGRATION=1). Multi-process COLD START is part of the proof too — two booters on the
 * same fresh SQLite file must both survive (busy_timeout-first + OR IGNORE seeding, see sqlite-storage.ts).
 *
 * SCOPE (honest bound): these guarantees hold for ANY number of workers sharing ONE journal store.
 * Independent journals (multi-region active-active) are NOT coordinated — a run lives on exactly one
 * "home" journal; geo-distribution is a ROUTING concern (per-run ownership), not a consensus feature.
 */
export interface Journal {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  /**
   * M4 (optional): atomic insert-only. Writes and returns `true` WHEN the key is ABSENT, or returns
   * `false` without touching anything if it exists. Provides exactly-once under concurrency via CAS. If undefined, `claim()` falls back to get+put.
   */
  putIfAbsent?(key: string, value: unknown): Promise<boolean>;
  /**
   * Phase 12 (optional): return keys starting with a prefix (queue/events/cache enumeration).
   * `limit` makes it a bounded PROBE: at most that many keys, WHICH ones unspecified (no ordering is
   * promised with a limit). An adapter that ignores it stays correct, only unbounded.
   */
  listKeys?(prefix: string, opts?: { limit?: number }): Promise<string[]>;
  /**
   * (optional) The records under `prefix`, in byte order of their keys, after the key `after` (before it,
   * with `desc`), at most `limit` — ONE read of an index range, not a listing of the whole prefix. What a
   * run's event log is read with (run-events.ts): a reader asks for what follows its cursor, and a run with
   * fifty thousand events is not listed fifty thousand times. A store without it is read through
   * `listKeys` + `get`.
   */
  readRange?<T = unknown>(prefix: string, opts: { after?: string; limit: number; desc?: boolean }): Promise<Array<[string, T]>>;
  /**
   * (optional) The keys of the thread OWNER RECORDS (`…thread:<id>:owner`, see `isOwnerRecordKey`) under
   * `prefix` whose record names `resourceId` — what an erasure asks instead of opening every thread's
   * record. Exact: a key is listed only when its record names this person, however the store finds it.
   * A store that keeps the owner in a column (Sqlite, Postgres: `ownerColumnOf`) reads the rows placed
   * under that person AND every row not placed yet (written before the column, or by an older process),
   * deciding those from the record itself; it never skips one. A journal without this method is asked the
   * old way: every owner record, read one by one.
   */
  listOwnerRecords?(resourceId: string, opts?: { prefix?: string }): Promise<string[]>;
  /**
   * Retention/GDPR (optional): PERMANENTLY deletes ALL keys starting with a prefix, returns the
   * number deleted. The single exception to the journal's append-only philosophy — only for lawful
   * deletion (PII purge) and retention sweeps; never used in the normal flow. A run whose records it
   * takes only some of (`<run>:tool:x`, `<run>:outcome`) then reads what its remaining records say —
   * status, counts, person and thread — and a run left with none is no run (conformance R5).
   */
  deletePrefix?(prefix: string): Promise<number>;
  /**
   * H1 (optional): atomic CONDITIONAL replace (CAS-on-existing). If the key's CURRENT value is
   * SERIALIZED-equal to `expected`, writes `value` and returns `true`; otherwise (different/changed/
   * deleted) returns `false` WITHOUT touching anything. Usage: expired run-lock TAKEOVER — even if two
   * workers read the same expired record, only ONE can replace it (split-brain becomes impossible, see run-lock.ts).
   * The comparison is over the serialized form; a false-negative (mismatch) is the SAFE side: the
   * takeover just doesn't happen this attempt, the next attempt reads the fresh record. If undefined,
   * acquireRunLock falls back to the old best-effort get→put behavior (documented risk, the core-hardening review).
   */
  putIfMatch?(key: string, expected: unknown, value: unknown): Promise<boolean>;
  /**
   * H2 (optional): the storage's OWN clock (epoch ms) — makes lock TTL decisions independent of
   * worker wall-clock skew (Postgres `now()`).
   * If undefined, Date.now is used (no difference on single-machine setups).
   */
  now?(): Promise<number>;
  /**
   * H8a (optional): field-based ATOMIC counter increment — `value = value + delta` inside the engine
   * (SQL UPSERT arithmetic). Kills two ailments of get→put at once: the
   * lost-update race (two workers read the same value and add, one gets overwritten) and the hot-row
   * read-modify-write cost. Negative delta = decrement. budget.ts uses this when supported.
   * Resolves to the new value of each field it was given — what this increment made it, so a caller can
   * take a share of a limit in one step (limits.ts takeToolSeat). The built-in adapters return it; a
   * custom one that resolves to nothing keeps working, and callers that need the value fall back.
   */
  incrBy?(key: string, fields: Record<string, number>): Promise<Record<string, number> | void>;
  /** H8a: read counter fields written via incrBy (undefined if absent). */
  getCounters?(key: string): Promise<Record<string, number> | undefined>;
  /**
   * P1.6b (optional): ATOMIC batch — claim (putIfAbsent semantics) + counter increments + plain puts as
   * ONE all-or-nothing unit (a SQL transaction). If `claim` is given and its key EXISTS, the
   * WHOLE batch is a no-op and `false` is returned; otherwise everything applies and `true` is returned.
   * Motivation (metrics.ts recordRunMetrics): with the sequential claim→incrBy path, a crash between the
   * two loses one run's counter contribution forever (documented undercount window). applyBatch closes
   * that window definitively — either the claim marker AND the increments AND the rows all land, or none
   * do. Adapters that can't provide atomicity must NOT implement this (callers fall back to the
   * sequential path rather than getting fake atomicity).
   */
  applyBatch?(batch: JournalBatch): Promise<boolean>;
  /**
   * P1.6b (optional): batch point-read — values for `keys`, ORDER-PRESERVING, `undefined` for misses
   * (SQL `WHERE key IN`). Kills the N-roundtrip pattern of reading N keys in a loop
   * (studio's /metrics/runs fast-rows). Semantically identical to `Promise.all(keys.map(get))`.
   */
  getMany?<T = unknown>(keys: string[]): Promise<(T | undefined)[]>;
  /**
   * H8b (optional): ids of runs whose last activity is OLDER than `cutoffTs` — reduces sweepRuns's
   * "fetch ALL entries of every run" O(whole-DB) scan to a single indexed query
   * (gnl_runs.updated_at). If `includeSuspended` is not given, suspended runs are NOT RETURNED (the safe side).
   */
  listStaleRuns?(cutoffTs: number, opts?: { includeSuspended?: boolean }): Promise<string[]>;
}

/**
 * P1.6b: the unit applied atomically by `Journal.applyBatch` — see its JSDoc for the contract.
 * `claim` is optional: without it the batch always applies (still atomically).
 */
export interface JournalBatch {
  /** Gate with putIfAbsent semantics: key EXISTS → the whole batch is a no-op (returns false). */
  claim?: { key: string; value: unknown };
  /** incrBy-semantics counter increments (applied only when the claim wins / is absent). */
  incrs?: Array<{ key: string; fields: Record<string, number> }>;
  /** Plain puts (applied only when the claim wins / is absent). */
  puts?: Array<{ key: string; value: unknown }>;
}

// ── Typed key schema ────────────────────────────────────────────────────
// The journal key format is a CONTRACT: parseJournalKey + the adapters + time-travel all read by it.
// Use these builders instead of hand-rolled template strings → a single source of truth, the format changes in one place.

/**
 * Both `toolByArgs` and `toolCrossRun` embed `toolName` VERBATIM into a key
 * that is later parsed by matching the LITERAL `:tool:`/`:model:` substrings (parseJournalKey) — a
 * toolName containing ':' could fabricate a fake `:tool:`/`:model:` boundary and corrupt the runId
 * parse (toolByArgs) or accidentally masquerade as run-scoped (toolCrossRun, which relies on NOT
 * containing that pattern to stay invisible — see toolCrossRun below). Guarded identically in both builders.
 */
function assertNoColonInToolName(toolName: string): void {
  if (toolName.includes(':')) {
    throw new Error(`@gnldev/durable: tool name '${toolName}' must not contain ':' — it would break the journal key schema (see runKeys.toolByArgs/toolCrossRun in journal.ts)`);
  }
}

/**
 * The runId of a sub-agent run, derived from its PARENT.
 *
 * A toolCallId is unique within one completion, NOT across runs — so the original `agent:${toolCallId}`
 * meant two unrelated parents whose provider minted the same id shared one nested run, and the second
 * read the first's answer as its own. Naming the parent removes that.
 *
 * This MUST stay a pure function of (parentRunId, toolCallId): limits.ts (`sumSubRuns`, fan-out cost
 * inheritance) and retention.ts (purge cascade) do not observe the child being created — they
 * RE-DERIVE its id from the parent's tool entries. Anything else here (an idempotencyKey, say) is
 * unreproducible there, and in the 'cross-run' window the idempotencyKey drops the runId entirely,
 * which is the very collision this exists to prevent.
 *
 * `parentRunId` is undefined only on a bare AI SDK loop with no durableTool wrapper; there the raw
 * ToolCallId is all there is and its uniqueness is the caller's to guarantee. That is also the LEGACY
 * shape, so both derivation sites check it as a fallback for journals written before this change.
 */
export function nestedAgentRunId(
  parentRunId: string | undefined,
  toolCallId: string,
  prefix: 'agent' | 'wf' = 'agent',
): string {
  return composeRunId(prefix, parentRunId, toolCallId);
}

/**
 * The runs a BACKGROUND tool call makes (types.ts `background`): its task, which executes the body, and
 * the continuation that wakes the agent with the result. Pure functions of (parentRunId, toolCallId),
 * like `nestedAgentRunId`: the erasure model re-derives them from the parent's tool records
 * (model.ts `RUN_DEPENDENTS.children`), so it never has to be told they exist.
 */
export const deferredTaskRunId = (parentRunId: string, toolCallId: string): string => composeRunId('task', parentRunId, toolCallId);
export const deferredContinuationRunId = (parentRunId: string, toolCallId: string): string => composeRunId('cont', parentRunId, toolCallId);

export const runKeys = {
  /** Run input (prompt/messages/system) — invisible to parseJournalKey. */
  input: (runId: string) => runRecordKey(runId, 'input'),
  /** LLM step record (deterministic replay). step: a number; may come as a string in fork copies. */
  model: (runId: string, step: number | string) => runRecordKey(runId, 'model', String(step)),
  /** Tool call record (exactly-once; the key is the AI SDK toolCallId). */
  tool: (runId: string, toolCallId: string) => runRecordKey(runId, 'tool', toolCallId),
  /**
   * The journal key is NOT the
   * toolCallId, but a `hash` derived from the tool arguments (or the user's `idempotencyKey`).
   * To PRESERVE the `${runId}:tool:${toolCallId}` format CONTRACT (parseJournalKey + the adapters +
   * time-travel), the dedupeId has NO ':' INSIDE it (an 'args-' prefix, joined with dashes) →
   * parseJournalKey parses it unchanged without corrupting the runId. Even if the model produces a
   * NEW toolCallId with the SAME arguments (the documented duplicate-toolCallId pattern), it still lands on the SAME key → a
   * single execution (used by durable-tool.ts).
   */
  toolByArgs: (runId: string, toolName: string, hash: string) => {
    assertNoColonInToolName(toolName);
    return runRecordKey(runId, 'tool', `args-${toolName}-${hash}`);
  },
  /**
   * Like `toolByArgs`, but WITHOUT a
   * `${runId}:` prefix — the dedup window SPANS RUNS instead of being scoped to one. Because the key
   * does NOT contain the `:tool:`/`:model:` pattern, it is INVISIBLE to `parseJournalKey` (and therefore
   * to the reader/time-travel/forkRun) — INTENTIONAL: this record isn't part of any single run's
   * timeline. `withOrg` still prefixes it like every other key (`get`/`put`/`putIfAbsent` prefix
   * UNCONDITIONALLY, no runId-shaped pattern assumed) → organization isolation is preserved
   * AUTOMATICALLY. Cleanup: since it's NOT runId-scoped, run-retention/sweep does NOT touch it —
   * purge explicitly via `journal.deletePrefix('xrun:')`.
   */
  toolCrossRun: (toolName: string, hash: string) => {
    assertNoColonInToolName(toolName);
    return `xrun:args-${toolName}-${hash}`;
  },
  /**
   * Whose a `toolCrossRun` record is: `{ resourceId? }`, first write wins, written when the record is
   * claimed. A companion rather than a field, because the record itself is rewritten whole at every
   * status change. Under `xrun:` so the same purge takes both, and not under `xrun:args-` so a
   * listing of a tool's claims does not list it.
   */
  toolCrossRunOwner: (toolName: string, hash: string) => {
    assertNoColonInToolName(toolName);
    return `xrun:owner-${toolName}-${hash}`;
  },
  /**
   * FAZ-3 `idempotencyWindow: 'thread'` — like `toolCrossRun` (invisible to parseJournalKey, mirrored
   * under the run via mirrorUnderRun, org-prefixed automatically by withOrg) but carrying the
   * threadId, which is the structural fix for xrun's immortal-key problem: `purgeThread` sweeps
   * `xthr:<threadId>:` and the thread's dedup state dies WITH the thread. The thread-scoped
   * duplicate MARKER (durable-tool's dup guard, `scope: 'thread'`) shares this prefix for the same
   * reason — one sweep reclaims both families. FAZ-6's semantic records (`sem-*`) and their
   * "Different work" tombstones (`semtomb-*`, see semantic-dup.ts) live here too: FOUR families,
   * one purgeThread sweep, one lifecycle — the thread's dedup state dies with the thread.
   */
  /**
   * The REQUEST idempotency window ('run', the default): the record a call's arguments (or business key)
   * resolve to for the whole request — the run the request started and every sub-agent under it. It
   * lives outside every run's key space, like `toolCrossRun`/`toolThread`: it is the request's, not a
   * step of whichever run happened to execute it. That run stamps `ranBy` and keeps a mirror
   * (`mirrorOf`), which is how the run's timeline, its unwind and its erasure find it.
   */
  toolRequest: (requestRunId: string, toolName: string, hash: string) => {
    assertNoColonInToolName(toolName);
    return `${runKeys.toolRequestPrefix(requestRunId)}${toolName}-${hash}`;
  },
  /** Every request-window record of one request (`toolRequest`) — `args-` closes the prefix, so run 'a'
   *  never reaches run 'a:b''s. */
  toolRequestPrefix: (requestRunId: string) => RUN_KEYED_FAMILIES['request-window'].prefix(requestRunId),
  /** Whether a key is a request-window record (`toolRequest`). */
  isToolRequest: (key: string) => key.startsWith('xreq:'),
  /** The same request-window record, in another request's window (a fork is a request of its own). */
  toolRequestIn: (key: string, requestRunId: string): string | undefined => {
    const m = /^xreq:.*:(args-[^:]*)$/.exec(key);
    return m ? `xreq:${requestRunId}:${m[1]}` : undefined;
  },
  toolThread: (threadId: string, toolName: string, hash: string) => {
    assertThreadId(threadId);
    assertNoColonInToolName(toolName);
    return `xthr:${threadId}:args-${toolName}-${hash}`;
  },
  /**
   * Which background call's continuation holds the thread's turn (deferred.ts `takeThreadTurn`): one
   * writer a background tool adds, at a time. Thread state like the families above — the thread's delete
   * takes it.
   */
  threadTurn: (threadId: string) => {
    assertThreadId(threadId);
    return `xthr:${threadId}:turn`;
  },
  /**
   * Where the LATE REPORTS of a call are kept (call-outcome.ts): beside the call's record, derived from
   * the record's key alone — so every reader of the record finds them, whichever run or call reaches it
   * (a window's record is reached by many), and the deletion that takes the record takes them.
   *  - a run's call `<runId>:tool:<suffix>` → `<runId>:proc:late-<suffix>` (under the run);
   *  - a window's record `xreq:<request>:` / `xthr:<thread>:` / `xrun:` + `args-<tool>-<hash>` → the same
   *    family with `late-` for `args-`: the request's deletion (`toolRequestLatePrefix`), the thread's
   *    and the cross-run purge each take it, and a listing of a window's `args-` records never lists it.
   */
  lateOf: (recordKey: string): string => {
    if (/^(xreq|xthr|xrun):/.test(recordKey)) {
      // A tool name holds no ':', so the LAST ':args-' (or the leading 'xrun:args-') is the family's boundary.
      const i = recordKey.lastIndexOf(':args-');
      if (i >= 0) return `${recordKey.slice(0, i)}:late-${recordKey.slice(i + ':args-'.length)}`;
    }
    const t = recordKey.lastIndexOf(':tool:');
    if (t > 0) return runKeys.proc(recordKey.slice(0, t), `late-${recordKey.slice(t + ':tool:'.length)}`);
    throw new Error(`@gnldev/durable: '${recordKey}' is not a tool call's record`);
  },
  /** The late reports of every request-window record of one request (`lateOf` of `toolRequest`). */
  toolRequestLatePrefix: (requestRunId: string) => RUN_KEYED_FAMILIES['request-window-late'].prefix(requestRunId),
  /**
   * The spec a BACKGROUND call's launcher recorded (deferred.ts `TaskSpec`), under the run that made the
   * call: its presence is what makes `<runId>`'s call `<toolCallId>` a background call, whose effect and
   * outcome are its task's (`deferredTaskRunId`), not the launcher's answer.
   */
  taskSpec: (parentRunId: string, toolCallId: string) => runRecordKey(parentRunId, 'task-spec', toolCallId),
  /** Non-deterministic processor step — invisible to parseJournalKey. */
  proc: (runId: string, name: string) => runRecordKey(runId, 'proc', name),
  /** Memory append idempotency marker — resume/retry doesn't double-write. Two-phase record (see run.ts
   *  claimMemoryAppend/markMemoryAppendDone): `{status:'pending', startedAt}` (claimed but not yet
   *  finished — taken over via self-heal if stale) → promoted to `true` (done) once the append succeeds. */
  memAppended: (runId: string) => `mem-appended:${runId}`,
  /** WRITE-AHEAD user-message append marker (see run.ts writeAheadIncoming): the run's `incoming`
   *  user message(s) are appended to memory BEFORE the first model call — a run that dies before its
   *  first token no longer leaves a titled-but-EMPTY thread (the thread row itself was already
   *  write-ahead via ensureThreadIndexed; this closes the asymmetry). Same two-phase record shape as
   *  memAppended above; the completion-time append then persists only the PRODUCED messages. */
  memUserAppended: (runId: string) => `mem-user-appended:${runId}`,
  /**
   * Memory-context provenance (`:memctx` — invisible to parseJournalKey, and the `${runId}:` purge
   * prefix covers it). Written ONCE per run next to `:input` (first attempt wins, same freeze
   * semantics): the frozen input says WHAT the model saw, this record says WHERE each part came from
   * recall hits with similarity, recent-window count, OM observations, WM injection, and the
   * echo-trim/incoming counts run.ts adds. Read by studio's GET /runs/:id/memory-context.
   */
  memoryContext: (runId: string) => runRecordKey(runId, 'memctx'),
  /** Frozen model selection (the fallback winner) — invisible to parseJournalKey, resume sticks to the same model. */
  cfgModel: (runId: string) => runRecordKey(runId, 'cfg', 'model'),
  /**
   * The run's `limits` (RunLimits — plain serializable numbers/strings/booleans) frozen at run
   * start. `limits` is a runtime RunOptions value, not part of AgentConfig, so `resumeRun`/the CLI
   * `resume` command have no source to re-supply it — a resumed run would silently lose
   * maxCost/maxTokens/loopDetection/taintedSideEffects/sideEffectDuplicates. Persisting it here lets
   * resume recover it when the caller doesn't pass `limits`. Outside the `:model:`/`:tool:` pattern →
   * invisible to parseJournalKey (like input/proc/cfgModel), doesn't affect step counting. */
  cfgLimits: (runId: string) => runRecordKey(runId, 'cfg', 'limits'),
  /**
   * AUDIT (approval first-class): the human approval decision (result of require-approval). Outside
   * the `':approval:'` pattern (model|tool) → invisible to parseJournalKey (doesn't leak into the
   * reader/time-travel, just like `input`/`proc`/`cfgModel`). run.ts writes this to the journal
   * INDEPENDENTLY of the `approvals` parameter (claim; first decision wins) → in the 'approved but
   * crashed before the tool ran' scenario, the next resume reads the decision from the journal and
   * applies it even if the `approvals` parameter isn't given.
   */
  approval: (runId: string, toolCallId: string) => runRecordKey(runId, 'approval', toolCallId),
  /**
   * How the run ENDED. Written once at each terminal boundary — 'completed' on the success path,
   * 'failed' when the run threw — and OVERWRITTEN (a plain put, not a claim) so a resume that finally
   * succeeds clears an earlier failure rather than carrying it forever.
   *
   * Suffix-anchored like `:input`, which is what keeps runIdOfKey able to claim it safely, and outside
   * the `:model:`/`:tool:` pattern → invisible to parseJournalKey, so replay and time-travel are
   * unaffected. Purged with the run by the `${runId}:` prefix.
   */
  outcome: (runId: string) => runRecordKey(runId, 'outcome'),
  /**
   * The output the run RETURNED when output processors changed it: `{ text }`, written at completion
   * by run.ts (generate and stream paths) through `recordRunOutput`, read by `runScoreSample`. The
   * journal's model records keep what the MODEL said; this keeps what the CALLER got, so every runner
   * that scores the run (an agent's `scorers`, `scoreRun`, Studio's rescore) scores that, and a
   * redactor's input never reaches a judge. Absent when no `processOutput` hook changed the text —
   * the returned text is then its last model step's. Suffix-anchored and outside the `:model:`/`:tool:`
   * pattern like `:memctx` → invisible to parseJournalKey; purged with the run by the `${runId}:` prefix.
   */
  output: (runId: string) => runRecordKey(runId, 'output'),
} as const;

/**
 * Is this write the run's outcome record, and does it say the run failed?
 *
 * Adapters index `failed` as a COLUMN rather than filtering on the serialized value, because the
 * obvious shortcut — `WHERE value LIKE '%failed%'` — matches any run whose error MESSAGE happens to
 * contain the word, which for a failure record is close to all of them.
 *
 * Returns null for every other key, so a caller can use it as "is this an outcome write at all".
 */
export function outcomeStatusOf(key: string, value: unknown): 'running' | 'failed' | 'canceled' | 'completed' | null {
  if (!key.endsWith(leafSuffix('outcome'))) return null;
  // The key suffix alone is not proof: `appendLog(journal, ns, payload, 'outcome')` writes
  // `${ns}:outcome` with a caller's payload. Only the engine's own record — whose status is exactly
  // one of the four lifecycle values — is treated as an outcome.
  const status = (value as { status?: unknown } | null)?.status;
  return status === 'failed' || status === 'completed' || status === 'running' || status === 'canceled' ? status : null;
}

/** What was recorded at a run's terminal boundary. `error` is present only on a failure. */
export interface RunOutcomeRecord {
  /**
   * 'running' is the WRITE-AHEAD half: recorded when a run STARTS, overwritten by the terminal
   * verdict when it ends. Its purpose is the crash between the two — a run SIGKILLed mid-work used
   * to read back as 'completed', because "no terminal record" and "ended fine" were the same absence.
   * A run that never said it ended now never claims it did; it stays 'running', visibly stale by its
   * `at`, until a resume finishes it or retention sweeps it.
   *
   * 'canceled' is the operator's own ending, written by `cancelAgentRun` at the moment it journals the
   * durable cancel flag. Before it, a cancel recorded NOTHING — `classifyRunError` calls
   * RunCanceledError a not-a-failure, so an in-flight run that stopped at its next model step left
   * whatever was already there, and a run canceled before it ever started read 'completed'. Deliberate
   * cancellation and success were the same answer, which is the one distinction an operator ordering a
   * cancel actually needs.
   */
  status: 'completed' | 'failed' | 'running' | 'canceled';
  at: number;
  error?: string;
}

// AUDIT (silent fallback → vocal): custom journals that don't offer `putIfAbsent` fall back to
// get→put — this is SAFE in a single process but exactly-once is NOT ATOMICALLY guaranteed under
// multiple workers (two concurrent `claim` calls can both see `get` as undefined at the same time and
// both `put`). This used to be SILENT — a user writing a custom journal would not notice this risk.
// Warn explicitly ONCE PER journal object (WeakSet — doesn't prevent GC) via `console.warn`; DOES NOT
// THROW (doesn't BREAK existing single-process custom adapter users, only makes it visible).
const claimFallbackWarned = new WeakSet<Journal>();

/**
 * Atomic claim: use `putIfAbsent` if available (CAS), otherwise get+put fallback (single-process safe).
 * Returns `true` if this call created the key.
 */
export async function claim(journal: Journal, key: string, value: unknown): Promise<boolean> {
  if (journal.putIfAbsent) return journal.putIfAbsent(key, value);
  if (!claimFallbackWarned.has(journal)) {
    claimFallbackWarned.add(journal);
    console.warn(
      '@gnldev/durable: this journal does not implement `putIfAbsent` — atomic claim fell back to get→put. ' +
        'This is safe in single-process usage; in multi-worker/distributed environments exactly-once is ' +
        'NOT guaranteed ATOMICALLY (double-claim is possible in the contention window). Implementing ' +
        '`putIfAbsent(key, value)` is recommended (see the Journal interface in journal.ts).',
    );
  }
  if ((await journal.get(key)) !== undefined) return false;
  await journal.put(key, value);
  return true;
}

/**
 * CAS-frozen memoize (general primitive): if a record exists, return it (compute NEVER runs);
 * otherwise compute and write via `claim` — the loser of the race DISCARDS its own result and reads
 * the winner's record (a single truth under multi-worker): two concurrent workers can't produce
 * different results for the same decision. `durableProcessorStep` (processor.ts) is this.
 *
 * RECORD FORMAT CONTRACT: the value is written wrapped as `{ v }` — this makes `undefined` results
 * distinguishable from "no record". This format is compatible with old records in the journal
 * (network `net:route`/`net:step` records were always written this way); DO NOT CHANGE.
 */
export async function frozenGet<T>(journal: Journal, key: string, compute: () => Promise<T>): Promise<T> {
  const hit = await journal.get<{ v: T }>(key);
  if (hit !== undefined) return hit.v;
  const v = await compute();
  if (await claim(journal, key, { v })) return v;
  const winner = await journal.get<{ v: T }>(key);
  if (winner === undefined) throw new Error(`@gnldev/durable: claim was lost but the record could not be read (${key})`);
  return winner.v;
}

/** Context of a durable run: journal, run, optional policy and approvals. */
import type { RunIdentity } from './identity-types.js';
import type { ErasureBaseline } from './erasure-fence.js';
import { refuseUnknownNames } from '@gnldev/options';
import { LIST_KEYS_NAMES, LIST_OWNER_RECORDS_NAMES, LIST_STALE_RUNS_NAMES, COUNT_RUNS_NAMES, LIST_RUNS_CHANGED_NAMES } from './option-names.js';
export interface DurableCtx {
  /** The maxToolCalls seats this run's calls hold, by toolCallId (limits.ts takeToolSeat) — so the
   *  write that counts a call can give its seat back in the same step. @internal */
  seats?: Map<string, ToolSeat>;
  /**
   * Set by callers that have NO approvals channel — `withIdempotency` runs outside runDurable, and the
   * toolCallId it names is a fresh one on every attempt, so `approvals[id] = true` could never have
   * been pre-supplied. Refusal messages use it to avoid naming a remedy the caller cannot reach.
   */
  noApprovals?: boolean;
  journal: Journal;
  runId: string;
  /**
   * REPLAY-DISCLOSURE collector (out-of-band): every pre-existing TERMINAL record consumed by this
   * run — the engine's honest ledger of "this tool result was NOT produced by this call". Populated
   * by consumeExistingRecord (the single choke point every read-and-return path goes through);
   * suspended records are excluded (an open question is not a replay). What happens with it is the
   * caller's POLICY: runDurable stamps it onto the result envelope and, only under
   * `replayDisclosure: 'explain'`, injects a TRANSIENT per-step note so the model can narrate the
   * "why" honestly. The list itself is never handed to the model — the permanent panel rule (the
   * model must not know work was done BEFORE deciding to call) stays intact: this fires strictly
   * AFTER the call was made and the engine already answered it from the journal.
   */
  replayLog?: Array<{ toolCallId: string; toolName?: string; status: string; origin: 'self' | 'window' }>;
  /**
   * (thread-scoped taint): the run's threadId, when the caller gave one (runDurable/
   * streamDurable pass it through). Pure infra on its own — durable-tool only USES it when
   * `limits.taintScope === 'thread'` (to write the thread taint key alongside the per-run mark).
   */
  threadId?: string;
  /**
   * WHO this run acts for — decided once at the run's start (run-identity.ts) and REQUIRED: a ctx
   * built without it does not compile. Tools receive it as `options.gnl.identity`; the owner records
   * this run writes (window owners, XID) are read from the same value.
   */
  identity: RunIdentity;
  /** Kanal etiketi ('chat' | 'api' | 'batch:<id>' | 'cron' ...) — XID origin verisine ve soru
   *  metinlerine girer ("5 dk önce, sohbetten"). Salt veri; karar okuyanın profilinden gelir. */
  channel?: string;
  guard?: Guard;
  /** require-approval decisions: toolCallId → whether approved (passed on resume). */
  approvals?: Record<string, boolean>;
  /**
   * Replay determinism mode (M2). 'lenient' (default): on drift, only warns, returns the recorded output.
   * 'strict': throws `DivergenceError` if tool-args drift is detected during replay.
   */
  replay?: 'strict' | 'lenient';
  /**
   * C2 (optional): replay snapshot (key→value) populated via `readRun` at the start of the run.
   * Reduces hot replay reads (model/tool) to a single SQL query → 1 round-trip instead of N on Postgres.
   * Consume-once: a key is dropped once served, the next read goes to the real journal
   * (concurrency/new writes are always read from the live journal).
   */
  replayCache?: Map<string, unknown>;
  /** W1 (opt-in): per-run cost ceiling + loop detection. If not given, no check runs. */
  limits?: RunLimits;
  /**
   * H10b (opt-in production mode): 'strict' → every tool MUST DECLARE ITS SIDE-EFFECT INTENT
   * (at least one of idempotent | sideEffect | recover). An undeclared tool is caught with a clear
   * error AT THE START of the run (not surprised mid-run) — ends the "developer forgot to mark it" class of bug.
   */
  toolPolicy?: 'strict' | 'strict-critical';
  /**
   * K1 (internal — set by runDurable/streamDurable): because the AI SDK's `executeTools` swallows
   * errors THROWN from tool.execute and converts them to 'tool-error', throwing block errors inside
   * the loop (SideEffectRetryBlocked/RetryLimit/RunBusy) PIERCES the protection: the run doesn't stop,
   * the model sees the error text and may produce a NEW toolCallId with the SAME arguments → a fresh
   * key → a duplicate side effect. While true, durable-tool returns a `__gnl_blocked` sentinel instead
   * of throwing (same mechanism as limits' `__gnl_limit_exceeded` pattern): composeStopWhen stops the
   * loop, runDurableInner converts the sentinel into a properly typed error and throws it. Behavior is
   * UNCHANGED for direct durableTool users (MCP server, manual wrapping): throw.
   */
  blockedAsSentinel?: boolean;
  /**
   * What this attempt read at its entry about its deletion (erasure-fence.ts): every later check of
   * the attempt compares against it. Set by runDurable/streamDurable. @internal
   */
  erasure?: ErasureBaseline;
  /** Y1 (opt-in): default tool execute timeout (ms) — tool.timeoutMs overrides per tool. */
  toolTimeoutMs?: number;
  /** Y3 (opt-in): default 'running' claim staleness threshold (ms) — tool.claimTtlMs overrides per tool. */
  claimTtlMs?: number;
  /**
   * AUDIT TASK (opt-in): a processor chain that runs AFTER tool execute (prompt-injection flagging,
   * redaction). Only processors defining `processToolResult` are applied in sequence; the transformed
   * output is written to the journal as 'succeeded' (see processor.ts processToolResult, durable-tool.ts).
   */
  toolResultProcessors?: Processor[];
}

/**
 * Replay-aware get: if present in the snapshot, serve it from there (consume-once), otherwise fall through to the journal.
 * Each replay key is read once on the hot path; once served it's dropped from the cache →
 * the next read (e.g. re-get after claim) always goes to the real journal.
 */
export async function ctxGet<T = unknown>(ctx: DurableCtx, key: string): Promise<T | undefined> {
  const cache = ctx.replayCache;
  if (cache && cache.has(key)) {
    const v = cache.get(key);
    cache.delete(key);
    // H13: both the replay-cache path and the journal path go through the SAME format gate (single choke point).
    return isVersionedKey(key) ? upgradeFormat(v as T, key) : (v as T);
  }
  const v = await ctx.journal.get<T>(key);
  return v !== undefined && isVersionedKey(key) ? upgradeFormat(v, key) : v;
}

/**
 * C2: load the replay snapshot at the start of a run (if the journal supports `readRun`). On the
 * first run there are no entries → returns `undefined` (no cache). On resume, fetches all model/tool entries in one query.
 */
export const REPLAY_CACHE_MAX_BYTES = 32 * 1024 * 1024; // 32MB — H8c default threshold

export async function loadReplayCache(
  journal: Journal,
  runId: string,
  opts: { maxBytes?: number } = {},
): Promise<Map<string, unknown> | undefined> {
  const rr = (journal as Partial<JournalReader>).readRun;
  if (typeof rr !== 'function') return undefined;
  // H8c RAM guardrail: if the adapter provides cheap statistics, measure the ledger before pulling it into memory.
  const stats = (journal as Partial<JournalReader>).readRunStats;
  if (typeof stats === 'function') {
    try {
      const st = await stats.call(journal, runId);
      const cap = opts.maxBytes ?? REPLAY_CACHE_MAX_BYTES;
      if (st.bytes > cap) {
        console.warn(
          `@gnldev/durable: '${runId}' journal ~${Math.round(st.bytes / 1048576)}MB > replay-cache threshold ` +
            `(${Math.round(cap / 1048576)}MB) — bulk cache is skipped (point-read replay). ` +
            `For long-lived runs, epoch handover via rolloverRun is recommended.`,
        );
        return undefined; // ctxGet falls through to the journal → same correctness, bounded memory
      }
    } catch {
      // stats failed → normal path (behavior unchanged)
    }
  }
  try {
    const entries = await rr.call(journal, runId);
    if (!entries || entries.length === 0) return undefined;
    const m = new Map<string, unknown>();
    for (const e of entries) m.set(e.key, e.value);
    return m;
  } catch {
    return undefined;
  }
}

// ── Read-API (for studio / observability) ─────────────────────────────────

export type JournalEntryKind = 'model' | 'tool';

export interface JournalEntry {
  key: string;
  runId: string;
  kind: JournalEntryKind;
  value: unknown; // model: doGenerate result · tool: ToolJournalRecord
  seq: number; // position in readRun's first-write order (0-based)
  ts?: number; // write time (created_at) — for OTEL trace timing (undefined if absent)
}

/**
 * 'failed' exists because its absence was a lie: a run killed at step 0 by a 401, or stopped by a cost
 * ceiling, was reported as 'completed' — and exportRun sent it to OTel with SpanStatusCode.OK. Nothing
 * recorded that a run had ENDED BADLY, so nothing could say so.
 *
 * Derivation order is fixed and must be identical in every adapter: 'canceled' first (see
 * DeriveRunStatus for why it outranks even 'suspended'), then 'suspended' (a run waiting on a human is
 * A LIVE state, and it is derived from tool records that outlive any outcome), then the rest of the
 * recorded outcome, then 'completed'. A run with no outcome record — every run written before this
 * existed — reads exactly as it did before.
 */
export type RunStatus = 'completed' | 'suspended' | 'failed' | 'running' | 'canceled';

export interface RunSummary {
  runId: string;
  status: RunStatus;
  modelSteps: number;
  toolCalls: number;
  /**
   * AUDIT (threadId first-class): derived from the run's invisible `:input` entry (stamped by durable
   * `persistInput`, see run.ts). Only present on runs that WERE GIVEN a threadId — if not given, the
   * field is absent entirely (falls into the ungrouped bucket). `listRuns` surfaces this within each
   * adapter's OWN read; studio (or any other consumer) must NOT do a separate N+1 `:input` read.
   */
  threadId?: string;
  /**
   * The agent's registry name — derived from the SAME invisible `:input` entry as threadId (stamped by
   * durable `persistInput`). Lets studio /runs LABEL each run with its agent with NO per-run N+1 read.
   * Absent on runs created before this field existed / runs invoked directly (no agent name given).
   */
  agent?: string;
  /**
   * WHOSE run this is — the subject, from the same invisible `:input` entry as `threadId`/`agent`
   * (stamped by durable `persistInput`). `ThreadRecord.resourceId` is a required field and the memory
   * layer keys working memory by it, so conversations already had an owner while runs did not: a
   * caller could ask for one user's threads and not their runs. Absent on runs started without one.
   */
  resourceId?: string;
  /**
   * THE CALLER'S NAME FOR THIS WORK (docs/RUNID-WORKKEY-HEYET-KARARI.md §1) — the fourth field read
   * out of the same invisible `:input` entry as threadId/agent/resourceId, and read there for the
   * same reason: it is one blob the adapter already fetches, so surfacing it costs no column, no
   * migration and no per-run N+1.
   *
   * The decision's own sentence is that the declared name stays "a first-class, queryable field",
   * BECAUSE the runId stops being readable: once an id is `run1_<32hex>`, "which run was the invoice
   * job?" has no answer on the id itself. This field is that answer, and `listRunsPaged({ workKey })`
   * is the question. Absent on every run whose caller never declared one — including, today, all of
   * them: no call path accepts a workKey until package #3.
   */
  workKey?: string;
  /**
   * The run that started this one, when it is a child (a sub-agent, a network target): from the same
   * `:input` entry. A person's run list read with `topLevel` shows their requests, not every sub-agent
   * each request started (measured on a ward round list: 56 of 68 rows were sub-agents). Absent on
   * top-level runs and on runs recorded by an earlier version.
   */
  parentRunId?: string;
  /**
   * When the run was created: epoch ms of its first record, as the writing process's clock read it
   * (`gnl_runs.created_at` on Sqlite and Postgres). With `runId` it is the key every run listing is
   * ordered and paged by, so a listing built from an array of summaries (the Studio's, the server's,
   * an organization's view) resumes after its last run exactly as a table does (run-cursor.ts). Every
   * first-party store fills it; a custom reader that leaves it out is paged by run id alone.
   */
  createdAt?: number;
}

/** One run as a change feed hands it out: its summary and when it last changed (`gnl_runs.updated_at`). */
export type RunChange = RunSummary & {
  /** Epoch ms of the run's last write, as the WRITING process's clock read it. */
  updatedAt: number;
};

/** Journal read surface (timeline / time-travel / studio). */
export interface JournalReader {
  /**
   * Every run. A run is named by any ONE of its records: a `:model:`/`:tool:` entry (`parseJournalKey`),
   * its stamped `:input` (`runIdOfKey`), or its outcome record (`outcomeStatusOf` not null) — the only
   * record of a run canceled before it started, and the first one a run writes. A journal that lists
   * runs by the first two alone never lists such a run: its status, its count and its retention go with
   * it (`@gnldev/durable/testing` R1, R3). Status: `summarizeRun(runId, readRun(runId), outcomeRecord)`.
   */
  listRuns(): Promise<RunSummary[]>;
  /**
   * ORDERING CONTRACT: records come back in the order they were FIRST written; an overwrite (a tool
   * record going `running` → `succeeded`) keeps its place. A position the store assigns as it writes —
   * not a clock: Sqlite and Postgres number each new row (`gnl_run_journal.ord`, from one counter or
   * sequence for the store), the in-memory journal keeps insertion order. Read in this order:
   * reconstructState (Studio's /state and /diff, the CLI, chat history), forkRun's prefix, rollover's
   * carried conversation, compensation's reverse unwind, the loop chain limits.ts seeds, a2a's final
   * answer. It used to be `ORDER BY created_at, key` with `created_at` in the writer's milliseconds, and
   * that is not write order (H7, measured on Sqlite and Postgres): records written in one millisecond
   * came back by key — `model:10` before `model:2`, every tool after every step, so compensation undid
   * a charge before the reservation made after it — and a worker whose clock was behind put a resumed
   * run's later steps first. Rows a store holds from before its position existed (position 0 on Sqlite
   * and Postgres) come first, in the `(created_at, key)` order they always had: same-millisecond ties
   * among them stay as ambiguous as they were. `seq` is the position in the returned array.
   */
  readRun(runId: string): Promise<JournalEntry[]>;
  /**
   * H8c (optional): CHEAP statistics for a run (COUNT + SUM(length(value)) — without transferring data).
   * loadReplayCache uses this for threshold checking: it checks the ledger's size before pulling it
   * fully into RAM; if over the threshold, the bulk cache is SKIPPED (replay falls back to
   * point-reads — same correctness, bounded memory).
   */
  readRunStats?(runId: string): Promise<{ entries: number; bytes: number }>;
  /**
   * P1.6b (optional): push-down status aggregate — `{ completed: n, suspended: m, ... }` computed by the
   * ENGINE (SQL `GROUP BY status` over the indexed gnl_runs summary), NOT by materializing every run
   * summary in the caller. Studio's /metrics uses this to get total/byStatus in O(distinct statuses)
   * instead of listRuns()'s O(all runs). Deliberately a reader capability (derived data, no write-path
   * bookkeeping → cannot drift, unlike status-transition counters would). Adapters without a cheap
   * aggregate (e.g. a pure-KV backend) simply leave it undefined — callers fall back to listRuns.
   */
  countRunsByStatus?(): Promise<Record<string, number>>;
  /**
   * (optional) How many runs there are — the same rows `listRuns()` returns, counted by the engine
   * (`SELECT COUNT(*)`), never listed. `runIdPrefix` counts only runs whose id starts with it — the
   * range an organization's view passes down (`withOrg`), read from the run id's index.
   *
   * Exists for the usage total (`getOrgUsage`): its run count was `listRuns().length`, which on the
   * 1M-run store the C+ audit measured read every run with their `:input` blobs — 17–18 s, 3.7 GB of
   * temp files — to produce one number. Unlike `countRunsByStatus` it takes the prefix, so a scoped view
   * CAN bridge it without leaking other organizations' counts; a journal written before it leaves it
   * undefined and callers count by listing, as before.
   */
  countRuns?(q?: { runIdPrefix?: string }): Promise<number>;
  /**
   * (optional) THE CHANGE FEED: runs ordered by when they last changed — `(updated_at, run_id)`
   * ascending — starting after `cursor`, or at `opts.since` (epoch ms, inclusive) when no cursor is given,
   * or at the beginning. At most `opts.limit` (default 200) per call. `nextCursor` names the last run
   * handed out (absent on an empty page); a page shorter than `limit` means the feed is caught up for
   * now — more rows can arrive later, which is why the cursor is still handed back.
   *
   * Every write to a run moves its `updated_at` (each journal entry, a tool record changing status, the
   * outcome), so a reader polling this sees step progress and status flips without reading every run.
   * What it does NOT see: a run DELETED (its row is gone). And `updated_at` is the writer's clock, set
   * inside a transaction that can commit after a reader has already passed that value — a consumer that
   * must not miss a change re-reads a fixed window behind its position (see Studio's GET /events).
   *
   * `runIdPrefix` narrows to runs whose id starts with it (an organization's range); a journal that
   * cannot filter by it may ignore it, and the scoped views check every row themselves.
   */
  listRunsChangedSince?(cursor?: string, opts?: { limit?: number; since?: number; runIdPrefix?: string }): Promise<{ items: RunChange[]; nextCursor?: string }>;
  /**
   * P0.3 a PAGINATED + FILTERED sibling of `listRuns()`
   * above. The array method stays exactly as-is (used EVERYWHERE — studio, budget.ts, toJournal's own
   * array bridge — turning it paginated would be a breaking change to every caller); this is an
   * ADDITIVE capability for consumers (server's GET /runs) that want a real page + filters instead of
   * materializing every run.
   * FILTER SEMANTICS (must match exactly, so a filtered page and an unfiltered scan never disagree):
   * `status` matches `summarizeRun`'s derivation — 'suspended' iff the run has ANY tool record with
   *     status:'suspended', else 'completed'.
   * `agent` matches the SAME `RunSummary.agent` field `listRuns()` already surfaces (from the run's
   *     invisible `:input` entry) — an exact string match.
   * Filtering MUST happen BEFORE pagination slicing (never filter-after-slice — that silently drops
   * items off a page and desyncs `nextCursor` from what the caller thinks they've seen).
   * NOTE (import-cycle avoidance): the query/page shapes below are a structural MIRROR of storage.ts's
   * `ListQuery`/`Page<T>` (same fields) rather than an import — storage.ts already imports
   * Journal/JournalReader/RunSummary FROM this file, so importing back would create a cycle. Any
   * RunJournal (storage.ts) satisfies this signature structurally via its own `listRuns(q)` — see
   * storage.ts's `toJournal()` bridge, which delegates this straight through.
   * OPTIONAL: a bare custom JournalReader that only implements the legacy array `listRuns()` simply
   * leaves this undefined — callers fall back to the array + in-memory filter/slice path.
   */
  listRunsPaged?(q?: {
    limit?: number;
    cursor?: string;
    status?: RunStatus;
    /**
     * Any of these statuses. The set of every status but 'completed' is what the approval inbox and the
     * usage total ask for, and Sqlite and Postgres answer it from the `gnl_runs_open` partial index —
     * reading those runs only. Same filter-before-slice contract as `status`; with both, both apply.
     */
    statuses?: readonly RunStatus[];
    agent?: string;
    /** WHOSE runs — matches `RunSummary.resourceId`; same filter-before-slice contract as `agent`. */
    resourceId?: string;
    /**
     * WHICH JOB — an EXACT match against `RunSummary.workKey` (never a prefix: `invoice-4` must not
     * answer for `invoice-4471`, or an operator's "show me this job" quietly becomes "show me this
     * family"). Same filter-before-slice contract as `agent`/`resourceId`.
     *
     * Not a uniqueness lookup, even though a workKey names one unit of work: the same key can appear
     * on several runs (`#<n>` reruns, or two scopes that happen to share a name), so this answers
     * with a page, like every other filter here.
     */
    workKey?: string;
    /** Only runs no other run started (`RunSummary.parentRunId` absent). Same filter-before-slice contract. */
    topLevel?: boolean;
    /** WHICH THREAD — matches `RunSummary.threadId` exactly; same filter-before-slice contract as `resourceId`. */
    threadId?: string;
    /** Runs whose id starts with this (see `ListQuery.runIdPrefix`); same filter-before-slice contract. */
    runIdPrefix?: string;
    /** `'desc'` lists newest first; default `'asc'`. See `ListQuery.order`. */
    order?: RunOrder;
  }): Promise<{ items: RunSummary[]; nextCursor?: string }>;
}

export type RunListQuery = {
  limit?: number;
  cursor?: string;
  status?: RunStatus;
  statuses?: readonly RunStatus[];
  agent?: string;
  resourceId?: string;
  workKey?: string;
  topLevel?: boolean;
  threadId?: string;
  runIdPrefix?: string;
  order?: RunOrder;
};

/**
 * Every run a journal lists for one filter (a person, a thread), walking `listRunsPaged` to its end —
 * on Sqlite and Postgres an index read of the placed rows plus the unplaced ones, elsewhere the
 * listing's own filter. `undefined` for a journal that cannot list runs by page. A failed page is
 * THROWN, never read as "no more runs": the callers are an erasure and an ownership question, and an
 * empty answer there is a person's data reported gone, or a thread reported new.
 * @internal
 */
export async function listRunsWhere(journal: Journal, q: { resourceId?: string; threadId?: string }): Promise<RunSummary[] | undefined> {
  const paged = (journal as Partial<JournalReader>).listRunsPaged;
  if (typeof paged !== 'function') return undefined;
  const out: RunSummary[] = [];
  let cursor: string | undefined;
  do {
    const page = await paged.call(journal, { ...q, limit: 200, ...(cursor ? { cursor } : {}) });
    // Kept only when the summary itself says so: a journal written to an older listing contract — one
    // that knew no `threadId` filter, a third party's — answers with every run, and taken as given that
    // made every run "on the thread" (the gate refused a stranger on a new thread; an erasure kept the
    // person's own). The filter is a speed-up the journal may offer, not the rule.
    out.push(...page.items.filter((r) => (q.resourceId === undefined || r.resourceId === q.resourceId) && (q.threadId === undefined || r.threadId === q.threadId)));
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

/**
 * A journal's runs, a page at a time, through whichever listing it has — for a pass over every run that
 * must not hold them all at once (the upgrade steps).
 * @internal
 */
export async function* runPages(journal: Journal, limit: number): AsyncGenerator<RunSummary[]> {
  const j = journal as Partial<JournalReader> & { listRuns?: (q?: { cursor?: string; limit?: number }) => Promise<unknown> };
  if (typeof j.listRunsPaged === 'function') {
    let cursor: string | undefined;
    do {
      const p = await j.listRunsPaged.call(journal, { limit, ...(cursor ? { cursor } : {}) });
      yield p.items;
      cursor = p.nextCursor;
    } while (cursor);
    return;
  }
  if (typeof j.listRuns !== 'function') return;
  let page: unknown = await j.listRuns.call(journal, { limit });
  for (;;) {
    if (Array.isArray(page)) { yield page as RunSummary[]; return; } // an array reader hands every run at once
    const p = page as { items: RunSummary[]; nextCursor?: string };
    yield p.items;
    if (!p.nextCursor) return;
    page = await j.listRuns.call(journal, { cursor: p.nextCursor, limit });
  }
}

/**
 * Read EVERY run as an array, from a view whose `listRuns` may return either shape.
 *
 * `JournalReader.listRuns()` is declared as an array, but every first-party adapter's RunJournal
 * (`storage.runs`) returns a `Page` — and `journal: new SqliteStorage(...).runs` is what the README's
 * own quickstart teaches. `toJournal()` bridges the two, but only a host that passes `storage` gets it;
 * A host that passes `journal` directly hands the raw Page shape to every array-assuming caller.
 *
 * Walking `nextCursor` matters: a single page is capped, so treating `page.items` as "all runs" quietly
 * undercounts — which for a usage/quota caller means a budget that never trips.
 */
export async function listRunsArray(
  view: { listRuns: (q?: RunListQuery) => Promise<unknown> },
): Promise<RunSummary[]> {
  const first: unknown = await view.listRuns();
  if (Array.isArray(first)) return first as RunSummary[];
  let page = first as { items?: RunSummary[]; nextCursor?: string } | undefined;
  const items: RunSummary[] = [...(page?.items ?? [])];
  let cursor = page?.nextCursor;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor); // a backend that returns a fixed cursor must not spin forever
    const next: unknown = await view.listRuns({ cursor });
    page = Array.isArray(next) ? { items: next as RunSummary[], nextCursor: undefined } : (next as { items?: RunSummary[]; nextCursor?: string });
    items.push(...(page?.items ?? []));
    cursor = page?.nextCursor;
  }
  return items;
}

/**
 * Accept a journal in EITHER shape and present the `JournalReader` contract: an array `listRuns()`
 * plus a real `listRunsPaged()`.
 *
 * This exists because the two shapes are indistinguishable by structure — a RunJournal and a bare
 * legacy JournalReader both have `listRuns` and neither has `listRunsPaged` — so the only honest test
 * is to call it and look at what comes back. Hence the per-call check rather than a guess at
 * construction. A journal that ALREADY has `listRunsPaged` (e.g. `toJournal`'s output) is returned
 * untouched.
 *
 * A Proxy rather than a spread or `Object.create`: adapters hold private state, and `this` must stay
 * bound to the original instance or a `#field` access throws.
 */
export function asReaderJournal<T extends object>(journal: T): T {
  const j = journal as unknown as { listRuns?: (q?: RunListQuery) => Promise<unknown>; listRunsPaged?: unknown };
  if (typeof j.listRuns !== 'function' || typeof j.listRunsPaged === 'function') return journal;
  return new Proxy(journal, {
    get(target, prop, receiver) {
      if (prop === 'listRuns') return () => listRunsArray(j as { listRuns: (q?: RunListQuery) => Promise<unknown> });
      if (prop === 'listRunsPaged') {
        return async (q?: RunListQuery) => {
          // A RunJournal applies the filters itself and hands back a real page; a legacy array reader
          // ignores the query, so the same semantics are applied here instead.
          const res: unknown = await j.listRuns!(q);
          return Array.isArray(res) ? pageRunsFromArray(res as RunSummary[], q) : (res as { items: RunSummary[]; nextCursor?: string });
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
    has(target, prop) {
      return prop === 'listRunsPaged' || Reflect.has(target, prop);
    },
  });
}

/** Parse a `<runId>:model:<step>` / `<runId>:tool:<toolCallId>` key (runId may contain colons). */
export function parseJournalKey(key: string): { runId: string; kind: JournalEntryKind } | null {
  const m = RECORD_KEY_RE.exec(key);
  return m ? { runId: m[1]!, kind: m[2] as JournalEntryKind } : null;
}

/**
 * A caller-supplied id is about to become a key SEGMENT — refuse the two words that would turn the
 * whole key into a run record.
 *
 * The rule lives here because `parseJournalKey` above is what makes it a rule: its regex claims any
 * key with a `:model:` or `:tool:` segment, whatever namespace it started in. So an id named 'model'
 * does not merely look odd, it renames its own keyspace:
 *
 *   mem:model:working      → { runId: 'mem',  kind: 'model' }   — a run called 'mem'
 *   xthr:model:sem-pay-x   → { runId: 'xthr', kind: 'model' }   — a run called 'xthr'
 *
 * and the next sweep purges that "run" by prefix, which is EVERY thread's memory, or EVERY thread's
 * dedup state. Measured on both: two unrelated threads plus one poisoned id, one `sweepRuns`, and
 * `listKeys('')` came back empty — `purged: ['mem']`, `purged: ['xthr']`, three entries deleted each
 * time.
 *
 * Colons in the id itself are fine and stay supported; only a SEGMENT equal to 'model' or 'tool' is
 * refused, since that is the only shape the regex above can claim.
 */
export function assertThreadId(threadId: string, what = 'thread id'): void {
  if (REPLAYED_SEGMENT_RE.test(threadId)) {
    throw new Error(
      `@gnldev/durable: ${what} '${threadId}' would collide with the journal's key schema — ` +
      `a ':'-delimited segment named 'model' or 'tool' reads as a run record (see parseJournalKey in journal.ts)`,
    );
  }
}

/**
 * Which run does this key belong to — INDEPENDENT of whether it is a replayable journal entry.
 *
 * `parseJournalKey` answers a narrower question: is this a `:model:`/`:tool:` record, the two kinds
 * ReadRun/reconstructState/time-travel replay. Every OTHER run-scoped key (`:input`, `:proc:`,
 * `:memctx`, `:cfg:`, `:approval:`) is deliberately invisible to it, so those must NEVER gain a `kind`.
 *
 * But "not a journal entry" is not the same as "not part of a run", and the adapters conflated the
 * two: they derived the run index from parseJournalKey alone, so a run that died before its first
 * model step — an upstream 401, a guard rejection, a limit tripped at step 0 — wrote only `:input`
 * and a claim marker and therefore produced NO run row at all. It was invisible to `listRuns`, to
 * `gnl runs`, and (the part that actually costs something) to `sweepRuns`: the prompt it had already
 * persisted sat outside every retention window, indefinitely.
 *
 * DELIBERATELY NARROW, and the narrowness is the safety property. This function's answer feeds the
 * run index, and sweepRuns purges an indexed run by `${runId}:` PREFIX — so a key wrongly claimed for
 * A run means DELETING a namespace that was never one.
 *
 * The key text alone cannot decide this, which cost a round to learn. `<runId>:proc:<name>` was
 * rejected early because `mem:<threadId>:messages` shares its shape. The two-segment families looked
 * unambiguous and were not: `appendLog(journal, ns, payload, id)` writes `${ns}:${id}` with a
 * CALLER-SUPPLIED id, so an audit entry logged as `id: 'input'` produced `__audit__:input` — read as a
 * run called `__audit__`, whose next retention sweep deleted the entire audit namespace. Measured, not
 * imagined; see early-failure-visibility.test.ts.
 *
 * So the record corroborates the key. A run's frozen input is a VERSIONED journal record — see
 * IsVersionedKey, which has always counted `:input` as one — and stampFormat gives every versioned
 * record a `_v`. Nothing else written under some `<x>:input` key carries it. That is a property of the
 * format rather than a guess about naming, which is what makes it safe to purge on.
 *
 * The two replayable kinds need no corroboration: `:model:`/`:tool:` are the adapters' own index
 * domain already, and `parseJournalKey` has always claimed exactly those.
 *
 * `:input` is also the one that is always there — run.ts writes it unconditionally, before the first
 * model call, for every run — so nothing is lost by refusing to guess from any other family.
 *
 * Greedy prefix, matching parseJournalKey's own convention, so a runId containing ':' resolves the
 * same way in both.
 */
export function runIdOfKey(key: string, value?: unknown): string | null {
  const withTail = RECORD_KEY_RE.exec(key);
  if (withTail) return withTail[1]!;
  const input = leafSuffix('input');
  return key.endsWith(input) && isVersionedRecord(value) ? key.slice(0, key.length - input.length) : null;
}

/**
 * WHO AND WHERE a run is, as its `:input` record says: the person (`''` when it names nobody) and the
 * thread (`null` when it has none). The one derivation behind Sqlite's and Postgres's relation columns
 * (`gnl_runs.resource_id`, `gnl_runs.thread_id`) — the same fields, read the same way, as the summary
 * `listRuns` builds from that record (a truthy string), so a column can never place a run where the
 * listing's own filter (`matchesRunFilter`) would not find it.
 */
export interface RunRelations { resourceId: string; threadId: string | null }
export function relationsOfInput(input: unknown): RunRelations {
  const v = (typeof input === 'object' && input !== null ? input : {}) as { resourceId?: unknown; threadId?: unknown };
  return {
    resourceId: typeof v.resourceId === 'string' ? v.resourceId : '',
    threadId: typeof v.threadId === 'string' && v.threadId !== '' ? v.threadId : null,
  };
}

/**
 * The relation columns a WRITE places: only a run's own `:input` record (versioned, the same proof
 * `runIdOfKey` asks for — the write that registers the run). `undefined` for every other write. An
 * adapter calls it inside the transaction that writes the record, so the row and its columns land
 * together, and the loser of a `putIfAbsent` places nothing.
 */
export function runRelationsOf(key: string, value: unknown): (RunRelations & { runId: string }) | undefined {
  // The run `runIdOfKey` registers, and only when this key IS that run's `:input`: `r9:tool:call:input`
  // is a tool record of r9, not the input of a run `r9:tool:call` (it once made Postgres list one).
  const runId = runIdOfKey(key, value);
  if (runId === null || key !== runRecordKey(runId, 'input')) return undefined;
  return { runId, ...relationsOfInput(value) };
}

/**
 * What a record is to a run: THE attribution rule, which every store's run listing, run counters, change
 * feed and retention age follow, and the conformance suite's reference reads.
 *  - `<run>:model:…` / `<run>:tool:…` (`parseJournalKey`): an entry of the run — a step, a tool call;
 *  - `<run>:input` carrying stampFormat's `_v` (`runIdOfKey`): the run's frozen input — registers it;
 *  - `<run>:outcome` holding one of the four lifecycle statuses (`outcomeStatusOf`): its outcome — the
 *    write-ahead 'running' may be a run's first record, so it registers the run too.
 * `null` for every other key: it may live under a run's prefix (`:lock`, `:proc:`, `:memctx`), but it
 * neither makes a run nor changes what one reports. A run is the set of its records; with none left it
 * is no run.
 *
 * It was spelled out by hand in each place that needed it (the SQL adapters' run-row derivation, the
 * in-memory listing and change feed, the conformance reference) — one rule, kept in step by care.
 */
export type RunRecord =
  | { runId: string; role: 'model' | 'tool' | 'input' }
  | { runId: string; role: 'outcome'; outcome: 'running' | 'failed' | 'canceled' | 'completed' };
export function runRecordOf(key: string, value: unknown): RunRecord | null {
  const p = parseJournalKey(key);
  if (p) return { runId: p.runId, role: p.kind };
  const input = runIdOfKey(key, value);
  if (input !== null) return { runId: input, role: 'input' };
  const outcome = outcomeStatusOf(key, value);
  if (outcome !== null) return { runId: key.slice(0, -leafSuffix('outcome').length), role: 'outcome', outcome };
  return null;
}

/**
 * The runs a `deletePrefix(prefix)` deletes only SOME records of: every id that, followed by `:`, is a
 * proper prefix of `prefix` (`r:tool:a` cuts into `r` — and into `r:tool`, should that be a run). A run
 * whose id starts with `prefix` loses all of its records and its row with them; these keep a row that
 * must then say what their remaining records say. Shortest first, which is also run-id order.
 * @internal — the SQL adapters' `deletePrefix`.
 */
export function runsCutBy(prefix: string): string[] {
  const out: string[] = [];
  for (let i = prefix.indexOf(':'); i !== -1 && i < prefix.length - 1; i = prefix.indexOf(':', i + 1)) out.push(prefix.slice(0, i));
  return out;
}

/**
 * The order a writer takes row locks in — journal keys, run ids, counter keys: their UTF-8 bytes, which
 * is the order of a `COLLATE "C"` index (the one Postgres's prefix ranges read) and of Sqlite's default
 * collation. Not `<`: JavaScript compares UTF-16 code units, which disagrees with byte order past U+FFFF.
 * @internal — the SQL adapters.
 */
export function compareKeys(a: string, b: string): number {
  // UTF-8 byte order is code point order. UTF-16 units agree with it except for a surrogate (a code point
  // past U+FFFF), which sorts after every unit that is not one.
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x === y) continue;
    const sx = x >= 0xd800 && x <= 0xdfff;
    const sy = y >= 0xd800 && y <= 0xdfff;
    return sx === sy ? x - y : sx ? 1 : -1;
  }
  return a.length - b.length;
}

/**
 * What journal writes change on their runs' derived rows (`gnl_runs` in Sqlite and Postgres): the
 * counters, the person and thread, the outcome and the status they decide — and, always, `updated_at`,
 * which the change feed (`listRunsChangedSince`) reads, so every write announces its run.
 */
export interface RunRowChange {
  /** Model records the writes INSERTED (an overwrite of an existing record adds none). */
  models: number;
  /** Tool records the writes inserted. */
  tools: number;
  /** Records that became suspended minus records that stopped being suspended. */
  suspendedDelta: number;
  /** The run's `:input` was written: its person and thread (`runRelationsOf`). */
  relations?: RunRelations;
  /** The run's outcome record was written: `gnl_runs.outcome` (`storedOutcomeOf`) and the status follow it. */
  outcome?: 'running' | 'failed' | 'canceled' | 'completed';
  /** The run's outcome record was DELETED: no outcome (NULL), and the status follows. */
  outcomeGone?: true;
  /** The run's `:input` was DELETED: the run is unplaced (NULL person and thread — read from the record, which is gone). */
  inputGone?: true;
}

/**
 * The run-row changes of ONE transaction, merged per run, so an adapter writes each run's row ONCE
 * per transaction (one upsert carrying counters, relations, outcome, status and `updated_at`).
 *
 * Why: a run's row is the one row every write of that run touches. Measured on Postgres (C+ step B,
 * 200 sub-agents under one parent step): the row was written 2–3 times per journal write — a lock-only
 * "no-op" update, the counter update, then the `:input` placement or the outcome flags as separate
 * statements — 34 row versions per 5-step child and 4 per child on the PARENT's row, which every child's
 * tool-call record touches. Every one of those is a new tuple and a lock on that row.
 *
 * `noteWrite` and `noteDelete` are the one derivation of what a record's change does to its run
 * (`runRecordOf`), shared by both SQL adapters and every path that changes a record (put, putIfAbsent,
 * putIfMatch, applyBatch, deletePrefix), so the paths cannot drift. Each is a DIFFERENCE, from the row
 * the change replaced or removed as read under that row's lock: added to the run's row, it commutes with
 * every other transaction's difference, so the row is a function of the records as committed whatever
 * order concurrent writers commit in. Nothing counts a run's records over again — a recount reads rows
 * it has not locked, and overwrote a concurrent writer's difference (release audit d-status, F2).
 */
export class RunRowChanges {
  private readonly byRun = new Map<string, RunRowChange>();
  /** Merge `c` into `runId`'s change; an empty `c` still marks the run (its `updated_at` advances). */
  add(runId: string, c: Partial<RunRowChange> = {}): this {
    const cur = this.byRun.get(runId) ?? { models: 0, tools: 0, suspendedDelta: 0 };
    cur.models += c.models ?? 0;
    cur.tools += c.tools ?? 0;
    cur.suspendedDelta += c.suspendedDelta ?? 0;
    if (c.relations) { cur.relations = c.relations; delete cur.inputGone; }
    if (c.inputGone) { cur.inputGone = true; delete cur.relations; }
    if (c.outcome) { cur.outcome = c.outcome; delete cur.outcomeGone; }
    if (c.outcomeGone) { cur.outcomeGone = true; delete cur.outcome; }
    this.byRun.set(runId, cur);
    return this;
  }
  /**
   * One journal write that LANDED. `prev`: the row it replaced (`undefined` = a fresh insert), its
   * `suspended`. A run-scoped record (`<run>:model:…`/`<run>:tool:…`) counts on its run; a run's
   * `:input` registers the run and places it; a run's outcome record sets its outcome (the write-ahead
   * outcome may be a brand-new run's first write — the upsert creates its row). Any other key: nothing.
   */
  noteWrite(key: string, value: unknown, prev: { suspended: boolean } | undefined): this {
    const r = runRecordOf(key, value);
    if (!r) return this;
    switch (r.role) {
      case 'model':
      case 'tool': {
        const suspended = r.role === 'tool' && (value as ToolJournalRecord | undefined)?.status === 'suspended';
        const fresh = prev === undefined;
        return this.add(r.runId, {
          models: fresh && r.role === 'model' ? 1 : 0,
          tools: fresh && r.role === 'tool' ? 1 : 0,
          suspendedDelta: (suspended ? 1 : 0) - (prev?.suspended ? 1 : 0),
        });
      }
      case 'input': return this.add(r.runId, { relations: relationsOfInput(value) });
      case 'outcome': return this.add(r.runId, { outcome: r.outcome });
    }
  }
  /**
   * One record of run `runId` that a deletion REMOVED: `key`, and whether the row held it suspended (read
   * by the DELETE itself, under the row's lock). The inverse of `noteWrite`: an entry stops counting, an
   * outcome record takes the outcome with it, an `:input` the run's person and thread. By key alone —
   * the value is gone — so the caller names the run: only a run that keeps a row (`runsCutBy`).
   */
  noteDelete(runId: string, key: string, wasSuspended: boolean): this {
    if (key === runRecordKey(runId, 'input')) return this.add(runId, { inputGone: true });
    if (key === runRecordKey(runId, 'outcome')) return this.add(runId, { outcomeGone: true });
    const p = parseJournalKey(key);
    if (p?.runId !== runId) return this;
    return this.add(runId, { models: p.kind === 'model' ? -1 : 0, tools: p.kind === 'tool' ? -1 : 0, suspendedDelta: wasSuspended ? -1 : 0 });
  }
  get size(): number { return this.byRun.size; }
  /** One run's merged change, if the transaction has one. */
  get(runId: string): RunRowChange | undefined { return this.byRun.get(runId); }
  /**
   * In run-id order: every writer takes run-row locks in this order, so two transactions that touch the
   * same runs cannot each hold one the other waits for.
   */
  entries(): [string, RunRowChange][] {
    return [...this.byRun.entries()].sort(([a], [b]) => compareKeys(a, b));
  }
}

/**
 * A thread OWNER RECORD's key — `thread:<id>:owner`, under any organization prefix. Written as the SQL
 * patterns too (Postgres `LIKE`, Sqlite `GLOB`, which unlike Sqlite's `LIKE` keeps case), and the three
 * say the same thing: the rows an adapter gives an owner column are exactly the rows its "not placed
 * yet" read looks at.
 */
export const OWNER_RECORD_LIKE = '%thread:%:owner';
export const OWNER_RECORD_GLOB = '*thread:*:owner';
export const isOwnerRecordKey = (key: string): boolean => /thread:[\s\S]*:owner$/.test(key);

/** The person an owner record names, or `undefined` for one that names nobody (staff, legacy, unknown). */
export function ownerOfRecord(value: unknown): string | undefined {
  const r = (typeof value === 'object' && value !== null ? value : {}) as { resourceId?: unknown };
  return typeof r.resourceId === 'string' && r.resourceId !== '' ? r.resourceId : undefined;
}

/**
 * The owner column a write gives a key (`gnl_run_journal.owner`):
 *  - `null` for any key that is not an owner record;
 *  - the person, for a record that names one;
 *  - `''` for a record STAFF claimed — no one, and nothing but an operator moves it;
 *  - `null` again for a record that names nobody and is not staff's (a legacy `{ at }`, an `unknown`
 *    one): `threadOwnerOf` may still upgrade it to the person a memory names, so it is not placed —
 *    every lookup reads it and decides from the record, as for a row written before the column.
 * NULL is therefore always "decide from the record", never "nobody".
 */
export function ownerColumnOf(key: string, value: unknown): string | null {
  if (!isOwnerRecordKey(key)) return null;
  const owner = ownerOfRecord(value);
  if (owner !== undefined) return owner;
  return (value as { ownerKind?: unknown } | null | undefined)?.ownerKind === 'staff' ? '' : null;
}

/** Carries stampFormat's version marker → written by the journal itself, not by a caller's payload. */
export function isVersionedRecord(value: unknown): boolean {
  return typeof value === 'object' && value !== null && '_v' in (value as Record<string, unknown>);
}

/**
 * The ONE status rule, as data: the first entry that holds names the status, and a run none of them
 * holds is 'completed'. `deriveRunStatus` reads it, and so does the SQL the Sqlite and Postgres adapters
 * write into `gnl_runs.status` (`runStatusCaseSql`) — one table, not a TypeScript copy and two SQL
 * copies, because four separate copies of `suspended ? 'suspended' : 'completed'` is exactly how a
 * third value silently became a second value in three of them.
 *
 * Canceled outranks even 'suspended', which is the one precedence call here that is not obvious.
 * 'suspended' is derived from tool records, and those outlive the cancel: a run canceled while it
 * waited on a human still has its suspended tool record, so it would keep advertising an approval
 * that can never be applied — runDurableGuarded (and resumeRun, which goes through it) calls
 * assertNotCanceled and refuses, and cancel.ts states there is deliberately no uncancel. Every other
 * status describes a run that could still move; a canceled one is terminally over.
 *
 * 'running' is the write-ahead half: a run that recorded a start and never recorded an end has NOT
 * completed — saying 'completed' there was the lie the vocabulary used to force. A journal with NO
 * outcome at all (written before outcomes existed) still reads 'completed', exactly as it always did.
 * @internal — deriveRunStatus and the SQL adapters.
 */
export const RUN_STATUS_PRECEDENCE: ReadonlyArray<{ status: Exclude<RunStatus, 'completed'>; when: 'outcome' | 'suspended' }> = [
  { status: 'canceled', when: 'outcome' },
  { status: 'suspended', when: 'suspended' },
  { status: 'failed', when: 'outcome' },
  { status: 'running', when: 'outcome' },
];

export function deriveRunStatus(suspended: boolean, outcome?: Pick<RunOutcomeRecord, 'status'> | null): RunStatus {
  for (const r of RUN_STATUS_PRECEDENCE) if (r.when === 'suspended' ? suspended : outcome?.status === r.status) return r.status;
  return 'completed';
}

/**
 * What `gnl_runs.outcome` keeps of a run's `:outcome` record: the three outcomes the status rule reads
 * ('running', 'failed', 'canceled'). A 'completed' record and no record at all are both NULL: they
 * decide the status the same way in every state (`runStatusOf(n, 'completed')` would equal
 * `runStatusOf(n, null)` for every n — run-status-columns.test.ts checks the rule), and the flags an
 * earlier version kept could not tell them apart either, so a migrated row and a row written today mean
 * the same thing by NULL.
 * @internal — the SQL adapters.
 */
export type StoredOutcome = 'running' | 'failed' | 'canceled';
/** @internal — see StoredOutcome. */
export function storedOutcomeOf(status: RunOutcomeRecord['status'] | null | undefined): StoredOutcome | null {
  return status === 'running' || status === 'failed' || status === 'canceled' ? status : null;
}

/**
 * A run's status from the two things it depends on: how many of its tool records are suspended (a
 * counter that goes up and down) and its recorded outcome. What the Sqlite and Postgres adapters store
 * in `gnl_runs.status`, written with those two in the same statement. Both inputs are kept, not the
 * status alone: a run that failed and then suspended reads 'suspended' — and once the approval is
 * resolved it must read 'failed' again, which the status alone no longer says.
 * @internal — the SQL adapters.
 */
export function runStatusOf(suspendedCount: number, outcome: StoredOutcome | null): RunStatus {
  return deriveRunStatus(suspendedCount > 0, outcome ? { status: outcome } : null);
}

/**
 * `runStatusOf` as a SQL expression, generated from RUN_STATUS_PRECEDENCE: `suspended` is a boolean SQL
 * expression (`gnl_runs.suspended_count + ? > 0`), `outcome` one that yields the stored outcome or NULL.
 * For the one write that cannot compute the status in TypeScript: an upsert whose counter is the row's
 * own, known only to the database.
 * @internal — the SQL adapters.
 */
export function runStatusCaseSql(suspended: string, outcome: string): string {
  const arms = RUN_STATUS_PRECEDENCE.map((r) => `WHEN ${r.when === 'suspended' ? `(${suspended})` : `${outcome} = '${r.status}'`} THEN '${r.status}'`);
  return `CASE ${arms.join(' ')} ELSE 'completed' END`;
}

/**
 * Derive a summary from a run's entries.
 *
 * `outcome` is optional and separate because it is NOT an entry — it lives in the invisible `:outcome`
 * key, exactly like threadId lives in `:input`. Callers that have it pass it; callers that do not get
 * the pre-outcome behaviour, which is what every already-written run needs.
 */
export function summarizeRun(
  runId: string,
  entries: JournalEntry[],
  outcome?: Pick<RunOutcomeRecord, 'status'> | null,
): RunSummary {
  let modelSteps = 0;
  let toolCalls = 0;
  let suspended = false;
  for (const e of entries) {
    if (e.kind === 'model') modelSteps++;
    else {
      toolCalls++;
      if ((e.value as ToolJournalRecord | undefined)?.status === 'suspended') suspended = true;
    }
  }
  return { runId, status: deriveRunStatus(suspended, outcome), modelSteps, toolCalls };
}

/**
 * In-memory journal for test/dev. To simulate a real crash, it's enough to keep the same instance
 * alive across two calls (in real prod, SQLite/Postgres make this durable).
 */
export class InMemoryJournal implements Journal, JournalReader {
  private store = new Map<string, unknown>();
  constructor() {
    // Only this process can reach it: `DetachedRuns` may judge every other process id dead here.
    Object.defineProperty(this, PROCESS_LOCAL, { value: true, enumerable: true });
    withBirth(this);
  }
  /** @internal — key renaming for `Storage.adoptIntoOrg`. Not part of the Journal port.
   *  `undefined` from `rename` leaves the entry where it is, which is how platform keys stay put. */
  rekey(rename: (k: string) => string | undefined): number {
    let n = 0;
    for (const k of this.keys()) {
      const to = rename(k);
      if (to === undefined || to === k) continue;
      if (this.store.has(k)) { this.store.set(to, this.store.get(k)!); this.store.delete(k); }
      // Counters live in their own map and `keys()` reports them, so a rekey that skipped them would
      // leave an organization's usage totals stranded at the root while its runs moved.
      if (this.counters.has(k)) { this.counters.set(to, this.counters.get(k)!); this.counters.delete(k); }
      if (this.times.has(k)) { this.times.set(to, this.times.get(k)!); this.times.delete(k); }
      if (this.mtimes.has(k)) { this.mtimes.set(to, this.mtimes.get(k)!); this.mtimes.delete(k); }
      n++;
    }
    return n;
  }
  /** @internal — `Storage.adoptIntoOrg`: the record keys `rename` would move onto a record this journal already holds. */
  recordCollisions(rename: (k: string) => string | undefined): string[] {
    const out: string[] = [];
    for (const k of this.store.keys()) {
      const to = rename(k);
      if (to !== undefined && to !== k && this.store.has(to)) out.push(to);
    }
    return out;
  }
  /**
   * @internal — `Storage.adoptIntoOrg`: each counter `rename` would move onto an existing counter is
   * ADDED to it and removed (`onAdoptionCollision`: a counter is a sum). Answers how many were summed.
   */
  sumCounters(rename: (k: string) => string | undefined): number {
    let n = 0;
    for (const [k, fields] of [...this.counters]) {
      const to = rename(k);
      const into = to === undefined || to === k ? undefined : this.counters.get(to);
      if (!into) continue;
      for (const [f, v] of Object.entries(fields)) into[f] = (into[f] ?? 0) + v;
      this.counters.delete(k);
      n++;
    }
    return n;
  }
  /** @internal — removes one key, for `Storage.adoptIntoOrg` (a scope fact it drops). Not part of the Journal port. */
  drop(key: string): void {
    this.store.delete(key);
    this.times.delete(key);
    this.mtimes.delete(key);
  }
  private times = new Map<string, number>(); // key → first write time (OTEL timing)
  /**
   * key → LAST write time: the in-memory twin of `gnl_runs.updated_at`, which the SQL adapters move on
   * every write to a run. A run's change time is its newest key's (`listRunsChangedSince`).
   */
  private mtimes = new Map<string, number>();

  async get<T = unknown>(key: string): Promise<T | undefined> {
    if (!this.store.has(key)) return undefined;
    return structuredClone(this.store.get(key)) as T;
  }

  async put(key: string, value: unknown): Promise<void> {
    if (!this.times.has(key)) this.times.set(key, Date.now());
    this.mtimes.set(key, Date.now());
    this.store.set(key, structuredClone(value));
  }

  // no await between has→set → structurally atomic in single-threaded JS.
  async putIfAbsent(key: string, value: unknown): Promise<boolean> {
    if (this.store.has(key)) return false;
    this.times.set(key, Date.now());
    this.mtimes.set(key, Date.now());
    this.store.set(key, structuredClone(value));
    return true;
  }

  // H1: conditional replace — comparison via stableStringify (in the same spirit as the SQL
  // adapters' serialize() string equality); NO await between get→compare→set → structurally atomic.
  async putIfMatch(key: string, expected: unknown, value: unknown): Promise<boolean> {
    if (!this.store.has(key)) return false;
    if (stableStringify(this.store.get(key)) !== stableStringify(expected)) return false;
    this.mtimes.set(key, Date.now());
    this.store.set(key, structuredClone(value));
    return true;
  }

  // H8a: structurally atomic counter in single-threaded JS.
  private counters = new Map<string, Record<string, number>>();
  async incrBy(key: string, fields: Record<string, number>): Promise<Record<string, number>> {
    const cur = this.counters.get(key) ?? {};
    const after: Record<string, number> = {};
    for (const [f, d] of Object.entries(fields)) after[f] = cur[f] = (cur[f] ?? 0) + d;
    this.counters.set(key, cur);
    return after;
  }
  async getCounters(key: string): Promise<Record<string, number> | undefined> {
    const c = this.counters.get(key);
    return c ? { ...c } : undefined;
  }

  // P1.6b: atomic batch — no await between the claim check and the writes → structurally atomic in
  // single-threaded JS (the same argument as putIfAbsent/putIfMatch above). Mirrors the SQL-transaction/
  // semantics of the real adapters: claim exists → NOTHING is applied.
  async applyBatch(batch: JournalBatch): Promise<boolean> {
    if (batch.claim) {
      if (this.store.has(batch.claim.key)) return false;
      this.times.set(batch.claim.key, Date.now());
      this.mtimes.set(batch.claim.key, Date.now());
      this.store.set(batch.claim.key, structuredClone(batch.claim.value));
    }
    for (const { key, fields } of batch.incrs ?? []) {
      const cur = this.counters.get(key) ?? {};
      for (const [f, d] of Object.entries(fields)) cur[f] = (cur[f] ?? 0) + d;
      this.counters.set(key, cur);
    }
    for (const { key, value } of batch.puts ?? []) {
      if (!this.times.has(key)) this.times.set(key, Date.now());
      this.mtimes.set(key, Date.now());
      this.store.set(key, structuredClone(value));
    }
    return true;
  }

  // P1.6b: batch point-read — order-preserving, undefined for misses (getMany contract).
  async getMany<T = unknown>(keys: string[]): Promise<(T | undefined)[]> {
    return keys.map((k) => (this.store.has(k) ? (structuredClone(this.store.get(k)) as T) : undefined));
  }

  // P1.6b: push-down status aggregate — derived per call from the same source listRuns uses (no
  // write-path bookkeeping → cannot drift; in RAM this is as cheap as it gets).
  async countRunsByStatus(): Promise<Record<string, number>> {
    const runs = await this.listRuns();
    const out: Record<string, number> = {};
    for (const r of runs) out[r.status] = (out[r.status] ?? 0) + 1;
    return out;
  }

  // H8b: in-memory last-activity scan (test/dev — already in RAM).
  async listStaleRuns(cutoffTs: number, opts?: { includeSuspended?: boolean }): Promise<string[]> {
    refuseUnknownNames('listStaleRuns', opts, LIST_STALE_RUNS_NAMES);
    const last = new Map<string, { ts: number; suspended: boolean }>();
    for (const [key, value] of this.store) {
      const p = parseJournalKey(key);
      // A run's age is the age of its NEWEST key — including the non-entry ones. A run that died
      // before its first model step has only those, and skipping them left it undateable and so
      // never swept: its persisted prompt outlived every retention window.
      const owner = runRecordOf(key, value)?.runId;
      if (!owner) continue;
      const ts = this.times.get(key) ?? 0;
      const cur = last.get(owner) ?? { ts: 0, suspended: false };
      cur.ts = Math.max(cur.ts, ts);
      if (p?.kind === 'tool' && (value as ToolJournalRecord | undefined)?.status === 'suspended') cur.suspended = true;
      last.set(owner, cur);
    }
    return [...last.entries()]
      .filter(([, v]) => v.ts < cutoffTs && (opts?.includeSuspended ? true : !v.suspended))
      .map(([runId]) => runId);
  }

  // H8c: cheap statistics (stableStringify length ~ serialized size).
  async readRunStats(runId: string): Promise<{ entries: number; bytes: number }> {
    let entries = 0;
    let bytes = 0;
    for (const [key, value] of this.store) {
      const p = parseJournalKey(key);
      if (p && p.runId === runId) {
        entries++;
        bytes += stableStringify(value).length;
      }
    }
    return { entries, bytes };
  }

  // P1.6 `keys()`/`listKeys()`/`deletePrefix()` used to only see
  // `this.store` — a key written EXCLUSIVELY via `incrBy` (the `this.counters` map, H8a) never showed
  // up here and could never be wiped by `deletePrefix`, even though `get`/`getCounters` treat it as the
  // SAME key namespace (the Journal interface doc for `deletePrefix` promises "deletes ALL keys starting
  // with a prefix" — no carve-out for counter-only keys). This surfaced as a real bug: metrics.ts's
  // `rebuildMetrics` deletes `__metrics__:*` counters before recomputing them, and without this fix the
  // stale counter survives the "wipe" and the recompute silently ADDS ON TOP of it. All three counter keys
  // are included below wherever store keys are.
  keys(): string[] {
    return [...new Set([...this.store.keys(), ...this.counters.keys()])];
  }

  /**
   * See `Journal.listOwnerRecords`. Decided from each record, in memory — there is no column to place and
   * so no row that can be "not placed yet": the record is always at hand.
   */
  async listOwnerRecords(resourceId: string, opts?: { prefix?: string }): Promise<string[]> {
    refuseUnknownNames('listOwnerRecords', opts, LIST_OWNER_RECORDS_NAMES);
    const prefix = opts?.prefix ?? '';
    const out: string[] = [];
    for (const [k, v] of this.store) if (k.startsWith(prefix) && isOwnerRecordKey(k) && ownerOfRecord(v) === resourceId) out.push(k);
    return out;
  }

  /** @internal — the `Journal` port's range read (journal.ts `readRange`); the engine is its caller. */
  async readRange<T = unknown>(prefix: string, opts: { after?: string; limit: number; desc?: boolean }): Promise<Array<[string, T]>> {
    const keys = [...this.store.keys()].filter((k) => k.startsWith(prefix) && (opts.after === undefined || (opts.desc ? k < opts.after : k > opts.after)));
    keys.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (opts.desc) keys.reverse();
    const out: Array<[string, T]> = [];
    for (const k of keys.slice(0, opts.limit)) out.push([k, (await this.get<T>(k)) as T]);
    return out;
  }

  async listKeys(prefix: string, opts?: { limit?: number }): Promise<string[]> {
    refuseUnknownNames('listKeys', opts, LIST_KEYS_NAMES);
    const limit = opts?.limit;
    if (limit === undefined) return this.keys().filter((k) => k.startsWith(prefix));
    const out: string[] = [];
    for (const src of [this.store.keys(), this.counters.keys()]) {
      for (const k of src) {
        if (out.length >= limit) return out;
        if (k.startsWith(prefix) && !out.includes(k)) out.push(k);
      }
    }
    return out;
  }

  async deletePrefix(prefix: string): Promise<number> {
    let deleted = 0;
    for (const k of [...this.store.keys()]) {
      if (k.startsWith(prefix)) {
        this.store.delete(k);
        this.times.delete(k);
        this.mtimes.delete(k);
        deleted++;
      }
    }
    for (const k of [...this.counters.keys()]) {
      if (k.startsWith(prefix)) {
        this.counters.delete(k);
        deleted++;
      }
    }
    return deleted;
  }

  async readRun(runId: string): Promise<JournalEntry[]> {
    const out: JournalEntry[] = [];
    let seq = 0;
    for (const [key, value] of this.store) {
      const p = parseJournalKey(key);
      if (p && p.runId === runId) {
        out.push({ key, runId, kind: p.kind, value: structuredClone(value), seq: seq++, ts: this.times.get(key) });
      }
    }
    return out;
  }

  async listRuns(): Promise<RunSummary[]> {
    const byRun = new Map<string, JournalEntry[]>();
    // A run's creation time: its earliest record that names it — the row the SQL stores create
    // `gnl_runs` with, and the time they keep as `created_at`.
    const created = new Map<string, number>();
    const named = (runId: string, key: string) => {
      const t = this.times.get(key) ?? 0;
      const was = created.get(runId);
      if (was === undefined || t < was) created.set(runId, t);
    };
    let seq = 0;
    for (const [key, value] of this.store) {
      const r = runRecordOf(key, value);
      if (!r) continue;
      const list = byRun.get(r.runId) ?? [];
      byRun.set(r.runId, list);
      named(r.runId, key);
      // `:input` and the outcome register the run with no entry — a run that died before its first model
      // step (only `:input` and a claim marker) must still be listed, or sweepRuns never reaches it and its
      // persisted prompt outlives every retention window. summarizeRun stays pure: its entries are the steps.
      if (r.role === 'model' || r.role === 'tool') list.push({ key, runId: r.runId, kind: r.role, value, seq: seq++ });
    }
    // AUDIT (threadId first-class): summarizeRun stays PURE (doesn't see `:input`) — we separately
    // MERGE threadId from the run's invisible `:input` entry. Map.get is O(1) — NOT N+1
    // (doesn't make a separate pass like readRun/listRuns, it's a single point-read from the store we already have).
    return [...byRun.entries()].map(([runId, entries]) => {
      // Same O(1) point-read as `:input` below — the outcome is not an entry, so summarizeRun cannot
      // see it on its own.
      const out = this.store.get(runRecordKey(runId, 'outcome')) as { status?: RunOutcomeRecord['status'] } | undefined;
      const s = summarizeRun(runId, entries, out as never);
      const inp = this.store.get(runRecordKey(runId, 'input')) as { threadId?: string; agent?: string; resourceId?: string; workKey?: string; parentRunId?: string } | undefined;
      return {
        ...s,
        ...(inp?.threadId ? { threadId: inp.threadId } : {}),
        ...(inp?.agent ? { agent: inp.agent } : {}),
        ...(inp?.resourceId ? { resourceId: inp.resourceId } : {}),
        ...(inp?.workKey ? { workKey: inp.workKey } : {}),
        ...(inp?.parentRunId ? { parentRunId: inp.parentRunId } : {}),
        createdAt: created.get(runId) ?? 0,
      };
    }).sort(compareRunKey); // the order every listing pages in, so the array and its pages agree
  }

  /**
   * P0.3 paginated + filtered sibling of `listRuns()` above — see the
   * `JournalReader.listRunsPaged` JSDoc for the filter-semantics contract. In-memory reference
   * implementation: derive the full array (already O(store size), same cost `listRuns()` pays), then
   * page it with the cursor every run listing hands out (run-cursor.ts), so a cursor produced by one
   * path is read by the others.
   */
  async listRunsPaged(q?: RunListQuery): Promise<{ items: RunSummary[]; nextCursor?: string }> {
    return pageRunsFromArray(await this.listRuns(), q);
  }

  /** See `JournalReader.countRuns` — the runs `listRuns()` derives, counted in memory. */
  async countRuns(q?: { runIdPrefix?: string }): Promise<number> {
    refuseUnknownNames('countRuns', q, COUNT_RUNS_NAMES);
    const prefix = q?.runIdPrefix;
    return (await this.listRuns()).filter((r) => prefix === undefined || r.runId.startsWith(prefix)).length;
  }

  /**
   * See `JournalReader.listRunsChangedSince`. A run's change time is the newest last-write time of any
   * key that belongs to it — the same keys `listRuns` attributes to it — so every write that moves
   * `gnl_runs.updated_at` in the SQL adapters moves it here too.
   */
  async listRunsChangedSince(cursor?: string, opts?: { limit?: number; since?: number; runIdPrefix?: string }): Promise<{ items: RunChange[]; nextCursor?: string }> {
    refuseUnknownNames('listRunsChangedSince', opts, LIST_RUNS_CHANGED_NAMES);
    const pos = decodeChangeCursor(cursor);
    const limit = opts?.limit ?? 200;
    const at = new Map<string, number>();
    for (const [key, value] of this.store) {
      const runId = runRecordOf(key, value)?.runId;
      if (!runId) continue;
      at.set(runId, Math.max(at.get(runId) ?? 0, this.mtimes.get(key) ?? this.times.get(key) ?? 0));
    }
    const all = (await this.listRuns())
      .filter((r) => opts?.runIdPrefix === undefined || r.runId.startsWith(opts.runIdPrefix))
      .map((r) => ({ ...r, updatedAt: at.get(r.runId) ?? 0 }))
      .filter((r) => (pos ? r.updatedAt > pos.at || (r.updatedAt === pos.at && r.runId > pos.runId) : opts?.since === undefined || r.updatedAt >= opts.since))
      .sort((a, b) => a.updatedAt - b.updatedAt || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
    const items = all.slice(0, limit);
    const last = items[items.length - 1];
    return { items, ...(last ? { nextCursor: encodeChangeCursor({ at: last.updatedAt, runId: last.runId }) } : {}) };
  }
}
