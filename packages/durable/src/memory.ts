import type { Journal } from './journal.js';
import { assertThreadId } from './journal.js';
import { serialize, deserialize } from './serialize.js';

// Conversation (thread) + working memory. Journal-backed → durable & replayable by construction.
// (Rich memory like semantic recall / observational memory lives in a separate @gnldev/memory package in the future.)

/**
 * One recalled message, as provenance: WHERE it came from and WHY it was selected. `score` is present
 * only on actual similarity hits — a `messageRange` context neighbor rides along unscored. `preview`
 * is a truncated text sample (the full message is already visible in the thread itself); keeping it
 * short keeps the `:memctx` journal record small.
 */
export interface RecalledMessageRef {
  threadId: string;
  seq: number;
  role: string;
  preview: string;
  score?: number;
  /**
   * Present as `'repair'` when this row was pulled in to answer a recalled `tool-call`, rather than
   * chosen by similarity. Absent on ordinary selections.
   *
   * `score`'s absence could not carry this meaning: on this type it already means "a `messageRange`
   * context neighbor", and one field cannot mean two things. Without the distinction a repair row
   * renders in the inspector as an ordinary recall hit, which is what it looked like before this
   * existed.
   */
  origin?: 'repair';
  /** Why a `dropped` ref was left out. Absent on rows that were injected. */
  reason?: 'unanswered-tool-call' | 'duplicate-tool-call-id';
}

/**
 * "What did memory inject into this turn's context, and why" — assembled by the rich memory's
 * loadContext (recall/OM/WM breakdown) and journaled per run by runDurable/streamDurable under
 * `runKeys.memoryContext` (run.ts). This is the read-model for memory debugging: the frozen `:input`
 * says WHAT the model saw; this record says WHERE each part came from. Every field is a count or a
 * short ref — never full message bodies.
 */
export interface MemoryContextProvenance {
  /** Semantic-recall selections (hits scored, neighbors unscored). Empty when recall didn't run. */
  recalled: RecalledMessageRef[];
  /** Messages injected from the recent window (or OM's unobserved tail). */
  recentCount: number;
  /**
   * The recent-window messages THEMSELVES, as refs (capped at PROVENANCE_RECENT_CAP — `recentCount`
   * stays the true count). This is the "WHAT went to the model" half the counts alone couldn't
   * answer; absent on records written before the field existed (readers fall back to the count).
   */
  recent?: RecalledMessageRef[];
  /**
   * Selections recall made that were NOT injected, and why. A recalled message carrying a `tool-call`
   * whose `tool-result` cannot be produced is left out, because a prompt the provider refuses is worth
   * less than a lost memory — but leaving it out silently is indistinguishable from recall finding
   * nothing, and the difference matters to anyone asking why the model forgot something.
   *
   * DELIBERATELY NOT part of `recalled`. That list is consumed as "what was provably injected" — the
   * memory-off regression replay subtracts it from the prompt — so listing a message there that never
   * reached the model would have it subtract something that was never added.
   *
   * `droppedCount` is the true count; `dropped` is capped like `recent` for the same reason.
   */
  droppedCount?: number;
  dropped?: RecalledMessageRef[];
  /** OM path only: number of non-condensed observations injected as a system message. */
  observationCount?: number;
  /** Length of the working-memory system injection (absent = no WM text was injected). */
  workingMemoryChars?: number;
}

/** Ref cap for `provenance.recent` — keeps the ':memctx' record small on long windows. */
export const PROVENANCE_RECENT_CAP = 24;

/**
 * Short human preview of ANY message — the single source both provenance ref builders use (run.ts
 * legacy path + @gnldev/memory's AgentMemory.toRef; one source so the two can't drift). Plain text
 * parts win; a message whose content is STRUCTURAL (tool-call / tool-result — the "—" rows in the
 * first provenance UI) gets a structural preview instead of an empty string:
 *   `→ searchResource({"resource":"films"…})`  (assistant tool-call)
 *   `searchResource → {"hits":[…]}`            (tool result)
 */
export function messagePreview(message: any, max = 120): string {
  const clip = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, max);
  const c = message?.content;
  if (typeof c === 'string') return clip(c);
  if (!Array.isArray(c)) return '';
  const short = (v: unknown) => {
    const s = typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })();
    return s ?? '';
  };
  const parts: string[] = [];
  for (const p of c) {
    if (typeof p?.text === 'string' && p.text) parts.push(p.text);
    else if (p?.type === 'tool-call') parts.push(`→ ${p.toolName ?? 'tool'}(${short(p.input ?? p.args)})`);
    else if (p?.type === 'tool-result') parts.push(`${p.toolName ?? 'tool'} → ${short(p.output ?? p.result)}`);
  }
  return clip(parts.join(' '));
}

