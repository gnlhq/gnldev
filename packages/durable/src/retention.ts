// Retention/GDPR: PERMANENT deletion helpers from the journal. The one exception to the
// journal's append-only philosophy — only for legal deletion (PII purge) and retention sweeps.
// Requires the `deletePrefix` port (InMemory/Sqlite/Postgres adapters provide it); otherwise
// throws a clear error.
import { runRecordKey } from './run-id-grammar.js';
import { runKeys, summarizeRun, runIdOfKey, listRunsWhere, assertJournalGuarantees } from './journal.js';
import { identityOnlyInput } from './run.js';
import { workKeyHash } from './hash.js';
import { memKey, readJournalLogDated, semanticLogKey, SEMANTIC_LOG_PREFIX } from './memory.js';
import type { Memory } from './memory.js';
import { threadOwnerOf } from './thread-owner.js';
import type { WorkScopeKind } from './hash.js';
import type { Journal, JournalReader } from './journal.js';

/** What sweepRuns needs off a `:input` record: the freeze stamp, plus whatever identityOnlyInput reads. */
type FrozenInputLike = { at?: number } & Record<string, unknown>;
import type { WorkStore, VectorStore } from './storage.js';
import { VECTOR_ALL_PARTITIONS, assertRootOutsideOrganizations } from './storage.js';
import type { LogItem } from './durable-log.js';
import { createPollLoop } from './polling.js';
import { orgPrefix, isOrganizationKey } from './organization.js';
import type { PollLoop } from './polling.js';
import { refuseUnknownNames } from '@gnldev/options';
import { LOG_SWEEP_TARGET_NAMES, PURGE_ORGANIZATION_NAMES, PURGE_RESOURCE_NAMES, PURGE_RUN_NAMES, PURGE_THREAD_NAMES, RETENTION_SWEEPER_NAMES, SWEEP_LOG_NAMES, SWEEP_RUNS_NAMES, SWEEP_THREADS_NAMES } from './option-names.js';
// What a run, a thread and a person own, and the one executor that deletes by it (model.ts). The
// journal primitives (exact and neighbour-safe deletes, the thread-key readers) live there with it.
import {
  requireDelete, deleteExactKey, escOwnerPart, ownershipTraceKey, planRun, planThread, planOrganization, executePlan, PERSON_FAMILIES, isOwnLessonRest,
  MEM_PREFIX, XTHR_PREFIX, threadIdOfMemKey, threadIdOfXthrKey, threadIdOfSemKey,
} from './model.js';
import type { DeleteTarget } from './model.js';
import { storageOf, toJournal } from './storage.js';
import type { CacheStore, MetaStore, Storage } from './storage.js';
import { orgStorageScopeOf } from './org-storage.js';
import type { SubjectEraser } from './erase.js';
import type { MemoryStore } from './storage.js';
import { ThreadRunsInFlightError } from './errors.js';
import { eraseSuggestionsOf } from './suggestions.js';
import { orgPurgedKey, sweepRunFences } from './erasure-fence.js';
export { ownershipTraceKey, orgPurgedKey };


function requireListKeys(journal: Journal): Journal['listKeys'] {
  assertJournalGuarantees(journal, 'a sweep');
  return journal.listKeys.bind(journal);
}


/**
 * Permanently delete ALL traces of a run: `<runId>:*` (model/tool/input/wf/proc/cfg/net) + memory
 * marker + its sub-agents' own journals — RECURSIVE cascade (H5):
 *
 * **Network children** (`net:<runId>:<i>`, parent-prefixed): derived from listKeys as SEPARATE
 *   runIds, each recursed into → their OWN agent-tool children get caught too. If listKeys is
 *   unavailable, a blanket `net:<runId>:` prefix delete is still applied (at least the direct level).
 * **Agent-tool children** (`agent:<toolCallId>`, NOT parent-prefixed): before deletion, toolCallIds
 *   are read from the parent's tool entries (readRun), and every `agent:<tcid>` child with a trace in
 *   the journal is recursed into. If readRun is unavailable, this discovery is skipped (best-effort —
 *   documented legacy behavior).
 * **Workflow-as-tool children** (`wf:<runId>:<tcid>`, registry.ts's buildWorkflowTools): derived from
 *   The SAME tool entries, with the same both-shapes rule. These used to outlive their parent
 *   Entirely — a purged run left the workflow child's step outputs and its `wfrun:` registry record
 *   Behind, advertising a run whose parent no longer exists.
 *
 * **Run-registry record** (`wfrun:<runId>`): top-level by design, so no `<runId>:` prefix delete could
 * reach it. Deleted for THIS run — which covers nested workflow children too, since the cascade
 * recurses into them and each recursion deletes its own.
 *
 * Cycle safety: the same runId is processed once per purge chain (`seen`). GDPR implication: parent
 * purge no longer orphans sub-agent output (which may contain PII) at ANY level.
 *
 * NEIGHBOUR BOUND (see purgeOwnNamespace): a run whose id EXTENDS this one — `conv:msg1` under
 * `conv` — is a different run and is left alone. On a journal with `listKeys` that is enforced; on
 * one without, the `${runId}:` prefix delete still takes it, which is the bound stated rather than
 * assumed away. Every adapter shipped here has listKeys.
 */

/**
 * Whether erasing `resourceId` should take `threadId` with it. Only their own threads: a run of theirs
 * on someone else's thread (an older release let one through) made this function delete her messages
 * with his account.
 *  - An owner record, or an owner the runs agree on, decides it.
 *  - A thread that exists with no single owner — staff's, or claimed by two people's runs — is not
 *    theirs to erase.
 *  - No evidence at all (runs swept, no record: a thread from before the record existed) falls back
 *    to the traces `purgeRun` leaves: theirs when no one else's trace points at it. Otherwise the
 *    erasure request would leave their own arguments behind, which is the failure this path exists for.
 */
async function threadIsTheirs(journal: Journal, threadId: string, resourceId: string, memory?: Memory): Promise<boolean> {
  // The same question, with the same arguments, the gate and the reading ask (thread-owner.ts).
  const o = await threadOwnerOf(journal, memory, threadId);
  if (o.owner) return o.owner === resourceId;
  if (o.exists) return false;
  const pre = ownershipTraceKey('', '').slice(0, -1); // 'resthr:'
  for (const k of await journal.listKeys(pre)) {
    const rest = k.slice(pre.length);
    const cut = rest.indexOf(':');
    if (cut > 0 && rest.slice(cut + 1) === threadId && rest.slice(0, cut) !== escOwnerPart(resourceId)) return false;
  }
  return true;
}

export async function purgeRun(
  journal: Journal & Partial<JournalReader>,
  runId: string,
  seen: Set<string> = new Set(),
  opts: {
    /**
     * Write `resthr:<resourceId>:<threadId>` before deleting the run.
     *
     * `purgeResource` finds a person's threads THROUGH their runs. Retention deletes runs by age, so
     * a sweep that runs first takes the only link with it: the erasure request then walks an empty
     * list while `xthr:<threadId>:` still holds semantic records built from that person's arguments.
     * Measured, and until now merely documented: after `sweepRuns` + `purgeResource`, thread state
     * survived carrying `'createRecord: iban-tr55'`.
     *
     * Off by default, and `purgeResource` deliberately leaves it off — writing an ownership record
     * while erasing that same person would be the opposite of the point. Retention turns it on: the
     * cost is one write per DELETED run, and nothing at all on the normal path.
     */
    ownershipTrace?: boolean;
  } = {},
): Promise<number> {
  refuseUnknownNames('purgeRun', opts, PURGE_RUN_NAMES);
  requireDelete(journal);
  return purgeRunPlan(journal, runId, seen, opts.ownershipTrace === true, true);
}

/**
 * The run and every run under it, children first (model.ts): the plan is read off the run's own
 * records before anything goes, then executed in that order. `fence: false` is retention's own sweep —
 * see `executePlan`.
 */
async function purgeRunPlan(journal: Journal & Partial<JournalReader>, runId: string, seen: Set<string>, ownershipTrace: boolean, fence: boolean): Promise<number> {
  return executePlan({ journal }, await planRun(journal, runId, seen), { ...(ownershipTrace ? { ownershipTrace: runId } : {}), ...(fence ? {} : { fence: false }) });
}

