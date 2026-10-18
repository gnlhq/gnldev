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
 *    a read that FAILS there is not "not deleted": the completion is not written (run.ts);
 *  - and once more after its LAST write (`settleErasedRun`): fenced, it takes back the turn it
 *    appended to its thread (`Memory.retract`, by the run's own batch markers) and deletes its own
 *    footprint again, exactly as the deletion did.
 * The fence is written first and read last, so a write of the worker's either precedes the deletion
 * (and goes with it) or is followed by a read that sees the fence (and is taken back by the worker
 * itself). That holds on every store where a read sees every write that completed before it — all
 * three shipped here — and for every write the worker can name: its own run's keys, the turn it
 * appended (named by `mem-appended:<runId>` / `mem-user-appended:<runId>`), the window records it
 * executed (named by its tool records, `executedHere`), its usage (its counted marker).
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
 * Before this the turn's messages were the exception: written in the moment between the worker's last
 * read of the fence and the deletion, they stayed in the deleted thread for good — the worker settled
 * its run away, so `subjectRuns` answered `[]` and a second erasure deleted nothing (c-erasure CE-2).
 *
 * NOT COVERED, stated: a `Memory` without `retract` (a custom one) keeps such a turn; a journal log that
 * the retraction empties stays as an empty log under the thread's key (no message in it — deleting the
 * key could not be compared, and an append landing meanwhile would go with it); the shared counters a
 * worker incremented before its settle (usage is subtracted again; the metrics aggregates — counts, no
 * content — are not, as for any deleted run; after an organization's purge they are that organization's
 * counter rows again); and a worker that dies between its write and its settle leaves that write, as it
 * leaves any write it never got to settle.
 */
import { createHash } from 'node:crypto';
import type { Journal } from './journal.js';
import { orgParentOf, orgScopeOf, orgPrefix, ORG_RECORD_PRE } from './organization.js';

/** The family every run fence lives under. */
export const RUN_FENCE_PREFIX = '__run_erased__:';

/** The fence of one run: a hash of its id, never the id itself. */
export const runFenceKey = (runId: string): string => `${RUN_FENCE_PREFIX}${createHash('sha256').update(runId).digest('hex')}`;

/** Marks when an org id was last purged; an org-scoped audit view starts after this, and a worker of the organization that was running when it changed stops. */
export function orgPurgedKey(orgId: string): string {
  return `__org_purged__:${orgId}`;
}

/**
 * The run was deleted: thrown by a worker whose run was deleted while it ran, and by the birth of an id a
 * deletion fenced (`claimRunOwner`, and the doors that accept work under a caller-chosen run id before
 * it is born). Not a failure of the run: nothing is recorded for it. The message holds for both — the
 * error reaches a job or a trigger that never ran again, and "while it was running" told them it had.
 */
export class RunErasedError extends Error {
  readonly code = 'run_erased';
  constructor(readonly runId: string) {
    super(`run '${runId}' was deleted — nothing more of it is written, and it cannot be started or resumed again; start the work under a new runId`);
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
 *
 * `lineage`: the run that made this one (its recorded `parentRunId` — a sub-agent's delegating run, a
 * background task's or continuation's turn). A run made by a deleted run is deleted with it: its
 * parent's fence fences it too. Without it a child born after the deletion planned its parent's
 * children (the plan reads the parent's tool records first, then fences) had no fence of its own and
 * ran — its effect for a person who is gone, its answer into their deleted thread.
 */
export interface ErasureBaseline { orgMark?: string; lineage?: string[] }

function orgMarkOf(value: unknown): string {
  const v = value as { at?: unknown; n?: unknown } | undefined;
  return v === undefined ? '' : `${String(v.at)}:${String(v.n ?? '')}`;
}

/** Read once at a run's entry; carried to every later check of the same attempt. `parentRunId`: see `lineage`. */
export async function erasureBaseline(journal: Journal, parentRunId?: string): Promise<ErasureBaseline> {
  const org = orgScopeOf(journal);
  const root = orgParentOf(journal);
  const lineage = parentRunId !== undefined ? { lineage: [parentRunId] } : {};
  if (org === undefined || !root?.get) return lineage;
  return { orgMark: orgMarkOf(await root.get(orgPurgedKey(org))), ...lineage };
}

/** Whether this run was deleted since the attempt started: its own fence, its parent's, or its organization's purge. */
export async function runErasedSince(journal: Journal, runId: string, baseline: ErasureBaseline | undefined): Promise<boolean> {
  const org = orgScopeOf(journal);
  const root = orgParentOf(journal);
  const [fences, mark] = await Promise.all([
    Promise.all([runId, ...(baseline?.lineage ?? [])].map((id) => journal.get(runFenceKey(id)))),
    baseline?.orgMark !== undefined && org !== undefined && root?.get ? root.get(orgPurgedKey(org)) : Promise.resolve(undefined),
  ]);
  if (fences.some((f) => f !== undefined)) return true;
  return baseline?.orgMark !== undefined && org !== undefined && orgMarkOf(mark) !== baseline.orgMark;
}

/**
 * A run deleted THROUGH its parent has no fence of its own: its settle writes one, so every other reader
 * of the run — its executor, a follower, a later admission, a sweep — refuses it by its own id.
 */
export async function fenceThroughLineage(journal: Journal, runId: string, baseline: ErasureBaseline | undefined): Promise<void> {
  if (!baseline?.lineage?.length || (await journal.get(runFenceKey(runId))) !== undefined) return;
  const parents = await Promise.all(baseline.lineage.map((id) => journal.get(runFenceKey(id))));
  if (parents.some((f) => f !== undefined)) await fenceRun(journal, runId);
}

/** Throws `RunErasedError` when the run was deleted since the attempt started. */
export async function assertNotErased(journal: Journal, runId: string, baseline: ErasureBaseline | undefined): Promise<void> {
  if (await runErasedSince(journal, runId, baseline)) throw new RunErasedError(runId);
}

/**
 * Retention for fences: those written before `cutoff` (epoch ms) go. Returns how many.
 *
 * In the scope `sweepRuns` sweeps: an organization's view, its own; the ROOT, its own and every
 * registered organization's (`__org__:<id>`) — the root sweep already takes those organizations' runs
 * (a root journal lists them), and their fences outlived them (measured, c-erasure CE-5). An
 * organization that was never registered keeps its fences until a sweep through its own view.
 */
export async function sweepRunFences(journal: Journal, cutoff: number): Promise<number> {
  const scopes = [''];
  if (orgScopeOf(journal) === undefined) {
    for (const rec of await journal.listKeys(ORG_RECORD_PRE)) {
      const orgId = rec.slice(ORG_RECORD_PRE.length);
      if (orgId && !orgId.includes(':')) scopes.push(orgPrefix(orgId));
    }
  }
  let n = 0;
  for (const scope of scopes) {
    for (const key of await journal.listKeys(`${scope}${RUN_FENCE_PREFIX}`)) {
      const v = await journal.get<{ at?: unknown }>(key);
      // A fence key is a fixed-length hash: no other fence extends it, so the prefix delete is exact.
      if (v !== undefined && typeof v.at === 'number' && v.at < cutoff) n += await journal.deletePrefix(key);
    }
  }
  return n;
}
