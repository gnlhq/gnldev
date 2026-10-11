/**
 * WHAT A DELETED RUN LEAVES BEHIND, so the worker still running it cannot write it back.
 *
 * A deletion takes what is there when it runs. A worker of the run may still be alive: the erasure
 * order (cancel, wait until `subjectRuns` says nothing is in flight, erase) cannot see one that holds
 * no claim — a call answered by a record — and the deletion took the run's cancel flag with the rest.
 * Measured before this existed (k3-audit/N1): the canceled worker went on, ran the same payment a
 * second time (the window record and the duplicate marker were gone too) and wrote the run back —
 * model steps, outcome `completed`, metrics, and the mirror holding the person's IBAN. A thread
 * deletion and an organization's purge pull a run out from under its worker the same way.
 *
 * THE FENCE. Every deletion of a run (model.ts `executePlan`) writes `__run_erased__:<sha256(runId)>`
 * BEFORE it deletes anything of the run; an organization's purge writes its purge marker before its
 * prefix delete. A worker reads them:
 *  - where it already reads its cancel flag — at its entry and before every fresh model step — and
 *    before a side effect executes: it stops there (`RunErasedError`), and writes nothing more;
 *  - before the writes that land outside its own run (its turn's messages in the thread's memory);
 *  - and once more after its LAST write (`settleErasedRun`): fenced, it deletes its own footprint
 *    again, exactly as the deletion did.
 * The fence is written first and read last, so a write of the worker's into its own run either
 * precedes the deletion (and goes with it) or is followed by a read that sees the fence (and is
 * deleted by the worker itself). That holds on every store where a read sees every write that
 * completed before it — all three shipped here.
 *
 * WHAT IT HOLDS. Nothing of anyone: `{ erased: true, at }`, under a HASH of the run id — a run id can
 * name its owner (an owned job's is `job:~o~<org>:<user>:…`), and this record outlives the person.
 * The hash is a pseudonym, not an anonymisation: whoever already knows a run id can tell it was
 * deleted. Under an organization it sits in the organization's partition (`withOrg` prefixes it).
 *
 * HOW LONG. A fenced run id stays refused (like a canceled one: a run that was deleted under a live
 * worker is not resumed). `sweepRuns` removes fences older than its `olderThanMs` — the same horizon
 * after which it treats a run as abandoned — and `purgeOrganization` takes an organization's with
 * the rest of its partition. Retention's own deletions write no fence: they delete runs idle for
 * longer than that horizon.
 *
 * NOT COVERED, stated: what a worker writes OUTSIDE its run between its last read of the fence and the
 * deletion's write of it — a thread-window record, a turn's messages, a cross-run record. That window
 * is one read and one write wide at each of those points (it is no longer the length of a model call).
 */
import { createHash } from 'node:crypto';
import type { Journal } from './journal.js';
import { orgParentOf, orgScopeOf } from './organization.js';

/** The family every run fence lives under. */
export const RUN_FENCE_PREFIX = '__run_erased__:';

/** The fence of one run: a hash of its id, never the id itself. */
export const runFenceKey = (runId: string): string => `${RUN_FENCE_PREFIX}${createHash('sha256').update(runId).digest('hex')}`;

/** Marks when an org id was last purged; an org-scoped audit view starts after this, and a worker of the organization that was running when it changed stops. */
export function orgPurgedKey(orgId: string): string {
  return `__org_purged__:${orgId}`;
}

/** Thrown by a worker whose run was deleted while it ran. Not a failure of the run: nothing is recorded for it. */
export class RunErasedError extends Error {
  readonly code = 'run_erased';
  constructor(readonly runId: string) {
    super(`run '${runId}' was deleted while it was running — nothing more of it is written, and it cannot be resumed; start the work again under a new runId`);
    this.name = 'RunErasedError';
  }
}

/** Written by every deletion of a run, BEFORE it deletes anything of it. */
export async function fenceRun(journal: Journal, runId: string): Promise<void> {
  const at = journal.now ? await journal.now() : Date.now();
  await journal.put(runFenceKey(runId), { erased: true, at });
}

/**
 * What a worker remembers at its entry: the purge marker of its organization as it was then. A purge
 * while it runs changes it; an organization purged BEFORE the run started is a new tenancy, and its
 * runs are not stopped by the old purge. `undefined` outside organizations.
 */
export interface ErasureBaseline { orgMark?: string }

function orgMarkOf(value: unknown): string {
  const v = value as { at?: unknown; n?: unknown } | undefined;
  return v === undefined ? '' : `${String(v.at)}:${String(v.n ?? '')}`;
}

/** Read once at a run's entry; carried to every later check of the same attempt. */
export async function erasureBaseline(journal: Journal): Promise<ErasureBaseline> {
  const org = orgScopeOf(journal);
  const root = orgParentOf(journal);
  if (org === undefined || !root?.get) return {};
  return { orgMark: orgMarkOf(await root.get(orgPurgedKey(org))) };
}

/** Whether this run was deleted since the attempt started: its own fence, or its organization's purge. */
export async function runErasedSince(journal: Journal, runId: string, baseline: ErasureBaseline | undefined): Promise<boolean> {
  const org = orgScopeOf(journal);
  const root = orgParentOf(journal);
  const [fence, mark] = await Promise.all([
    journal.get(runFenceKey(runId)),
    baseline?.orgMark !== undefined && org !== undefined && root?.get ? root.get(orgPurgedKey(org)) : Promise.resolve(undefined),
  ]);
  if (fence !== undefined) return true;
  return baseline?.orgMark !== undefined && org !== undefined && orgMarkOf(mark) !== baseline.orgMark;
}

/** Throws `RunErasedError` when the run was deleted since the attempt started. */
export async function assertNotErased(journal: Journal, runId: string, baseline: ErasureBaseline | undefined): Promise<void> {
  if (await runErasedSince(journal, runId, baseline)) throw new RunErasedError(runId);
}

/** Retention for fences: those written before `cutoff` (epoch ms) go. Returns how many. */
export async function sweepRunFences(journal: Journal, cutoff: number): Promise<number> {
  if (typeof journal.listKeys !== 'function' || typeof journal.deletePrefix !== 'function') return 0;
  let n = 0;
  for (const key of await journal.listKeys(RUN_FENCE_PREFIX)) {
    const v = await journal.get<{ at?: unknown }>(key);
    // A fence key is a fixed-length hash: no other fence extends it, so the prefix delete is exact.
    if (v !== undefined && typeof v.at === 'number' && v.at < cutoff) n += await journal.deletePrefix(key);
  }
  return n;
}