/**
 * KİŞİ-bazlı silme yüzeyi (GDPR/KVKK md.17): bir resource'un (kullanıcının) kalıcı kimlik ailelerini
 * süpürür — `xid:res:<rid>:` (kanallar-arası iş kimlikleri: düz-metin kimlik + tutar + ilk-koşum
 * referansı) ve `lesson:res:<rid>:` (HERMES kişisel dersleri). Denetçi K27-EK: bu yüzey, xid
 * ailesinin doğduğu diff'te 'yorumda reçete' olarak kalmıştı — çağrılabilir hali budur.
 * `sugg:` records are keyed by id, not by person: `purgeResource` erases them by the owner the record
 * names (`eraseSuggestionsOf`, suggestions.ts).
 */
/**
 * BATCH ailesinin silme yüzeyi (denetçi bloker — K27/EK-2): `batch:<batchId>:` tek süpürmede plan
 * (itemKeys = İŞ REFERANSLARI — PII-komşusu), report (itemKey+detail) ve TÜM item-run kayıtlarını
 * (args = tam item verisi) alır. SWEEP GÖRÜNMEZLİĞİ, belgeli: batch item-run'ları `:outcome`/`:status`
 * yazmaz → sweepRuns/listStaleRuns bu aileyi HİÇ görmez; retention'ı olan bir kurulum batch'leri
 * kendi takvimiyle bu fonksiyonla süpürmelidir (ör. rapor arşivlendikten sonra).
 */
export async function purgeBatch(journal: Journal, batchId: string): Promise<number> {
  if (batchId.includes(':')) throw new Error(`@gnldev/durable: purgeBatch('${batchId}') — batchId must not contain ':' (prefix boundary)`);
  const del = requireDelete(journal);
  return del(`batch:${batchId}:`);
}

/**
 * The person-keyed families (`xid:res:<rid>:`, `lesson:res:<rid>:`, `suggstats:lesson:res:<rid>:`)
 * erased WITHOUT taking a longer id's keys.
 *
 * `xid:res:bob:` is not a boundary: user ids may contain ':', and `xid:res:bob:evil:send:<h>` belongs
 * to `bob:evil`. Measured before this: erasing `bob` deleted `bob:evil`'s cross-channel ids, lessons
 * and lesson counters. What the family writes AFTER the id tells them apart: a lesson ends in one
 * uuid (no ':'), a cross-channel id in `<toolName>:<16-hex hash>` with the tool named in the value. A
 * longer id's key always has a ':' more than that shape allows ("foreign").
 *
 * The same shape as `purgeThreadNamespace`: no foreign key visible (the overwhelmingly common case)
 * → the three prefix deletes of before, which also reach the `suggstats:` COUNTER rows a key listing
 * cannot see. A foreign key visible → exact deletes of this person's keys only, and their counters by
 * the lesson ids found. Without `listKeys` there is nothing to filter on, so the prefix deletes stand —
 * the bound `purgeOwnNamespace` states too; every adapter shipped here has listKeys.
 */
async function purgePersonFamilies(journal: Journal, resourceId: string): Promise<number> {
  const del = requireDelete(journal);
  // The families are the model's (`PERSON_FAMILIES`, model.ts); what follows the id tells each one's own keys apart.
  const [xidFamily, lessonFamily, statsFamily] = PERSON_FAMILIES;
  const xidPre = `${xidFamily}${resourceId}:`;
  const lessonPre = `${lessonFamily}${resourceId}:`;
  const statsPre = `${statsFamily}${resourceId}:`;
  const own: string[] = [];
  const suggIds = new Set<string>();
  let foreign = false;
  for (const k of await journal.listKeys(xidPre)) {
    const rest = k.slice(xidPre.length);
    if (xidShape(rest, await journal.get(k)) === 'own') own.push(k); else foreign = true;
  }
  for (const [pre, isStats] of [[lessonPre, false], [statsPre, true]] as const) {
    for (const k of await journal.listKeys(pre)) {
      const rest = k.slice(pre.length);
      if (!isOwnLessonRest(rest)) { foreign = true; continue; }
      own.push(k);
      if (!isStats) suggIds.add(rest);
    }
  }
  if (!foreign) return (await del(xidPre)) + (await del(lessonPre)) + (await del(statsPre));
  let total = 0;
  for (const k of own) total += await deleteExactKey(journal, k);
  // A counter row is invisible to listKeys and to get(): reached by its full key. The key ends in a
  // uuid, so the prefix delete of the full key is that one row.
  for (const id of suggIds) total += await del(`${statsPre}${id}`);
  return total;
}
/**
 * `xid:res:<rid>:<toolName>:<argsHash>`. `own` when the rest is this person's shape — the tool the
 * record names, then the hash; a rest with fewer than two ':' cannot belong to a longer id either.
 */
function xidShape(rest: string, value: unknown): 'own' | 'foreign' {
  const cut = rest.lastIndexOf(':');
  const tool = (value as { toolName?: unknown } | undefined)?.toolName;
  if (cut > 0 && /^[0-9a-f]{16}$/.test(rest.slice(cut + 1)) && typeof tool === 'string') return rest.slice(0, cut) === tool ? 'own' : 'foreign';
  return rest.split(':').length - 1 < 2 ? 'own' : 'foreign';
}

/**
 * Erases a person's footprint.
 *
 * WHAT IT USED TO MISS, and why that mattered more than the missing families themselves: the three
 * prefixes below are the ones whose KEY names the person, so a prefix sweep finds them. Everything a
 * person actually DID lives under their RUNS — the suspended tool record with the raw args, the
 * frozen `:input` (prompt + resourceId), the approval decisions, the override trail, the incidents.
 * None of those keys mention the resourceId, so no prefix reaches them: after a deletion request the
 * person's orders, prompts and human answers all stayed in the journal.
 *
 * The tool to find them already existed — `listRunsPaged({ resourceId })` — and it reads the very
 * `:input` field this sweep needs. So the gap was never "we cannot"; it was "nobody wired it". That
 * is also why the birth paths matter here: a run that never recorded an owner (delegation, network,
 * workflow, batch, rollover — all fixed alongside this) is invisible to this enumeration, so the
 * deletion is silently partial. An erasure that quietly skips half a person is worse than one that
 * refuses: nobody goes looking for what the report said was gone.
 *
 * HONEST BOUNDS, stated because this is a legal surface:
 *  - `__audit__` is NOT swept per person — an audit trail that a data subject can erase is not an
 *    audit trail. It is swept by AGE (`sweepLog`), which is the retention answer for it.
 *  - Threads are swept only through the runs found here (their `:input.threadId`). A thread the
 *    person owns but never ran anything in is unreachable from this side — `purgeThread` is the
 *    surface for that, and the caller knows the thread ids.
 *  - Needs `listKeys`+`listRunsPaged`; an adapter without them keeps today's three-prefix behaviour
 *    rather than silently reporting a fuller erasure than it performed.
 */