export interface Memory {
  /**
   * A thread's prior messages (AI SDK ModelMessage[]). If `opts.query` is given, semantic memory
   * implementations may recall relevant (old but similar) messages; simple memory ignores the query.
   * `resourceId`/`scope` (Phase 14): for resource-scope recall (a user's entire threads); simple memory ignores this.
   */
  getMessages(threadId: string, opts?: { query?: string; resourceId?: string; scope?: 'thread' | 'resource' }): Promise<any[]>;
  /** Append new messages to a thread. */
  append(threadId: string, messages: any[]): Promise<void>;
  /**
   * Append AT MOST ONCE under `batchKey`; false means that key already landed and nothing was written.
   *
   * OPTIONAL, and where it is absent run.ts keeps its own two-phase marker — which is weaker in a way
   * worth naming: that marker is written after the append returns, so a process that dies in between
   * leaves it unset and the retry writes the whole turn again, same `toolCallId` and all. Measured
   * through the full run path: 25 rows became 50. An implementation that can write the identity in
   * the same transaction as the rows removes the window instead of narrowing it.
   */
  appendOnce?(threadId: string, messages: any[], batchKey: string): Promise<boolean>;
  /** Persistent free-text working memory (optional). */
  getWorkingMemory?(threadId: string): Promise<string | undefined>;
  setWorkingMemory?(threadId: string, value: string): Promise<void>;
  /** The resource (user) id a thread belongs to (optional; enables rich memory). */
  getThreadResource?(threadId: string): Promise<string | undefined>;
  /**
   * ONE resource's threads (optional).
   *
   * Takes an OBJECT, and that detail is the whole reason this is declared here. @gnldev/studio wrote
   * its own structural type for the same method as `listThreads(resourceId?: string)` and called it
   * with a bare string. AgentMemory reads `opts.resourceId`, so the argument arrived as `undefined`
   * and the store was asked for EVERY thread — measured: filtering to one user returned both users'
   * threads, silently. Nothing caught it, because a host that declares its own shape for someone
   * else's method has no one to disagree with.
   *
   * OPTIONAL like the two above: a custom `Memory` may be a thin adapter over a store with no listing
   * at all, and requiring it would break every implementation that exists. Callers that find it absent
   * answer "no conversations" rather than failing.
   */
  listThreads?(opts: { resourceId: string }): Promise<unknown[]>;
  /** EVERY thread, unfiltered — the operator/global view (optional; see `listThreads`). */
  listAllThreads?(): Promise<unknown[]>;
  /**
   * Rename a thread or change its metadata (optional). A consumer that finds it absent answers
   * "not supported" (Studio: 501).
   *
   * The thread-management methods below are declared HERE, beside `listThreads`, for the reason
   * `listThreads` is: @gnldev/studio used to keep its own copy of their shapes, and its copy said
   * `truncateMessages` where @gnldev/memory's AgentMemory says `truncateMessagesAfter`. Every
   * AgentMemory handed to Studio answered 501 on "delete messages after", and nothing could notice,
   * because each side was only checked against itself. Studio's memory type is now picked from this
   * interface and AgentMemory `implements` it, so the two cannot disagree without a compile error.
   */
  updateThread?(threadId: string, patch: { title?: string; metadata?: Record<string, unknown> }): Promise<unknown>;
  /**
   * Delete a thread WITH ITS RUNS (optional): its messages, observations, thread-scoped working memory,
   * observation vectors, journal state and owner record, and every run on it (`purgeThread`, model.ts).
   * Refuses while a run on the thread is in flight (`ThreadRunsInFlightError`) unless `allowInFlight`.
   */
  deleteThread?(threadId: string, opts?: { allowInFlight?: boolean }): Promise<void>;
  /**
   * Truncate a thread AFTER `afterIndex` (optional): the message AT `afterIndex` is kept, every message
   * after it is deleted. `afterIndex` indexes the array `getMessages(threadId)` (no `opts`) returns.
   * `-1` deletes every message; any other index outside that array removes nothing and returns `0`.
   * Returns the number of messages deleted, or `null` when the store under the memory cannot delete
   * messages at all — distinct from `0`, so a caller can answer "not supported" instead of "nothing to do".
   */
  truncateMessagesAfter?(threadId: string, afterIndex: number): Promise<number | null>;
  /**
   * Rich path (optional — provided by @gnldev/memory's AgentMemory): composes recall + working memory +
   * observational memory + the WM tool in ONE call. If defined, runDurable/streamDurable use this
   * instead of `getMessages`/`getWorkingMemory`. `provenance` (optional, additive) is the memory-side
   * half of the `:memctx` record — see MemoryContextProvenance above.
   */
  loadContext?(
    threadId: string,
    opts: { query?: string; resourceId?: string; incoming?: any[] },
  ): Promise<{ messages?: any[]; system?: string; tools?: Record<string, any>; provenance?: MemoryContextProvenance }>;
}

