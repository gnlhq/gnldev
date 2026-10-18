// WHAT A STORE STILL HAS IN HAND — what `gnl pending` and `gnl upgrade` show before a shutdown or an
// upgrade (Karar 2.2), in three groups:
//
//   · in doubt — a side-effecting tool call that started and has no outcome (no result and no late report:
//     `readCallOutcome`, the call's one reader), and whose process is gone:
//     its effect may have happened. BLOCKS: another version continuing the run would decide it under
//     its own code. The tool's recover() is asked first; what it cannot answer, an operator decides —
//     done (recorded as their declaration), the run canceled, or finished by the version that started it.
//   · running — work a live process is executing now (a run's step, a tool body, a queue job, a
//     scheduler fire). BLOCKS until it ends or is canceled; `--wait` waits for it. Read from what a
//     process HOLDS — the same set its drain waits for (process-liveness.ts `heldUnits`: this process's
//     own, and the shadows of the live others) — and from the running tool claims and executor records.
//   · awaiting approval — a run suspended on a human's answer. Does NOT block: nothing is executing, and
//     the new version asks the same question.
//
// Read every time it is asked: the list a decision was made on is never reused.
import { runRecordPrefix } from './run-id-grammar.js';
import type { Journal, ToolJournalRecord } from './journal.js';
import { listRunsArray } from './journal.js';
import type { RunSummary } from './journal.js';
import { withOrg, withRootScope, registeredOrganizations } from './organization.js';
import { execKey } from './exec-record.js';
import { claimIsLive } from './liveness.js';
import { holderAlive, heldUnits } from './process-liveness.js';
import { journalNow } from './liveness.js';
import { compareAndSet } from './attempt.js';
import { stampFormat, upgradeFormat } from './format.js';
import { callsFromModelSteps } from './compensation.js';
import { windowClaimPointerKey } from './model.js';
import { idempotencyKeyOf } from './durable-tool.js';
import { cancelAgentRun } from './cancel.js';
import { readCallOutcome } from './call-outcome.js';

/** A side-effecting call that started, has no outcome, and has no live process holding it. */
export interface InDoubtCall {
  /** The organization, or absent for the root. */
  scope?: string;
  runId: string;
  agent?: string;
  /** The key its record lives under (in its scope's view). */
  key: string;
  toolCallId?: string;
  toolName?: string;
  /** 'running': it stopped mid-body; 'failed': it failed after its body may have reached the effect. */
  status: 'running' | 'failed';
  attempts: number;
  /** The key the call carried downstream (its record's), when the record holds it. */
  idempotencyKey?: string;
  /** The arguments the model gave it, from the run's model step. */
  input?: unknown;
  /** The record as read — a decision is written only over this exact record. */
  readonly record: ToolJournalRecord;
}

export interface RunningWork {
  scope?: string;
  runId: string;
  agent?: string;
  /** What is executing: the run's step, or a named tool body. */
  what: string;
  /** The process holding it (its liveness id), when the record names one — what an operator checks or stops. */
  holder?: string;
  /** Since when it has been held (ms since the epoch), when the record says. */
  since?: number;
}

export interface AwaitingApproval {
  scope?: string;
  runId: string;
  agent?: string;
  toolCallId?: string;
  toolName?: string;
}

export interface PendingWork {
  inDoubt: InDoubtCall[];
  running: RunningWork[];
  awaitingApproval: AwaitingApproval[];
  /** Whether anything blocks a shutdown or an upgrade (in doubt or running). */
  blocking: boolean;
}

/** A claim written before claims carried their own TTL is judged by this. */
const FALLBACK_CLAIM_TTL_MS = 30_000;

interface Scope { scope?: string; view: Journal }

async function scopesOf(journal: Journal): Promise<Scope[]> {
  const orgs = await registeredOrganizations(journal);
  return [
    { view: orgs.length ? withRootScope(journal) : journal },
    ...orgs.map((scope) => ({ scope, view: withOrg(journal, scope) as Journal })),
  ];
}