export async function purgeResource(
  journal: Journal,
  resourceId: string,
  opts: {
    /**
     * The knowledge base, to erase this person's own documents (`owner: resourceId`) too. The vector
     * store is a separate port from the journal, so without it their documents stay — a store with no
     * `delete` is refused rather than skipped, since an erasure that quietly keeps half is the failure
     * this function exists to avoid. With `outsideOrganizations` the store must also declare
     * `rootOutsideOrganizations`, for the same reason.
     */
    vectors?: Pick<VectorStore, 'delete' | 'rootOutsideOrganizations'>;
    /**
     * The memory that holds the threads, when it can name their owners (`getThreadResource`). Asked
     * so erasure decides "is this thread theirs" exactly as the engine's gate does; without it a
     * legacy thread was judged by its surviving runs alone, and one foreign run on it took the
     * owner's messages with the wrong person's erasure.
     */
    memory?: Memory;
    /**
     * Erase only the runs OUTSIDE organization partitions. A root journal lists every organization's
     * runs too (`org:<id>:…`), and the same user id in an organization is a different person
     * (`user(id, orgId)`); `eraseSubject` without an `orgId` sets this, so erasing the organization-less
     * `ayse` does not take acme's `ayse`'s runs (measured before: it did). Her documents likewise: the
     * vector delete carries `outsideOrganizations`, so acme's and globex's `ayse` keep theirs (E1b —
     * measured before: none of the three kept any).
     */
    outsideOrganizations?: boolean;
  } = {},
): Promise<number> {
  refuseUnknownNames('purgeResource', opts, PURGE_RESOURCE_NAMES);
  const del = requireDelete(journal);
  if (opts.vectors && typeof opts.vectors.delete !== 'function') {
    throw new Error('@gnldev/durable: purgeResource was given a vector store that cannot delete, so this person\'s documents cannot be erased');
  }
  if (opts.vectors && opts.outsideOrganizations) assertRootOutsideOrganizations(opts.vectors, '@gnldev/durable: purgeResource');
  // `suggstats:` carries the FULL lesson key (`suggstats:lesson:res:<rid>:<id>`) — the injection
  // counter's key itself names the person, so it must die with them (GDPR brief audit, K27 EK-3).
  // deletePrefix sweeps counter rows since P1.6, so this reaches HINCRBY-backed adapters too.
  let total =
    (await purgePersonFamilies(journal, resourceId)) + (await eraseSuggestionsOf(journal, resourceId));

  // Their own documents in the knowledge base (shared ones are nobody's to erase with one person).
  // Before the early return below, which a journal without paged listing takes.
  // Without `outsideOrganizations` this erasure is the id's in every partition: the grant says so, since
  // a root delete without a namespace is otherwise the root's alone (ADR-0001, `vectorDeletePlan`).
  if (opts.vectors) total += await opts.vectors.delete!({ owner: resourceId, ...(opts.outsideOrganizations ? { outsideOrganizations: true } : { [VECTOR_ALL_PARTITIONS]: true as const }) });
  // The person's RUNS — enumerated by the same field the ownership gates read: on Sqlite and Postgres
  // the runs placed under them plus every run not placed yet, by index (`keysetRunPage`); elsewhere the
  // listing's own filter. A bare custom Journal without a paged listing degrades to the three-prefix
  // behaviour rather than throw on a deletion request — a missing capability is a known limit.
  //
  // A FAILING listing is not that, and is not swallowed. It used to be: a page that threw read as an
  // empty page, so the erasure deleted none of the person's runs and returned a count, and the caller
  // told the person their data was gone — the outcome the `listKeys` block below refuses in so many
  // words. A throw is the only honest answer; the request is retried, not reported done.
  const listed = await listRunsWhere(journal, { resourceId });
  if (listed === undefined) return total;
  const threads = new Set<string>();
  const runs: Array<{ runId: string; threadId?: string }> = [];
  for (const r of listed) {
    if (opts.outsideOrganizations && isOrganizationKey(r.runId)) continue;
    if (r.threadId) threads.add(r.threadId);
    runs.push(r);
  }
  // WHOSE THREADS. A run of this person's on a thread does not make the thread theirs: an older
  // release let a user attach a run to someone else's thread, and this function then deleted her
  // messages with his account. Asked BEFORE anything goes, because a thread opened before owner
  // records existed is still answered from its runs.
  const owned = new Set<string>();
  for (const t of threads) if (await threadIsTheirs(journal, t, resourceId, opts.memory)) owned.add(t);
  // THE THREADS WHOSE RUNS ARE ALREADY GONE. Everything above reaches a thread through a run, so a
  // retention sweep that ran first has already taken the only link — and the erasure request would
  // walk an empty list past `xthr:<threadId>:` records built from this person's own arguments.
  // `purgeRun` leaves `resthr:<resourceId>:<threadId>` behind precisely for this moment.
  const tracePrefix = `${ownershipTraceKey(resourceId, '')}`;
  // NO `.catch(() => [])` HERE, deliberately. An empty list and a failed read produce the same
  // value, and this is an ERASURE path: swallowing the error means purgeResource returns a count,
  // the caller tells the person their data is gone, and a record carrying their own arguments is
  // still on disk. Measured: with listKeys throwing, the thread kept `pay: iban-tr55` and the
  // function reported success. A throw is the only honest outcome — the request must be retried,
  // not quietly half-finished.
  for (const k of await journal.listKeys(tracePrefix)) {
    const t = k.slice(tracePrefix.length);
    // A threadId may itself contain ':' ('tenant:7:chat'), so this takes the WHOLE remainder
    // rather than splitting — the prefix already ends at the resourceId boundary.
    if (t && (await threadIsTheirs(journal, t, resourceId, opts.memory))) owned.add(t);
  }
  // Their threads, each deleted as a thread is (model.ts): its runs — theirs, and any other run on it —
  // its journal state, its owner record last. Not refused for a run in flight: an erasure takes what is
  // there (see `subjectRuns` for the order that stops a turn writing after it).
  for (const t of owned) total += await purgeThread(journal, t, { allowInFlight: true });
  // Then their runs on no thread of theirs: on no thread at all, or on someone else's.
  for (const r of runs) if (!(r.threadId && owned.has(r.threadId))) total += await purgeRun(journal, r.runId);
  // The trace names a person and must not outlive them. Last, so a failure above cannot strand it.
  total += await del(`${ownershipTraceKey(resourceId, '')}`);
  return total;
}


/**
 * Permanently delete a thread — WITH ITS RUNS (0.x, breaking) — and everything it owns
 * (`THREAD_DEPENDENTS`, model.ts): every run whose `:input` names it (a sub-agent, a fork, a rollover
 * on it included) with their children, its journal state (`mem:`, `xthr:`, `om:`, `sem:`), the
 * ownership traces pointing at it, and — when they are handed in — its observation vectors and its
 * memory-store half. The owner record goes last, so a deletion killed half-way leaves the thread gated.
 *
 * The journal alone is the whole thread for a journal-kept memory (`BasicMemory`, `SemanticMemory`).
 * A memory-store thread (`@gnldev/memory`'s `AgentMemory`) passes its store as `memory` — or calls
 * `AgentMemory.deleteThread`, which does — so one call removes both halves. Before 0.11 this function
 * took the journal half and nothing else, and `MemoryStore.deleteThread` the other half and nothing
 * else; neither took the runs (ADR-0007).
 *
 * REFUSES, deleting nothing, while a run on the thread is in flight (`threadRunsInFlight`): pulling its
 * records out from under it would let it write its answer into a deleted thread, and let a step whose
 * claim was deleted run its effect again. Cancel it (`cancelAgentRun`) and delete, or pass
 * `allowInFlight: true` for a run you know is abandoned (its worker died).
 *
 * Not swept here, by design: a person's `sugg:`/`lesson:` records (`eraseSubject` erases them), and
 * cross-run claims (`xrun:`), which are shared by every run that dedups against them.
 */
export async function purgeThread(
  journal: Journal,
  threadId: string,
  opts: {
    /** The memory store that holds the thread's record, messages, working memory and observations. */
    memory?: Pick<MemoryStore, 'deleteThread'>;
    /** The vector store holding its observation vectors (deleted by `{ source, threadId }`; add your scope in a wrapper). */
    vectors?: Pick<VectorStore, 'delete'>;
    /** Delete even when a run on the thread is in flight — for a run you know is abandoned. */
    allowInFlight?: boolean;
  } = {},
): Promise<number> {
  refuseUnknownNames('purgeThread', opts, PURGE_THREAD_NAMES);
  return purgeThreadPlan(journal, threadId, opts, true);
}

/** `purgeThread`, with `fence: false` for retention's own sweep — see `executePlan`. */
async function purgeThreadPlan(
  journal: Journal,
  threadId: string,
  opts: { memory?: Pick<MemoryStore, 'deleteThread'>; vectors?: Pick<VectorStore, 'delete'>; allowInFlight?: boolean },
  fence: boolean,
): Promise<number> {
  requireDelete(journal);
  const target = { journal, ...(opts.memory ? { memory: opts.memory } : {}), ...(opts.vectors ? { vectors: opts.vectors } : {}) };
  return executePlan(target, await planThread(target, threadId, { ...(opts.allowInFlight ? { allowInFlight: true } : {}) }), fence ? {} : { fence: false });
}