/**
 * Memory on top of the journal: messages are stored in the journal → durable via SqliteStorage, crash-resistant.
 * Give it the SAME journal as the run; this way memory is also part of durable state.
 */
/**
 * The thread id becomes a journal key segment (`mem:<threadId>:messages`), and the journal's key
 * schema gives `:model:` / `:tool:` structural meaning: `parseJournalKey` reads `<x>:model:<y>` as a
 * run named `<x>`. So a thread literally NAMED 'model' produces `mem:model:messages`, which the run
 * index reads as a run called 'mem' — and the next retention sweep deletes the ENTIRE `mem:` keyspace,
 * every thread of every user. Audit-measured: an unrelated user's messages went 1 → 0. A ':' inside
 * the id opens the same door one level deeper (`mem:x:model:5`). threadId is caller-supplied on the
 * Chat surfaces, so this is enforced here, at the single place the key is built — the same boundary
 * discipline orgId (organization.ts) and toolName (journal.ts) already get.
 */
/**
 * The leaves a `mem:` key can end in — the ONE list, exported so retention reads the same answer
 * instead of keeping its own copy.
 *
 * Retention recovers a threadId out of `mem:<threadId>:<leaf>` by matching a known leaf, because a
 * threadId may itself contain ':'. With a second hand-written copy of this list, adding a leaf here
 * and forgetting there does not fail loudly: the thread simply stops being recognised as existing,
 * and the orphan report then names a LIVE thread — with its memory sitting right there — as state
 * whose run is gone. Measured before this was shared: a thread holding `mem:th:summary` beside its
 * dedup state was reported orphaned, with `unrecognisedKeys` empty, so nothing on the report hinted
 * that a key had been skipped.
 */
export const MEM_LEAVES = ['messages', 'working'] as const;
export type MemLeaf = (typeof MEM_LEAVES)[number];

/**
 * Observational memory's journal records for a thread (`@gnldev/memory`): `om:<threadId>:<leaf>` for
 * its counters, and `om:<threadId>:proc:<step>` for the memoized observer, reflector and embedding
 * steps — those hold the model's summary of the conversation. Listed here, beside `MEM_LEAVES`, so
 * `purgeThread` erases them with the thread; `@gnldev/memory` builds its keys from this list.
 */
export const OM_LEAVES = ['observedSeq', 'observeSeq', 'reflectSeq'] as const;
export type OmLeaf = (typeof OM_LEAVES)[number];

/**
 * SemanticMemory's (`@gnldev/rag`) journal log for a thread: `sem:<threadId>:log`. Built here, beside
 * `MEM_LEAVES` and `OM_LEAVES`, so the code that erases and sweeps a thread reads the same key the
 * memory writes — rag's SemanticMemory builds its key with this function. The thread id is checked the
 * way `memKey` checks it: `sem:model:log` would parse as a run called 'sem'.
 */
export const SEMANTIC_LOG_PREFIX = 'sem:';
export const SEMANTIC_LOG_SUFFIX = ':log';
export function semanticLogKey(threadId: string): string {
  assertThreadId(threadId);
  return `${SEMANTIC_LOG_PREFIX}${threadId}${SEMANTIC_LOG_SUFFIX}`;
}

/**
 * The `metadata.source` of an observational-memory vector (`@gnldev/memory`, `omVectors.store`). A
 * thread's observations go with the thread, whoever they were labelled for: one indexed while the
 * thread was anonymous carries no owner, and the person who later claimed the thread is still erased
 * with it. `eraseSubject` deletes by `{ source, threadId }`, so a document that merely mentions a
 * thread id in its metadata is not taken.
 */
export const OM_VECTOR_SOURCE = 'observational-memory';