async function openRuns(view: Journal): Promise<RunSummary[]> {
  const paged = (view as { listRunsPaged?: (q: { statuses: string[]; cursor?: string }) => Promise<{ items: RunSummary[]; nextCursor?: string }> }).listRunsPaged;
  if (typeof paged === 'function') {
    const out: RunSummary[] = [];
    let cursor: string | undefined;
    do {
      const page = await paged.call(view, { statuses: ['running', 'suspended'], ...(cursor ? { cursor } : {}) });
      out.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return out;
  }
  if (typeof (view as { listRuns?: unknown }).listRuns !== 'function') return [];
  return (await listRunsArray(view as never)).filter((r) => r.status === 'running' || r.status === 'suspended');
}

/** Every record of a run's tool calls, by the key it is authoritative under, with the call's id. */
async function toolRecordsOf(view: Journal, runId: string): Promise<Array<{ key: string; toolCallId?: string; rec: ToolJournalRecord }>> {
  const out: Array<{ key: string; toolCallId?: string; rec: ToolJournalRecord }> = [];
  const toolPrefix = runRecordPrefix(runId, 'tool');
  const pointerPrefix = windowClaimPointerKey(runId, '');
  for (const k of [...(await view.listKeys(pointerPrefix)), ...(await view.listKeys(toolPrefix))]) {
    if (k.startsWith(pointerPrefix)) {
      // A claim held under a window points at it from the run (durable-tool.ts pointAtWindowClaim).
      const ptr = await view.get<{ claim?: unknown }>(k);
      if (typeof ptr?.claim !== 'string') continue;
      const rec = upgradeFormat(await view.get<ToolJournalRecord>(ptr.claim), ptr.claim);
      if (rec) out.push({ key: ptr.claim, toolCallId: k.slice(pointerPrefix.length), rec });
      continue;
    }
    if (!k.startsWith(toolPrefix)) continue;
    const rec = upgradeFormat(await view.get<ToolJournalRecord>(k), k);
    // A mirror stands for a record that lives under a window — read there, through its pointer.
    if (!rec || rec.mirrorOf !== undefined) continue;
    const suffix = k.slice(toolPrefix.length);
    out.push({ key: k, ...(suffix.startsWith('args-') ? {} : { toolCallId: suffix }), rec });
  }
  // A window claim is reached through its pointer and, once settled, its mirror: one entry per key.
  const seen = new Set<string>();
  return out.filter((e) => (seen.has(e.key) ? false : (seen.add(e.key), true)));
}

/** Lists what the store still has in hand (see the head of this file). Reads; writes nothing. */
export async function pendingWork(journal: Journal): Promise<PendingWork> {
  const out: PendingWork = { inDoubt: [], running: [], awaitingApproval: [], blocking: false };
  const now = await journalNow(journal);
  // What processes hold now — a run in its model step, a job its worker runs, a fire. A run listed below
  // from its own records (a tool body, the executor) is not listed twice.
  const held = new Map((await heldUnits(journal)).map((u) => [`${u.scope ?? ''}\u0000${u.name}`, u] as const));
  for (const { scope, view } of await scopesOf(journal)) {
    for (const run of await openRuns(view)) {
      const at = { ...(scope !== undefined ? { scope } : {}), runId: run.runId, ...(run.agent ? { agent: run.agent } : {}) };
      const tools = await toolRecordsOf(view, run.runId);
      if (run.status === 'suspended') {
        const asked = tools.filter((t) => t.rec.status === 'suspended');
        if (!asked.length) out.awaitingApproval.push(at);
        for (const t of asked) out.awaitingApproval.push({ ...at, ...(t.toolCallId ? { toolCallId: t.toolCallId } : {}), ...(t.rec.toolName ? { toolName: t.rec.toolName } : {}) });
        continue;
      }
      let calls: Map<string, { input: unknown; toolName?: string }> | undefined;
      const callOf = async (id: string | undefined) => {
        if (!id || typeof (view as { readRun?: unknown }).readRun !== 'function') return undefined;
        calls ??= callsFromModelSteps(await (view as unknown as { readRun(r: string): Promise<{ kind: string; value: unknown }[]> }).readRun(run.runId));
        return calls.get(id);
      };
      let busy = false;
      for (const t of tools) {
        const r = t.rec;
        if (r.status === 'running' && (await claimIsLive(r, now, FALLBACK_CLAIM_TTL_MS, view))) {
          const stamp = r as { proc?: unknown; startedAt?: unknown };
          out.running.push({
            ...at, what: `tool '${r.toolName ?? (await callOf(t.toolCallId))?.toolName ?? '?'}' is running`,
            ...(typeof stamp.proc === 'string' ? { holder: stamp.proc } : {}),
            ...(typeof stamp.startedAt === 'number' ? { since: stamp.startedAt } : {}),
          });
          busy = true;
          continue;
        }
        const inDoubt = r.status === 'running' || (r.status === 'failed' && r.sideEffect === true);
        if (!inDoubt) continue;
        // Read through the call's one reader (call-outcome.ts): a late report beside the record says the
        // body finished — the effect HAPPENED, and the run continues from it. Not a decision to ask for.
        if ((await readCallOutcome(view, t.key)).effect.state === 'happened') continue;
        const call = await callOf(t.toolCallId);
        out.inDoubt.push({
          ...at, key: t.key, status: r.status as 'running' | 'failed', attempts: (r as { attempts?: number }).attempts ?? 1,
          ...(t.toolCallId ? { toolCallId: t.toolCallId } : {}),
          ...((r.toolName ?? call?.toolName) ? { toolName: r.toolName ?? call?.toolName } : {}),
          ...(idempotencyKeyOf(r) ? { idempotencyKey: idempotencyKeyOf(r) } : {}),
          ...(call ? { input: call.input } : {}),
          record: r,
        });
      }
      if (busy) { held.delete(`${scope ?? ''}\u0000${run.runId}`); continue; }
      // A run on the executor: running while its process is (detached.ts). The record is the platform's.
      const exec = await journal.get<{ status?: string; owner?: unknown; at?: unknown }>(execKey(scope, run.runId));
      // A process that cannot be asked about (no liveness here) counts as alive: the safe side blocks.
      if (exec?.status === 'running' && (await holderAlive(exec.owner, journal)) !== false) {
        held.delete(`${scope ?? ''}\u0000${run.runId}`);
        out.running.push({
          ...at, what: 'the run is executing',
          ...(typeof exec.owner === 'string' ? { holder: exec.owner } : {}),
          ...(typeof exec.at === 'number' ? { since: exec.at } : {}),
        });
      }
    }
  }
  for (const u of held.values()) {
    out.running.push({
      ...(u.scope !== undefined ? { scope: u.scope } : {}), runId: u.name, what: u.what,
      ...(u.holder !== undefined ? { holder: u.holder } : {}), ...(u.since !== undefined ? { since: u.since } : {}),
    });
  }
  out.blocking = out.inDoubt.length > 0 || out.running.length > 0;
  return out;
}

/** The view a call's record is written through. */
async function viewOf(journal: Journal, scope: string | undefined): Promise<Journal> {
  if (scope === undefined) return (await registeredOrganizations(journal)).length ? withRootScope(journal) : journal;
  return withOrg(journal, scope) as Journal;
}

/** Writes `next` over the call's record only if it is still the record the decision was made on. */
async function overTheSame(journal: Journal, call: InDoubtCall, next: ToolJournalRecord): Promise<boolean> {
  const view = await viewOf(journal, call.scope);
  const raw = await view.get<ToolJournalRecord>(call.key);
  const cur = upgradeFormat(raw, call.key) as { status?: string; startedAt?: number; attempts?: number } | undefined;
  const was = call.record as { status?: string; startedAt?: number; attempts?: number };
  if (!cur || cur.status !== was.status || cur.startedAt !== was.startedAt || cur.attempts !== was.attempts) return false;
  const labelled = idempotencyKeyOf(raw) ? { ...next, idempotencyKey: idempotencyKeyOf(raw) } : next;
  return compareAndSet(view, call.key, raw, stampFormat(labelled));
}

/**
 * Asks the tool's `recover()` whether the call's effect happened — with the key the call carried.
 * 'happened': its output is recorded as the call's result (the run continues from it, as the engine's
 * own recover path does). 'not-happened': nothing is written; the run re-runs the call when it
 * continues, which is safe. 'unknown': no recover(), it threw, or it answered in a shape it may not.
 * 'moved': the record changed since it was listed — list again.
 *
 * @internal — `gnl pending`'s action on an item it listed.
 */
export async function recoverInDoubt(
  journal: Journal,
  call: InDoubtCall,
  tool: { recover?: (input: unknown, opts: { idempotencyKey: string; toolCallId: string }) => Promise<unknown> } | undefined,
): Promise<'happened' | 'not-happened' | 'unknown' | 'moved'> {
  if (typeof tool?.recover !== 'function' || !call.idempotencyKey) return 'unknown';
  let probe: unknown;
  try {
    probe = await tool.recover(call.input, { idempotencyKey: call.idempotencyKey, toolCallId: call.toolCallId ?? '' });
  } catch {
    return 'unknown';
  }
  const p = probe as { done?: unknown; output?: unknown } | null | undefined;
  if (p?.done === false) return 'not-happened';
  if (p?.done !== true || !('output' in p)) return 'unknown';
  const ok = await overTheSame(journal, call, { status: 'succeeded', output: p.output, ...(call.toolName ? { toolName: call.toolName } : {}), ...(call.toolCallId ? { resolvedToolCallIds: [call.toolCallId] } : {}) });
  return ok ? 'happened' : 'moved';
}

/**
 * An operator's declaration that the call's effect happened. Recorded as the call's result, with who
 * declared it and when (`declaredBy`) — the run continues from it as from any result. False when the
 * record changed since it was listed.
 *
 * @internal — `gnl pending`'s action on an item it listed.
 */
export async function declareInDoubtDone(
  journal: Journal,
  call: InDoubtCall,
  declaration: { by: string; note?: string; output?: unknown },
): Promise<boolean> {
  const at = Date.now();
  const output = declaration.output ?? { declaredDone: true, by: declaration.by, ...(declaration.note ? { note: declaration.note } : {}) };
  return overTheSame(journal, call, {
    status: 'succeeded', output, ...(call.toolName ? { toolName: call.toolName } : {}),
    ...(call.toolCallId ? { resolvedToolCallIds: [call.toolCallId] } : {}),
    declaredBy: { by: declaration.by, at, ...(declaration.note ? { note: declaration.note } : {}) },
  } as ToolJournalRecord);
}

/** Cancels the run a pending item belongs to (durably: a process executing it stops at its next boundary). *
 * @internal — `gnl pending`'s action; a host cancels with `cancelAgentRun`.
 */
export async function cancelPendingRun(journal: Journal, item: { scope?: string; runId: string }, reason?: string): Promise<void> {
  await cancelAgentRun(await viewOf(journal, item.scope), item.runId, reason ? { reason } : {});
}
