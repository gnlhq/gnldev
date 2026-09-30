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
 */
interface JournalLogValue { gnlLog: 1; parts: string[] }

function isLogValue(v: unknown): v is JournalLogValue {
  return typeof v === 'object' && v !== null && (v as JournalLogValue).gnlLog === 1 && Array.isArray((v as JournalLogValue).parts);
}

/**
 * A compare that keeps losing. Each lost round means another writer's append landed, so a long run of
 * them is either a very hot key or a store whose compare can never succeed; in both cases a named
 * failure beats spinning. `appendToJournalLog` gives up after `JOURNAL_LOG_MAX_ATTEMPTS`.
 */
export class JournalLogContentionError extends Error {
  constructor(readonly key: string, readonly attempts: number) {
    super(
      `@gnldev/durable: the append to '${key}' lost its compare-and-set ${attempts} times in a row and was not written. ` +
      'Another writer kept changing the log, or the journal\'s putIfMatch never matches what its get returned. ' +
      'Nothing was lost; retry the append, and if it repeats, check the journal adapter\'s putIfMatch.',
    );
    this.name = 'JournalLogContentionError';
  }
}

/** The retry bound for one append. Each lost round is another writer's win, so this is ~that many concurrent writers. */
export const JOURNAL_LOG_MAX_ATTEMPTS = 64;

/**
 * Reads a log written by `appendToJournalLog`, in append order. Also reads a 0.9.0 log (a bare array).
 * Every reader of such a key goes through here — memory classes and the thread sweep alike — so the
 * stored shape is known in one place.
 */
export async function readJournalLog<T = unknown>(journal: Pick<Journal, 'get'>, key: string): Promise<T[]> {
  return decodeLog<T>(await journal.get<unknown>(key));
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
 *     value is strings only (see `JournalLogValue`), so a lost compare always means another writer
 *     won; retries yield to the event loop and stop at `JOURNAL_LOG_MAX_ATTEMPTS` with
 *     `JournalLogContentionError`.
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

const yieldToLoop = () => new Promise<void>((r) => setTimeout(r, 0));

async function casAppend(journal: Journal, key: string, part: string): Promise<void> {
  const cas = typeof journal.putIfMatch === 'function' && typeof journal.putIfAbsent === 'function';
  for (let attempt = 1; ; attempt++) {
    const current = await journal.get<unknown>(key);
    const next: JournalLogValue = { gnlLog: 1, parts: [...priorParts(current), part] };
    if (!cas) return journal.put(key, next);
    if (current === undefined ? await journal.putIfAbsent!(key, next) : await journal.putIfMatch!(key, current, next)) return;
    if (Array.isArray(current) && (await upgradedInPlace(journal, key, current, next))) return;
    if (attempt >= JOURNAL_LOG_MAX_ATTEMPTS) throw new JournalLogContentionError(key, attempt);
    await yieldToLoop();
  }
}

function priorParts(current: unknown): string[] {
  if (current === undefined || current === null) return [];
  if (Array.isArray(current)) return current.length ? [serialize(current)] : []; // a 0.9.0 log becomes one part
  return isLogValue(current) ? current.parts : [];
}

/**
 * The one case a string compare cannot cover: the FIRST append to a 0.9.0 log, whose stored value is
 * still the entries themselves. If that array does not round-trip (an Error inside), `putIfMatch`
 * can never match it. When a re-read shows the key unchanged — nobody else wrote between our reads,
 * so the compare failed on the round trip, not on a race — the upgrade is written with a plain `put`.
 * The window this leaves is one upgrade per such log, between the re-read and the put.
 */
async function upgradedInPlace(journal: Journal, key: string, read: unknown[], next: JournalLogValue): Promise<boolean> {
  const again = await journal.get<unknown>(key);
  if (!Array.isArray(again) || serialize(again) !== serialize(read)) return false; // someone did write: retry normally
  await journal.put(key, next);
  return true;
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