export function memKey(threadId: string, leaf: MemLeaf): string {
  // The rule itself lives beside parseJournalKey, which is what makes it a rule — and it is shared,
  // because this was NOT the only door. `mem:` was guarded here while `xthr:` was not, so a
  // deployment using threadId purely for idempotency (no BasicMemory, so this function never runs)
  // reached the same collision through the dedup keyspace. Measured: one poisoned id wiped every
  // thread's dedup state exactly as it wipes every thread's memory.
  //
  // Exported so a store that builds this key itself can build the SAME key — @gnldev/rag's
  // SemanticMemory wrote `mem:${threadId}:working` by hand, which is how it bypassed the check.
  assertThreadId(threadId);
  return `mem:${threadId}:${leaf}`;
}

/** Per journal object, per key: the tail of the in-process queue of appends. See `appendToJournalLog`. */
const logQueues = new WeakMap<object, Map<string, Promise<void>>>();

/**
 * How a journal log is stored: a list of parts, each one append's entries ALREADY serialised.
 *
 * Why strings: the cross-process half of `appendToJournalLog` is a compare-and-set, and a journal's
 * compare is "is the stored value the serialised form of `expected`?". With the entries stored as
 * values, `expected` was the log as READ — deserialised — and serialising it again had to produce the
 * stored bytes exactly. superjson does not promise that: an `Error` comes back with `cause:
 * undefined` the second time. The compare then lost on every round, the loop never yielded, and the
 * process froze (measured: `timeout 40` exit 124 on SQLite). Strings and numbers survive every
 * adapter's round trip unchanged, so the compare now holds by construction, whatever a message holds.
 *
 * It is also the cheaper shape: an append no longer rebuilds every earlier message as objects just
 * to write them back — the earlier parts pass through as strings, and only a read decodes them.
 *
 * `gnlLog` marks the shape (a 0.9.0 log is a bare array, read as one part — see `readJournalLog`).
 *
 * `appendedAt[i]` is when part `i` was appended (epoch ms; `null` for a part written before this field —
 * a 0.9.0 log, or an earlier 0.10 append). It is what dates a message that carries no timestamp of its
 * own — every message an agent turn stores (the AI SDK message has no time field), so without it the
 * thread sweep could never age a real conversation (`sweepThreads`, `keptNoTs`).
 */
interface JournalLogValue { gnlLog: 1; parts: string[]; appendedAt?: Array<number | null> }

function isLogValue(v: unknown): v is JournalLogValue {
  return typeof v === 'object' && v !== null && (v as JournalLogValue).gnlLog === 1 && Array.isArray((v as JournalLogValue).parts);
}

/**
 * A compare that cannot succeed. A lost compare normally means another writer's append landed, and the
 * retry then sees a longer log — that is progress, and it is never bounded: any number of concurrent
 * writers all finish. This error is for the other case, a compare that loses while the log stays exactly
 * as read: nobody else wrote, so the store's `putIfMatch` does not match the value its own `get` just
 * returned (a custom adapter comparing by reference, say). Retrying cannot help there.
 */
export class JournalLogContentionError extends Error {
  constructor(readonly key: string, readonly attempts: number) {
    super(
      `@gnldev/durable: the append to '${key}' was not written: the journal's putIfMatch refused the value its get had just ` +
      `returned ${attempts} times, while no other writer changed it. putIfMatch must compare the stored value's ` +
      'serialized form, not object identity (see the parity matrix in journal.ts). Nothing was lost. If only one process ' +
      'writes this journal, give the memory the journal without its compare — ' +
      '`new BasicMemory({ get: (k) => journal.get(k), put: (k, v) => journal.put(k, v) })` — and the in-process queue orders the appends.',
    );
    this.name = 'JournalLogContentionError';
  }
}

/**
 * How many lost compares IN A ROW, with the log unchanged in between, end an append with
 * `JournalLogContentionError`. Not a bound on writers: a round lost to another writer's append changes
 * the log and resets the count, so 500 concurrent writers all finish.
 */
export const JOURNAL_LOG_MAX_ATTEMPTS = 8;

/**
 * Reads a log written by `appendToJournalLog`, in append order. Also reads a 0.9.0 log (a bare array).
 * Every reader of such a key goes through here — memory classes and the thread sweep alike — so the
 * stored shape is known in one place.
 */
export async function readJournalLog<T = unknown>(journal: Pick<Journal, 'get'>, key: string): Promise<T[]> {
  return decodeLog<T>(await journal.get<unknown>(key));
}