/**
 * A thread's journal state and records WITHOUT its runs — the half of a thread MOVE that empties the old
 * id (`migrateReservedRootThreads`): the runs keep naming the id they were run under.
 * @internal — @gnldev/memory's migration.
 */
export async function purgeThreadState(journal: Journal, threadId: string): Promise<number> {
  requireDelete(journal);
  return executePlan({ journal }, await planThread({ journal }, threadId, { runs: false }));
}

/** What `purgeOrganization` removed: every row it deleted, in every store, and each eraser's share by its name. */
export interface OrganizationErasureReport {
  deleted: number;
  byEraser: Record<string, number>;
}

/**
 * Deletes an ORGANIZATION: everything it owns, in every store the storage holds (`ORGANIZATION_DEPENDENTS`,
 * model.ts) — its partition `org:<id>:` in the journal (runs and every record of theirs, thread state,
 * owner records, usage and budget counters, metrics, workflow records, cross-run keys, fences), in the
 * memory store (threads, messages, observations, batch markers, every working memory), its documents and
 * observation vectors (the namespace `org:<id>`), its queue and event namespaces, its cache and meta
 * entries; its own and its members' owned records in the ROOT work log (`~o~<id>:…`) and what the
 * background packages keep of them (`erasers`); and last its registration and budget records. An
 * organization registered again under the id starts empty.
 *
 * `storage` is the ROOT storage; `memory` the storage its memory was built over, when that is another
 * (its partition there goes too). `erasers`: `jobEraser(storage)`, `triggerEraser(journal)`,
 * `eventEraser(work)` — each one's `eraseOrganization` erases everything owned under the organization;
 * an eraser without it is refused, deleting nothing.
 *
 * 0.x, breaking: this used to take the journal alone, and `purgeOrganizationWork(work)` the work store;
 * the memory store, the documents and the members' jobs had no call at all, and a new organization under
 * the same id read the old one's threads, messages, working memory and documents (c-erasure CE-1).
 *
 * REFUSES, deleting nothing, a storage whose stores cannot delete what this needs: a journal without
 * `deletePrefix`, a memory store without `deletePartition`, a vector store without `delete`, a work store
 * without `deletePrefix`/`deleteIdPrefix`, a cache or meta store without `deletePrefix`. Every bundled
 * store has them all.
 *
 * Prefix-boundary safety: `orgPrefix` refuses '' and a ':'-bearing id, and the trailing ':' keeps 'acme'
 * from ever reaching 'acme2'.
 *
 * DELIBERATELY NOT DELETED:
 * - the purge marker (`orgPurgedKey`): when it happened, nothing of anyone. A worker of the organization
 *   still running stops on it, and the organization-scoped audit view starts after it;
 * - root `__audit__` entries naming the organization: an audit trail erased by the operation it records
 *   is not one — sweep it on its own schedule (`sweepLog(journal, '__audit__', …)`);
 * - data the deployment wrote for this organization OUTSIDE its scope (no `withOrg`): nothing attributes it;
 * - the paid user store's members (auth-ee): Studio's DELETE /organizations/:id removes them with `users`.
 */
export async function purgeOrganization(
  storage: Storage,
  orgId: string,
  opts: { erasers?: SubjectEraser[]; memory?: Storage; now?: number } = {},
): Promise<OrganizationErasureReport> {
  refuseUnknownNames('purgeOrganization', opts, PURGE_ORGANIZATION_NAMES);
  orgPrefix(orgId); // refuses '' (which would sweep `org::`) and a ':'-bearing id — before anything else
  const blind = (opts.erasers ?? []).filter((e) => typeof e.eraseOrganization !== 'function').map((e) => e.name);
  if (blind.length) {
    throw new Error(
      `@gnldev/durable: purgeOrganization deleted nothing: the eraser(s) ${blind.map((n) => `'${n}'`).join(', ')} cannot erase an organization ` +
        "(no `eraseOrganization`), so what they hold of it would stay. Give each one `eraseOrganization` — `async () => 0` if it keeps nothing per organization.",
    );
  }
  const targets = [organizationTarget(storage, 'purgeOrganization')];
  if (opts.memory !== undefined && opts.memory !== storage) targets.push(organizationTarget(opts.memory, "purgeOrganization's `memory`"));
  const byEraser: Record<string, number> = {};
  const [root, ...others] = targets;
  // The other storage holds data of the organization's, never its registration: its partition goes first,
  // so a retry of a killed deletion still finds the organization registered.
  let deleted = 0;
  for (const t of others) deleted += await executePlan(t, planOrganization(orgId, { records: false }), { ...(opts.now !== undefined ? { now: opts.now } : {}) });
  deleted += await executePlan({ ...root!, ...(opts.erasers ? { erasers: opts.erasers } : {}) }, planOrganization(orgId), { byEraser, ...(opts.now !== undefined ? { now: opts.now } : {}) });
  return { deleted, byEraser };
}

/** The root stores of a storage, as an organization deletion reaches them — refused, deleting nothing, when one cannot delete. */
function organizationTarget(storage: Storage, who: string): DeleteTarget {
  // An organization's data is in every store the storage holds, so a port alone is refused (`storageOf`).
  storageOf(storage, who);
  const scoped = orgStorageScopeOf(storage);
  if (scoped !== undefined) {
    throw new Error(`@gnldev/durable: ${who} was handed organization '${scoped}''s storage. Pass the root storage and name the organization.`);
  }
  const journal = toJournal(storage.runs);
  const missing: string[] = [];
  if (storage.memory && typeof storage.memory.deletePartition !== 'function') missing.push('its memory store cannot `deletePartition`');
  if (storage.vectors && typeof storage.vectors.delete !== 'function') missing.push('its vector store cannot `delete`');
  if (storage.work && (typeof storage.work.deletePrefix !== 'function' || typeof storage.work.deleteIdPrefix !== 'function')) missing.push('its work store cannot `deletePrefix` and `deleteIdPrefix`');
  if (storage.cache && typeof storage.cache.deletePrefix !== 'function') missing.push('its cache cannot `deletePrefix`');
  if (typeof storage.meta?.deletePrefix !== 'function') missing.push('its meta store cannot `deletePrefix`');
  if (missing.length) {
    throw new Error(`@gnldev/durable: ${who} deleted nothing: ${missing.join(', ')}, so the organization's data there would stay. Every bundled store can.`);
  }
  return {
    journal,
    ...(storage.memory ? { memory: storage.memory } : {}),
    ...(storage.vectors ? { vectors: storage.vectors } : {}),
    ...(storage.work ? { work: storage.work as Required<Pick<WorkStore, 'deletePrefix' | 'deleteIdPrefix'>> } : {}),
    ...(storage.cache ? { cache: storage.cache as Required<Pick<CacheStore, 'deletePrefix'>> } : {}),
    meta: storage.meta as Required<Pick<MetaStore, 'deletePrefix'>>,
  };
}

export interface SweepOptions {
  /** Runs older than this (ms) are deleted. Age = the run's LAST entry time (last activity). */
  olderThanMs: number;
  /** Suspended (awaiting-approval) runs are preserved (default true) — pending work isn't silently deleted. */
  keepSuspended?: boolean;
  /**
   * FAZ-4: even with keepSuspended, a suspended run older than THIS (ms, by last activity) becomes
   * sweepable — the answer to "suspended runs accumulate forever" (retention deliberately protects
   * them; layers 2-3 raise the suspend volume, so an expiry arm stopped being optional). Uses the
   * SLOW scan (the indexed fast path cannot age suspended runs separately). Undefined = today's
   * behavior: suspended runs are never swept.
   */
  suspendedTtlMs?: number;
  /**
   * FAZ-4: write a `${runId}:swept` TOMBSTONE after purging each run. A late retry of that runId can
   * then be REFUSED under `tombstonePolicy: 'reject'` (the critical profile) instead of silently
   * re-running side effects whose dedup window died with the journal. LIFECYCLE, stated honestly:
   * Under 'reject' the tombstone is effectively PERMANENT: after the purge the run's only key is the
   * tombstone itself, which no sweep scan lists (it is invisible to the run readers) — removal only
   * happens on the 'ignore'+re-run+second-sweep chain. The safe direction, but know it. The REAL
   * contract is and remains: retention window >= client retry horizon.
   *
   * WHAT THE MARKER HOLDS (§10.3): the sweep instant, plus — if the run had declared one — the HASH
   * of its workKey and the KIND of its scope. Never the workKey text, and never the scope value. See
   * `tombstoneFor` for why a permanent record is the last place a business name may survive.
   */
  tombstones?: boolean;
  /** Testability: "now" (default Date.now()). */
  now?: number;
}