/** Like `readJournalLog`, each entry with the time its append was written, when the log recorded one. */
export async function readJournalLogDated<T = unknown>(journal: Pick<Journal, 'get'>, key: string): Promise<Array<{ entry: T; appendedAt?: number }>> {
  const stored = await journal.get<unknown>(key);
  if (!isLogValue(stored)) return decodeLog<T>(stored).map((entry) => ({ entry }));
  const out: Array<{ entry: T; appendedAt?: number }> = [];
  stored.parts.forEach((part, i) => {
    const at = stored.appendedAt?.[i];
    for (const entry of deserialize<T[]>(part)) out.push(typeof at === 'number' && Number.isFinite(at) ? { entry, appendedAt: at } : { entry });
  });
  return out;
}

function decodeLog<T>(stored: unknown): T[] {
  if (stored === undefined || stored === null) return [];
  if (Array.isArray(stored)) return stored as T[]; // 0.9.0: the entries themselves
  if (!isLogValue(stored)) return [];
  const out: T[] = [];
  for (const part of stored.parts) out.push(...deserialize<T[]>(part));
  return out;
}

/**
 * Appends `entries` to the log stored at `key`, losing nothing to a concurrent append, and always
 * finishing: it either writes or throws.
 *
 * A journal holds a thread's log as ONE value, so an append is read → extend → write, and two
 * appends that both read before either writes erase one of them. Measured: 10 concurrent appends to
 * one thread kept 1; two processes × 50 kept 2 of 100. The guarantee is built from what a `Journal`
 * offers:
 *
 *   - an in-process queue per journal and key, so appends from one process never contend at all;
 *   - a compare-and-set write — `putIfAbsent` for the first entry, `putIfMatch` after — retried on a
 *     lost race with the fresh value, so a second PROCESS cannot erase a write either. The compared
 *     value is strings only (see `JournalLogValue`), so a lost compare means another writer won and the
 *     retry reads a longer log; retries back off with jitter and are not counted. Only compares lost
 *     while the log stayed as read are counted, and `JOURNAL_LOG_MAX_ATTEMPTS` of those in a row end
 *     in `JournalLogContentionError` (a store whose compare cannot match).
 *
 * A journal without `putIfMatch`/`putIfAbsent` gets the queue alone: safe within one process, not
 * across several. Every first-party journal implements both.
 */
export async function appendToJournalLog(journal: Journal, key: string, entries: readonly unknown[]): Promise<void> {
  let queues = logQueues.get(journal);
  if (!queues) { queues = new Map(); logQueues.set(journal, queues); }
  const prior = queues.get(key) ?? Promise.resolve();
  const part = serialize(entries); // once, outside the retry loop
  const run = prior.then(() => casAppend(journal, key, part));
  const tail = run.then(() => undefined, () => undefined); // a failed append must not stall the next one
  queues.set(key, tail);
  void tail.finally(() => { if (queues!.get(key) === tail) queues!.delete(key); });
  return run;
}

/** Full jitter, capped: lost rounds spread the writers out instead of having them all re-read at once. */
const backoff = (lost: number) => new Promise<void>((r) => setTimeout(r, Math.floor(Math.random() * Math.min(1000, 2 ** Math.min(lost, 10)))));

async function casAppend(journal: Journal, key: string, part: string): Promise<void> {
  const cas = typeof journal.putIfMatch === 'function' && typeof journal.putIfAbsent === 'function';
  let lost = 0;
  let unchanged = 0;
  let lastLost: number | undefined;
  for (;;) {
    const current = await journal.get<unknown>(key);
    const next: JournalLogValue = { gnlLog: 1, parts: [...priorParts(current), part], appendedAt: [...priorTimes(current), Date.now()] };
    if (!cas) return journal.put(key, next);
    // A 0.9.0 log is the entries themselves, compared through `asStored` — see there.
    const won = current === undefined
      ? await journal.putIfAbsent!(key, next)
      : await journal.putIfMatch!(key, Array.isArray(current) ? asStored(current) : current, next);
    if (won) return;
    const seen = sizeOf(current);
    unchanged = seen === lastLost ? unchanged + 1 : 1;
    lastLost = seen;
    // A 0.9.0 log holding something `asStored` does not restore can never be compared. Refusing every
    // append to it would block the thread for good, so — and only there — the upgrade is the plain put
    // 0.9.0 itself did, after a re-read shows the log as read (warned: two first appends racing on such
    // a log can still lose one).
    if (Array.isArray(current) && unchanged >= 2 && (await upgradedUncomparable(journal, key, current, next))) return;
    if (unchanged >= JOURNAL_LOG_MAX_ATTEMPTS) throw new JournalLogContentionError(key, unchanged);
    await backoff(++lost);
  }
}