/** What a `${runId}:swept` marker holds. `at` is the sweep instant; the rest is package #2's addition. */
export interface RunTombstone {
  at: number;
  /** 16 hex of sha256 over the swept run's declared workKey — see `workKeyHash` for the pseudonym caveat. */
  workKeyHash?: string;
  /** Which kind of address that name lived in. The VALUE (a resourceId, an orgId) is not kept. */
  workScope?: WorkScopeKind;
}

/**
 * The marker a swept run leaves behind — READ BEFORE THE PURGE, because after it there is nothing
 * left to read.
 *
 * A tombstone is the one record that deliberately outlives an erasure (under
 * `tombstonePolicy: 'reject'` it is effectively permanent — see SweepOptions.tombstones), which makes
 * what goes into it a privacy decision rather than a debugging convenience. §10.3 settles it: the
 * HASH of the workKey, never the text. A workKey is a business name ('invoice-4471'), it is the kind
 * of string that names a person's affairs, and a deletion that keeps it forever in a marker nobody
 * enumerates is a deletion in name only.
 *
 * The hash is for DIAGNOSIS, not matching: nothing looks a run up by it, and it is deliberately not
 * `workDigest` (that one is an identity, with an agent and a scope hashed around it — a matching key
 * in a place that must not enable matching). The scope KIND rides along for the same diagnostic
 * reason and its VALUE does not: 'resource' tells an operator what kind of job died, the resourceId
 * would name whose.
 *
 * The other half of the honesty is elsewhere: the `run_swept` refusal reflects the caller's workKey
 * from the REQUEST, not from here (§10.3, packages #3/#5). The caller already knows their own name —
 * the error can still speak while the deletion stays deleted.
 */
async function tombstoneFor(journal: Journal, runId: string, at: number): Promise<RunTombstone> {
  const tomb: RunTombstone = { at };
  // Best-effort, like every other read on the deletion path: a journal that cannot answer must not
  // stop the sweep from finishing (a run half-purged is worse than a marker missing a hash).
  const frozen = await journal.get<{ workKey?: unknown; workScope?: { kind?: unknown } }>(runKeys.input(runId)).catch(() => undefined);
  if (typeof frozen?.workKey === 'string' && frozen.workKey.length > 0) tomb.workKeyHash = workKeyHash(frozen.workKey);
  const kind = frozen?.workScope?.kind;
  if (kind === 'resource' || kind === 'org') tomb.workScope = kind;
  return tomb;
}

export interface SweepResult {
  scanned: number;
  /** Deleted runIds. */
  purged: string[];
  /** Number of suspended runs skipped due to keepSuspended. */
  keptSuspended: number;
  /** Number of runs whose age couldn't be measured (and were thus preserved) due to missing timestamps. */
  keptNoTs: number;
  deletedEntries: number;
  /**
   * Indexed "runs" this sweep REFUSED to purge because no run ever wrote them — see `isRealRun`.
   *
   * Named rather than counted, because the name IS the namespace that was about to be deleted, and
   * an operator who sees `mem` here learns something a number cannot tell them. Absent when empty:
   * a field that is always present reads as a normal part of the report, and this one is not normal.
   */
  skippedGhosts?: string[];
  /**
   * Fences of deleted runs (erasure-fence.ts) older than `olderThanMs`, removed by this sweep: past the
   * horizon after which a run counts as abandoned, its worker is presumed gone. Absent when none.
   */
  fencesSwept?: number;
}

/**
 * Does a run row correspond to a run that actually ran?
 *
 * `parseJournalKey` claims any key with a `:model:`/`:tool:` SEGMENT as a run record, whatever
 * namespace it started in, so a thread, organization or resource named `model` mints a run row named
 * after its own keyspace — `mem`, `xthr`, `org`. The row is real; the run never was. Measured on
 * real Postgres and real Redis: one such id, one sweep, and two unrelated users' threads were gone.
 *
 * THE CHECK LIVES WHERE THE DELETE IS SPENT, not where the index is written. Indexing an unstamped
 * record is a documented adapter behaviour — `storage-backend.test.ts` pins it twenty times over,
 * and a hand-written journal still lists and replays. Tightening THAT would change what an adapter
 * is, to fix something only the purge does. So ownership is asymmetric on purpose: loose where it
 * lists, strict where it deletes by prefix.
 *
 * `:input` is the rule because run.ts writes it unconditionally, before the first model call, for
 * every run — the same property `runIdOfKey` leans on. A run that died at step 0 therefore still has
 * one and is still swept; only a row no run ever wrote is refused.
 */
export async function isRealRun(journal: Journal, runId: string): Promise<boolean> {
  // A failed read is not an absent key. Treating "I could not look" as "this is a ghost" would make
  // an unreachable backend look like a clean journal and quietly stop retention altogether.
  const key = runRecordKey(runId, 'input');
  try {
    // runIdOfKey, not a second spelling of the rule: it requires the record to carry stampFormat's
    // `_v`, i.e. to have been written BY the journal rather than by a caller's payload. Existence
    // alone was a bypass, and a reachable one — `appendLog(journal, 'mem', payload, 'input')` writes
    // an unstamped `mem:input` through the public API, and that was enough to open this gate and
    // let the prefix purge take two unrelated users' threads. Measured, all three ways: by hand,
    // through appendLog, and with a real stamped input as the control.
    return runIdOfKey(key, await journal.get(key)) === runId;
  } catch {
    // A failed read is not an absent key. Treating "I could not look" as "this is a ghost" would
    // make an unreachable backend look like a clean journal and quietly stop retention altogether.
    return true;
  }
}

/**
 * Retention sweep: permanently deletes runs whose last activity is older than `olderThanMs`.
 * Safety defaults: suspended runs and runs without a timestamp are NOT deleted.
 * Requires a reader (listRuns/readRun) + deletePrefix.
 */