const uncomparableWarned = new WeakSet<object>();

async function upgradedUncomparable(journal: Journal, key: string, read: unknown[], next: JournalLogValue): Promise<boolean> {
  const again = await journal.get<unknown>(key);
  if (!Array.isArray(again) || serialize(again) !== serialize(read)) return false; // someone did write: retry normally
  if (!uncomparableWarned.has(journal)) {
    uncomparableWarned.add(journal);
    console.warn(
      `@gnldev/durable: the 0.9.0 log at '${key}' holds a value its journal cannot compare after a round trip, so its ` +
      'first append was written without a compare. Two processes making that first append at the same moment can ' +
      'lose one of the two; every later append is compared.',
    );
  }
  await journal.put(key, next);
  return true;
}

/**
 * How long the log is — the progress signal. A log only grows (an append adds a part; a 0.9.0 array is
 * upgraded to one part plus the new one), so a lost compare followed by the same length means nobody
 * wrote. Cheap on purpose: it is read on every lost round, and with hundreds of writers there are many.
 */
function sizeOf(current: unknown): number {
  if (current === undefined || current === null) return -1;
  if (Array.isArray(current)) return -2 - current.length;
  return isLogValue(current) ? current.parts.length : -1;
}

/** `appendedAt` aligned with `priorParts`: `null` where a part's time was never recorded. */
function priorTimes(current: unknown): Array<number | null> {
  if (current === undefined || current === null) return [];
  if (Array.isArray(current)) return current.length ? [null] : [];
  return isLogValue(current) ? current.parts.map((_, i) => current.appendedAt?.[i] ?? null) : [];
}

function priorParts(current: unknown): string[] {
  if (current === undefined || current === null) return [];
  if (Array.isArray(current)) return current.length ? [serialize(current)] : []; // a 0.9.0 log becomes one part
  return isLogValue(current) ? current.parts : [];
}

/**
 * A 0.9.0 log as it was STORED, so `putIfMatch` can compare it. That log is the entries themselves,
 * and the compare is "is the stored value the serialised form of `expected`?". Read back, an `Error`
 * gains an own `cause: undefined` that the original did not have (superjson restores the field it
 * found absent), so `serialize(read)` is not the stored text and the compare lost on every round.
 * Dropping that added field restores the stored form; the compare then decides, as for any other
 * append, and the first append to such a log is no longer a plain put (measured before: two
 * connections first-appending to one such log lost one append in 20 of 20 rounds).
 *
 * A copy: the value read is not changed. Everything else superjson stores round-trips as it is.
 */
function asStored(value: unknown, seen = new Map<object, unknown>()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  if (value instanceof Error) {
    const copy = Object.create(Object.getPrototypeOf(value)) as Error & Record<string, unknown>;
    seen.set(value, copy);
    for (const k of Object.getOwnPropertyNames(value)) {
      if (k === 'cause' && (value as { cause?: unknown }).cause === undefined) continue;
      const d = Object.getOwnPropertyDescriptor(value, k)!;
      Object.defineProperty(copy, k, 'value' in d ? { ...d, value: asStored(d.value, seen) } : d);
    }
    return copy;
  }
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const v of value) copy.push(asStored(v, seen));
    return copy;
  }
  if (value instanceof Map) {
    const copy = new Map();
    seen.set(value, copy);
    for (const [k, v] of value) copy.set(asStored(k, seen), asStored(v, seen));
    return copy;
  }
  if (value instanceof Set) {
    const copy = new Set();
    seen.set(value, copy);
    for (const v of value) copy.add(asStored(v, seen));
    return copy;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return value;
  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const [k, v] of Object.entries(value)) copy[k] = asStored(v, seen);
  return copy;
}

export class BasicMemory implements Memory {
  constructor(private readonly journal: Journal) {}

  async getMessages(threadId: string): Promise<any[]> {
    return readJournalLog<any>(this.journal, memKey(threadId, 'messages'));
  }

  async append(threadId: string, messages: any[]): Promise<void> {
    await appendToJournalLog(this.journal, memKey(threadId, 'messages'), messages);
  }

  async getWorkingMemory(threadId: string): Promise<string | undefined> {
    return this.journal.get<string>(memKey(threadId, 'working'));
  }

  async setWorkingMemory(threadId: string, value: string): Promise<void> {
    await this.journal.put(memKey(threadId, 'working'), value);
  }
}