export async function sweepRuns(journal: Journal & Partial<JournalReader>, opts: SweepOptions): Promise<SweepResult> {
  refuseUnknownNames('sweepRuns', opts, SWEEP_RUNS_NAMES);
  requireDelete(journal);
  if (typeof journal.listRuns !== 'function' || typeof journal.readRun !== 'function') {
    throw new Error("@gnldev/durable: sweepRuns requires a journal read surface (listRuns/readRun)");
  }
  const now = opts.now ?? Date.now();
  const keepSuspended = opts.keepSuspended !== false;

  // H8b FAST PATH: if the adapter provides an indexed age query (gnl_runs.updated_at), get stale
  // ids directly without pulling ALL of every run's entries (the old O(entire-DB) scan). The result
  // contract is the same; keptSuspended/keptNoTs are reported as 0 by definition on this path
  // (SQL already filtered).
  // FAZ-4: suspendedTtlMs needs the slow scan — the indexed query cannot age suspended runs on a
  // SEPARATE cutoff (it either includes them at the general cutoff or not at all).
  if (typeof (journal as Journal).listStaleRuns === 'function' && opts.suspendedTtlMs === undefined) {
    const cutoff = now - opts.olderThanMs;
    const stale = await (journal as Journal).listStaleRuns!(cutoff, { includeSuspended: !keepSuspended });
    const fast: SweepResult = { scanned: stale.length, purged: [], keptSuspended: 0, keptNoTs: 0, deletedEntries: 0 };
    for (const runId of stale) {
      // A row no run ever wrote is refused here rather than purged by prefix — see isRealRun.
      if (!(await isRealRun(journal, runId))) { (fast.skippedGhosts ??= []).push(runId); continue; }
      // BEFORE the purge — `tombstoneFor` reads the run's own `:input`, which the next line deletes.
      const tomb = opts.tombstones ? await tombstoneFor(journal, runId, now) : undefined;
      fast.deletedEntries += await purgeRunPlan(journal, runId, new Set(), true, false);
      if (tomb) await journal.put(runRecordKey(runId, 'swept'), tomb);
      fast.purged.push(runId);
    }
    const fencesSwept = await sweepRunFences(journal, now - opts.olderThanMs);
    if (fencesSwept > 0) fast.fencesSwept = fencesSwept;
    return fast;
  }

  // SAYFALAMA — `listRuns()` argümansız çağrıldığında üç adaptörün üçünde de varsayılan `limit=50`.
  // Yani süpürme, journal'da kaç koşum olursa olsun EN FAZLA 50 tanesine bakıyordu ve bunu hiçbir
  // yerde söylemiyordu: 51'inci koşumdan sonrası hiç süpürülmüyor, sessizce büyüyordu.
  // Bugüne kadar gizli kalmasının sebebi, hızlı yolun (`suspendedTtlMs === undefined`) bu bloğa hiç
  // girmemesiydi — yani tam da TTL'i açan, süpürmeye en çok ihtiyaç duyan kurulum tavana çarpıyordu.
  const paged = (journal as unknown as {
    listRunsPaged?: (q: { limit: number; cursor?: string }) => Promise<{ items: { runId: string }[]; nextCursor?: string }>;
  }).listRunsPaged;
  const runs: { runId: string }[] = [];
  if (typeof paged === 'function') {
    let cursor: string | undefined;
    do {
      const page = await paged.call(journal, { limit: 500, ...(cursor ? { cursor } : {}) });
      runs.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
  } else {
    // Sayfalamayan bir adaptör: eski davranış aynen korunur (yaptığından fazlasını iddia etmemek).
    const listed = await journal.listRuns();
    runs.push(...(Array.isArray(listed) ? listed : (listed as { items: { runId: string }[] }).items));
  }
  const result: SweepResult = { scanned: 0, purged: [], keptSuspended: 0, keptNoTs: 0, deletedEntries: 0 };

  for (const r of runs) {
    result.scanned++;
    const entries = await journal.readRun(r.runId);
    const summary = summarizeRun(r.runId, entries);
    const stamps = entries.map((e) => e.ts).filter((t): t is number => t != null);
    let lastActivity = stamps.length ? Math.max(...stamps) : undefined;
    // A NAME TAG IS ALSO A RECORD, and it used to be an immortal one. A workflow/batch/network run
    // writes only an identity record to `<runId>:input` (claimIdentityInput) — enough for listRuns to
    // report the run, but `:input` is invisible to parseJournalKey so readRun hands back NOTHING.
    // Age therefore could not be measured, keptNoTs preserved it "on the safe side", and the safe
    // side turned out to be forever: the one record class that carries a subject's name (resourceId,
    // threadId, the workflow's own name) sat outside every retention window.
    // Narrow on purpose — only a record that NAMES ITSELF as identity-only (the same predicate the
    // agent door refuses on, run.ts's identityOnlyInput) is dated this way. An entry-less run with a
    // genuine frozen input is still undateable and still kept: `at` describes when the input was
    // frozen, and for a real run that is a start time, not a last activity.
    if (lastActivity === undefined) {
      const frozen = await journal.get<FrozenInputLike>(runKeys.input(r.runId));
      if (identityOnlyInput(frozen as never) && typeof frozen?.at === 'number') lastActivity = frozen.at;
    }
    if (keepSuspended && summary.status === 'suspended') {
      // FAZ-4 expiry arm: a suspended run past suspendedTtlMs stops being protected — nobody is
      // coming to approve it, and layers 2-3 made suspends routine enough that "forever" leaks.
      const expired = opts.suspendedTtlMs !== undefined && lastActivity !== undefined && now - lastActivity > opts.suspendedTtlMs;
      if (!expired) {
        result.keptSuspended++;
        continue;
      }
    }
    if (lastActivity === undefined) {
      result.keptNoTs++; // age can't be measured → safe side: preserve
      continue;
    }
    if (now - lastActivity > opts.olderThanMs || (summary.status === 'suspended' && opts.suspendedTtlMs !== undefined && now - lastActivity > opts.suspendedTtlMs)) {
      if (!(await isRealRun(journal, r.runId))) { (result.skippedGhosts ??= []).push(r.runId); continue; }
      const tomb = opts.tombstones ? await tombstoneFor(journal, r.runId, now) : undefined; // BEFORE the purge
      result.deletedEntries += await purgeRunPlan(journal, r.runId, new Set(), true, false);
      if (tomb) await journal.put(runRecordKey(r.runId, 'swept'), tomb);
      result.purged.push(r.runId);
    }
  }
  const fencesSwept = await sweepRunFences(journal, now - opts.olderThanMs);
  if (fencesSwept > 0) result.fencesSwept = fencesSwept;
  return result;
}

// ── Journal-based append-log + BasicMemory sweeping (the core-hardening review) ─────────────
// Run-focused retention (sweepRuns above) does NOT see durable-log namespaces (`${ns}:${id}`,
// e.g. studio `__audit__`/`__alert__`) or BasicMemory threads (`mem:<threadId>:*`) — these grow
// unbounded in a long-lived deployment. The two helpers below close that gap.
// Same safety philosophy as sweepRuns: a record whose age can't be measured is NOT deleted, and
// is counted in the report.

export interface LogSweepOptions {
  /** Log entries older than this (ms) are deleted. Age = the entry's `at` field (written by appendLog). */
  olderThanMs: number;
  /**
   * Consume marker key(s) belonging to the deleted entry. HONEST NOTE: in journal-based durable-log,
   * the marker schema is NOT FIXED — `consumeOnce(journal, marker)` leaves the marker key entirely up
   * to the caller (qdone/evtack-like schemas live in the WorkStore layer, see @gnldev/queue, @gnldev/events).
   * Because of this, markers can't be auto-discovered; declare your own schema via this callback
   * (e.g. `(it) => \`ack:worker1:\${it.id}\``) — the markers of every deleted entry get cleaned up too.
   */
  markerFor?: (item: LogItem) => string | string[] | undefined;
  /** Testability: "now" (default Date.now()). */
  now?: number;
}

export interface LogSweepResult {
  scanned: number;
  /** Number of deleted log entries. */
  deleted: number;
  /** Number of entries whose age couldn't be measured (and were thus preserved) because the `at` field was missing/unreadable. */
  keptNoTs: number;
  /** Number of consume-marker keys cleaned up via markerFor. */
  deletedMarkers: number;
}

/**
 * Sweeps a durable-log namespace: permanently deletes entries whose `at` (the epoch-ms written by
 * appendLog) is older than the threshold. Requires listKeys + deletePrefix (requireDelete pattern).
 * Safe side: entries without/with malformed `at` are not deleted (counted in keptNoTs).
 */
export async function sweepLog(journal: Journal, ns: string, opts: LogSweepOptions): Promise<LogSweepResult> {
  refuseUnknownNames('sweepLog', opts, SWEEP_LOG_NAMES);
  const del = requireDelete(journal);
  const list = requireListKeys(journal);
  const now = opts.now ?? Date.now();
  const prefix = `${ns}:`;
  // Ordered scan: the journal has no single-key `delete`, deletion is done via deletePrefix(fullKey).
  // A key can be a PREFIX of another key (custom ids, e.g. `approval:<runId>:<tc>` — one can be a
  // prefix of another). In lexicographic order, a key's extensions come right after it → if one of
  // the extensions is NOT going to be deleted, deletePrefix on the short key is unsafe, so that entry
  // is skipped.
  const keys = (await list(prefix)).sort();
  const result: LogSweepResult = { scanned: 0, deleted: 0, keptNoTs: 0, deletedMarkers: 0 };

  // First collect everyone's decision (expired?), then delete — so prefix-neighbor checks can see the decisions.
  const records = new Map<string, { rec: any; expired: boolean }>();
  for (const key of keys) {
    result.scanned++;
    const rec = await journal.get<any>(key);
    if (rec === undefined) continue; // vanished between scan and read → nothing to do
    const at = rec && typeof rec === 'object' ? rec.at : undefined;
    if (typeof at !== 'number' || !Number.isFinite(at)) {
      result.keptNoTs++; // age can't be measured → safe side: preserve (same philosophy as sweepRuns keptNoTs)
      continue;
    }
    records.set(key, { rec, expired: now - at > opts.olderThanMs });
  }

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const entry = records.get(key);
    if (!entry?.expired) continue;
    // Prefix-neighbor guard: don't delete if one of the neighbors that extends this key is staying.
    let unsafe = false;
    for (let j = i + 1; j < keys.length && keys[j].startsWith(key); j++) {
      if (!records.get(keys[j])?.expired) { unsafe = true; break; }
    }
    if (unsafe) continue;
    // deletePrefix(fullKey): extension-neighbors are also expired → deleting them together is
    // correct behavior; when the loop reaches them, del returns 0 → deleted isn't double-counted.
    const n = await del(key);
    result.deleted += n;
    if (n > 0 && opts.markerFor) {
      const item: LogItem = { id: entry.rec.id ?? key.slice(prefix.length), key, payload: entry.rec.payload, at: entry.rec.at };
      const markers = opts.markerFor(item);
      for (const m of Array.isArray(markers) ? markers : markers ? [markers] : []) {
        result.deletedMarkers += await del(m);
      }
    }
  }
  return result;
}

export interface ThreadSweepOptions {
  /** Threads whose last message is older than this (ms) are deleted. */
  olderThanMs: number;
  /** Testability: "now" (default Date.now()). */
  now?: number;
}

export interface ThreadSweepResult {
  scanned: number;
  /** threadIds deleted via purgeThread. */
  purged: string[];
  /** Number of threads whose age couldn't be measured (and were thus preserved) because none of their messages had a recognized ts field. */
  keptNoTs: number;
  /**
   * Threads holding `xthr:` state (dedup markers, the thread idempotency window, semantic records
   * and their vectors, tombstones, judge verdicts) with NO `mem:` sibling — so this sweep never
   * discovered them and nothing here touched them. REPORTED, NOT DELETED: see the note on
   * sweepThreads for why the sweep does not act on them by itself.
   *
   * A non-empty list is not an error. It means thread state in this journal is outliving the only
   * AGE-BASED sweep there is, and the caller has to decide what closes it — `purgeThread` per id,
   * or a deployment that keeps chat history in BasicMemory so these ids are discoverable.
   */
  orphanThreadState: string[];
  /** `xthr:` keys whose family this build does not know — see OrphanThreadState.unrecognisedKeys. */
  unrecognisedXthrKeys?: string[];
  /**
   * Threads old enough to go, kept because a run on them is still in flight (`purgeThread` takes a
   * thread's runs and refuses to pull one out from under itself). The next round takes them once the
   * run ends — or cancel it (`cancelAgentRun`) if its worker is gone.
   */
  keptInFlight?: string[];
}


/** Reads a timestamp from a message. HONEST NOTE: BasicMemory doesn't timestamp messages itself
 *  (AI SDK's ModelMessage has no ts field) — only common fields added by the caller are recognized
 *  (`ts`/`at`/`createdAt`, an epoch-ms number or a parseable date string/Date). */
function readMessageTs(msg: any): number | undefined {
  if (!msg || typeof msg !== 'object') return undefined;
  for (const field of ['ts', 'at', 'createdAt']) {
    const v = msg[field];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (v instanceof Date && Number.isFinite(v.getTime())) return v.getTime();
    if (typeof v === 'string') {
      const parsed = Date.parse(v);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

/** Thread ids the memory port knows about, off `mem:` keys. Shared so the read-only orphan listing
 *  and the sweep cannot drift into two different answers to "which threads exist". */

async function threadIdsFromMemory(
  list: NonNullable<Journal['listKeys']>,
  unrecognised?: string[],
): Promise<Set<string>> {
  const threadIds = new Set<string>();
  for (const key of await list(MEM_PREFIX)) {
    const owner = threadIdOfMemKey(key);
    const matched = owner !== undefined;
    if (owner !== undefined) threadIds.add(owner);
    // A `mem:` key this build cannot read is REPORTED, the same way an unknown `xthr:` family is.
    // The structural fix above (one shared leaf list) stops the drift at its source; this is what
    // catches a writer that built the key by hand instead of going through memKey — and rag's
    // semantic-memory does exactly that. Silence here is the expensive kind: the thread drops out of
    // the known set and its live state gets reported as an orphan, with nothing on the report saying
    // a key was skipped.
    if (!matched) unrecognised?.push(key);
  }
  return threadIds;
}

/**
 * Thread-scoped state (`xthr:`) belonging to no thread the memory port knows — and therefore to no
 * erasure request either, because `purgeResource` reaches threads through their owner and these
 * have none. A run with no `resourceId` leaves exactly this.
 *
 * READ ONLY. `sweepThreads` reports the same list but DELETES as it goes, so it cannot be called
 * just to look; this exists so `gnl doctor`, Studio, or an operator's own check can see the number
 * without touching anything. Naming what no sweep can reach is the whole point of the field — a
 * number nobody can read without risking a delete is not visible in any useful sense.
 */
export interface OrphanThreadState {
  /** Thread ids holding `xthr:` state no `mem:` record claims. */
  threadIds: string[];
  /**
   * `xthr:` keys whose FAMILY this build does not recognise, reported raw.
   *
   * `XTHR_FAMILIES` is a fixed list, so a family added later is invisible to the recovery above —
   * and invisible is the one thing this report exists not to be. Measured before this field: with a
   * known-family orphan and an unknown-family one both on disk, the report named one and the other
   * simply was not there. Raw keys rather than a guessed threadId: the family boundary is exactly
   * what is unknown here, and a threadId may contain ':' itself, so any split would be a guess
   * presented as a fact.
   */
  unrecognisedKeys: string[];
}

export async function listOrphanThreadState(journal: Journal): Promise<OrphanThreadState> {
  const list = requireListKeys(journal);
  const unrecognised: string[] = [];
  const threadIds = await threadIdsFromMemory(list, unrecognised);
  const orphans = new Set<string>();
  for (const key of await list(XTHR_PREFIX)) {
    const threadId = threadIdOfXthrKey(key);
    if (threadId === undefined) { unrecognised.push(key); continue; }
    if (!threadIds.has(threadId)) orphans.add(threadId);
  }
  return { threadIds: [...orphans], unrecognisedKeys: unrecognised };
}

/**
 * Sweeps BasicMemory and SemanticMemory threads: threads whose last message is older than the
 * threshold are permanently deleted via purgeThread (`mem:<threadId>:` prefix — messages + working
 * together; `sem:<threadId>:log`). A message is dated by its own `ts`/`at`/`createdAt`, else by when its
 * append was written (the journal log records that since 0.10 — an agent turn's messages carry no time).
 * Safe side: threads none of whose messages can be dated (no messages, or only messages appended by
 * 0.9 or earlier without a timestamp) are NOT deleted (`keptNoTs`).
 * Requires listKeys + deletePrefix (requireDelete pattern).
 *
 * THE DISCOVERY GAP, reported rather than silently closed (`orphanThreadState`).
 *
 * This is the only AGE-BASED sweep for thread state, and it finds threads by listing `mem:`. A
 * deployment that keeps chat history elsewhere — its own database, `@gnldev/memory`'s observational
 * store, or nothing at all because it uses `threadId` purely for idempotency — writes no `mem:` keys,
 * so its threads are not in that list. Measured: a run with a threadId and no BasicMemory left two
 * `xthr:` records (a dup marker and a semantic record carrying its canonical sentence) and this
 * function returned `{scanned: 0, purged: [], keptNoTs: 0}` — "nothing to do", not "I could not see
 * it". Unmeasured and clean produced the same numbers, which is the shape this field removes.
 *
 * It does NOT delete them, and that is a decision rather than an omission:
 *  - `purgeThread` takes `mem:` WITH `xthr:`, so sweeping a discovered-by-xthr thread on ITS age
 *    could delete chat history that is younger than the dedup state beside it.
 *  - Deleting more data than a previous version did is the one change a minor upgrade must not make
 *    on its own. The equivalent surprise on the question side is why the rule ladder is opt-in.
 *  - Ages here are not comparable: a `mem:` thread ages by its last MESSAGE, `xthr:` records age by
 *    their own `at` stamps, and picking one for the other is a policy the caller owns.
 *
 * TWO THINGS THIS LIST IS ALSO THE SIGNAL FOR, both measured:
 *  - `ttlMs` on `sideEffectDuplicates` is a READ-SIDE filter (an expired record stops being a
 *    candidate); it deletes nothing. A short ttl is not a retention policy.
 *  - `purgeResource` (the person-erasure surface) finds threads through the person's RUNS. Once
 *    those runs have been swept by `sweepRuns`, the threadId is no longer reachable and the
 *    erasure silently leaves this state behind. Measured: sweepRuns then purgeResource deleted 1 key
 *    and left the thread's canonical sentence in place; purgeResource alone cleared it.
 *    So erase people BEFORE their runs age out, or carry the thread ids yourself.
 */
export async function sweepThreads(journal: Journal, opts: ThreadSweepOptions): Promise<ThreadSweepResult> {
  refuseUnknownNames('sweepThreads', opts, SWEEP_THREADS_NAMES);
  requireDelete(journal);
  const list = requireListKeys(journal);
  const now = opts.now ?? Date.now();

  // Extract the thread set from keys under `mem:`. Keys with unrecognized suffixes don't contribute
  // a threadId to the set (safe: only the recognized schema is swept), but if they belong to a
  // recognized thread they still go with it via purgeThread's prefix delete.
  const threadIds = await threadIdsFromMemory(list);
  // SemanticMemory's threads (@gnldev/rag) keep their messages in `sem:<threadId>:log` — a thread with
  // only that log is a thread too, and its messages date it.
  for (const key of await list(SEMANTIC_LOG_PREFIX)) {
    const t = threadIdOfSemKey(key);
    if (t !== undefined) threadIds.add(t);
  }

  const result: ThreadSweepResult = { scanned: 0, purged: [], keptNoTs: 0, orphanThreadState: [] };
  for (const threadId of threadIds) {
    result.scanned++;
    // Each message is dated by its own timestamp, else by when its append was written (the log
    // records that — an agent turn's messages carry no time of their own). Keys come from the same
    // builders the memories write with; an id they refuse is not read, and so not dated: kept.
    const dated = async <T>(key: () => string, message: (e: T) => unknown) => {
      let k: string;
      try { k = key(); } catch { return []; }
      return (await readJournalLogDated<T>(journal, k)).map(({ entry, appendedAt }) => readMessageTs(message(entry)) ?? appendedAt);
    };
    const stamps = [
      ...(await dated<unknown>(() => memKey(threadId, 'messages'), (m) => m)),
      ...(await dated<{ message?: unknown }>(() => semanticLogKey(threadId), (e) => e?.message)),
    ].filter((t): t is number => t !== undefined);
    if (stamps.length === 0) {
      result.keptNoTs++; // age can't be measured → safe side: preserve
      continue;
    }
    const lastActivity = Math.max(...stamps);
    if (now - lastActivity > opts.olderThanMs) {
      // A thread delete takes its runs (model.ts), so a thread with a run still executing is kept for a
      // later round rather than pulled out from under it — named, not silently skipped.
      try {
        await purgeThreadPlan(journal, threadId, {}, false);
      } catch (e) {
        if (!(e instanceof ThreadRunsInFlightError)) throw e;
        (result.keptInFlight ??= []).push(threadId);
        continue;
      }
      result.purged.push(threadId);
    }
  }

  // AFTER the sweep, so a thread this round just purged is not reported as orphaned. What is left
  // under `xthr:` with no `mem:` sibling is state no age-based sweep can reach.
  const orphans = new Set<string>();
  const unrecognisedXthr: string[] = [];
  for (const key of await list(XTHR_PREFIX)) {
    const threadId = threadIdOfXthrKey(key);
    if (threadId === undefined) { unrecognisedXthr.push(key); continue; }
    if (!threadIds.has(threadId)) orphans.add(threadId);
  }
  result.orphanThreadState = [...orphans];
  if (unrecognisedXthr.length) result.unrecognisedXthrKeys = unrecognisedXthr;
  return result;
}

// ── Phase 8.3: opt-in automatic retention scheduling ────────────────────────────────────────
// sweepRuns/sweepLog/sweepThreads/compact were all called MANUALLY (from Studio or a script) —
// none of them were triggered automatically. The helper below sets up a periodic sweep round
// using @gnldev/durable/polling's createPollLoop (the SAME scheduler core SHARED with queue/events/scheduler).
// It does NOT start anything AUTOMATICALLY — the user must explicitly call `start()`.

export interface LogSweepTarget extends LogSweepOptions {
  /** The durable-log namespace to sweep (appendLog's first argument, e.g. `__audit__`). */
  ns: string;
}

export interface RetentionSweeperOptions {
  /** Sweep round interval (ms). Default 1 hour — retention isn't urgent, no need for frequent scans. */
  intervalMs?: number;
  /** Options passed to sweepRuns (olderThanMs required). */
  sweep: SweepOptions;
  /**
   * If given, sweepLog also runs after sweepRuns on every round (a single namespace or an array
   * for multiple namespaces — e.g. `__audit__` + `__alert__` can be swept in the same round).
   */
  logSweep?: LogSweepTarget | LogSweepTarget[];
  /** An error from a round (sweepRuns or sweepLog) is reported here — the chain doesn't die, the next round retries. */
  onError?: (err: unknown) => void;
}

export interface RetentionSweepSummary {
  /** Number of runs deleted via purgeRun this round. */
  purgedRuns: number;
  /** Total number of log entries deleted this round (if logSweep was given). */
  deletedLog: number;
}

export interface RetentionSweeper extends PollLoop {
  /** A single manual sweep round (tests / manual trigger) — can be called without waiting on start(). */
  runOnce(): Promise<RetentionSweepSummary>;
}

/**
 * Opt-in periodic retention sweeper: runs `sweepRuns` (+ `sweepLog` if given) at `intervalMs`
 * intervals. Uses createPollLoop with backoff DISABLED — retention should have a fixed cadence;
 * postponing the next round (backoff growth) just because "nothing was deleted this round" would
 * go against retention's purpose (we don't want a delayed scan of data accumulated after a long
 * quiet period). It does NOT start anything AUTOMATICALLY — no scan happens until the returned
 * object's `start()` is called.
 */
export function createRetentionSweeper(
  journal: Journal & Partial<JournalReader>,
  opts: RetentionSweeperOptions,
): RetentionSweeper {
  refuseUnknownNames('createRetentionSweeper', opts, RETENTION_SWEEPER_NAMES);
  refuseUnknownNames('createRetentionSweeper: sweep', opts.sweep, SWEEP_RUNS_NAMES);
  for (const t of [opts.logSweep ?? []].flat()) refuseUnknownNames('createRetentionSweeper: logSweep', t, LOG_SWEEP_TARGET_NAMES);
  const intervalMs = opts.intervalMs ?? 60 * 60_000;
  const logTargets = opts.logSweep ? (Array.isArray(opts.logSweep) ? opts.logSweep : [opts.logSweep]) : [];

  async function runOnce(): Promise<RetentionSweepSummary> {
    let purgedRuns = 0;
    let deletedLog = 0;
    try {
      const res = await sweepRuns(journal, opts.sweep);
      purgedRuns = res.purged.length;
    } catch (err) {
      opts.onError?.(err);
    }
    for (const target of logTargets) {
      try {
        const { ns, ...logOpts } = target;
        const res = await sweepLog(journal as Journal, ns, logOpts);
        deletedLog += res.deleted;
      } catch (err) {
        opts.onError?.(err);
      }
    }
    return { purgedRuns, deletedLog };
  }

  const loop = createPollLoop(
    async () => {
      const summary = await runOnce();
      return summary.purgedRuns + summary.deletedLog > 0;
    },
    { pollMs: intervalMs, backoff: false },
  );

  return { runOnce, start: loop.start, stop: loop.stop };
}
