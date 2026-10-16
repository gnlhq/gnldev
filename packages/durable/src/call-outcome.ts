// WHAT HAPPENED TO A TOOL CALL — the one reader of a call's records, and the one writer of its late reports.
//
// A call has two kinds of record: its RECORD (`<runId>:tool:<suffix>`, or a window's `xreq:`/`xthr:`/
// `xrun:` record that several runs reach), and the LATE REPORTS kept beside it (`runKeys.lateOf`): an
// attempt that finished its body after it lost the call (attempt.ts) could not write the record, and kept
// its success there instead. Before this module each decision read its own subset: the claim loop read
// the late reports under its OWN run and call id (so another run reaching the same window record never
// saw them), the unwind read the record alone (a call whose effect a late report proves was 'uncertain';
// a background call's launcher answer was taken for the effect), and the late write ignored the erasure
// fence (release audit B: B5, B6, and its window hypothesis). The rules, once:
//
//   READ — `readCallOutcome`: the record and every late report, by the record's key. Its EFFECT:
//     1. a success record: the effect happened, with the record's output;
//     2. a late report beside any other record: the effect happened, with the first report's output —
//        also beside an ANSWER ('denied', 'reflected'): the answer stays what the run was told (a late
//        success is never written over it, attempt.ts), and the report says the effect happened anyway;
//     3. a claim ('running') or a failure: in doubt — the provider (`recover`) or a person decides (a
//        failure written before records said whether the call was a side effect cannot say it was not);
//     4. anything else (an answer, a question, no record): no effect.
//
//   A BACKGROUND CALL — `callRecordKey`: the call `<runId>`/`<toolCallId>` whose launcher recorded a task
//   spec (`runKeys.taskSpec`) is its TASK's call. The parent's own record is the launcher's answer
//   (`{ status: 'started', taskId }`), what the model was told — not the effect. Its outcome, its
//   effect and its unwind are the task's call's, under the task's keys: unwinding the parent or the task
//   is one compensation (compensation.ts).
//
//   WRITE — `keepLateReport`: the late report is written, THEN the fence is read — the writer's run
//   deleted (its own fence, its parent's, its organization's purge: erasure-fence.ts `runErasedSince`)
//   or the call's record gone (a thread's or request's deletion took it) — and a report written for an
//   erased owner is taken back. The write comes first and the read last, so a report either lands before
//   the deletion (and goes with it) or is followed by a read that sees it: the erasure fence's order.
//   TAKEN BACK IS ONLY WHAT WAS ERASED: a window's record (`xreq:`/`xthr:`/`xrun:`) is reached by many
//   runs, and its row of late reports holds theirs too. An erased writer removes its own report from that
//   row (by the report's `id`, compare-and-set); the row goes whole only when everything in it went with
//   what was deleted — the call's record is gone, or the row is the erased run's own (under its id). It
//   used to go whole always, and erasing one run of a thread took another live run's proof that the
//   effect happened: the call read 'in-doubt' and fell to `recover` or a person (audit R2-3).
import { runKeys, deferredTaskRunId } from './journal.js';
import type { Journal, ToolJournalRecord } from './journal.js';
import { upgradeFormat } from './format.js';
import { journalNow } from './liveness.js';
import { compareAndSet } from './attempt.js';
import { runErasedSince, type ErasureBaseline } from './erasure-fence.js';
import { deleteExactKey } from './model.js';
import { randomUUID } from 'node:crypto';

/**
 * One late report: the attempt that finished after it lost the call, and what its body returned. `id`
 * names this report among the others on its row — what its writer takes back if its run is erased.
 */
export interface LateReport { id?: string; attempt?: number; at?: number; output?: unknown; sameAsSettled?: boolean }

/** What a call's records say about its effect. */
export type CallEffect =
  | { state: 'happened'; output: unknown; by: 'record' | 'late-report' }
  | { state: 'in-doubt' }
  | { state: 'none' };

export interface CallOutcome {
  /** The record as read — a claim given back before its body stands for none. */
  record: ToolJournalRecord | undefined;
  /** Late reports kept beside it, oldest first. */
  late: LateReport[];
  effect: CallEffect;
}

/** The late reports kept beside the record `recordKey`. */
export async function lateReportsOf(journal: Journal, recordKey: string): Promise<LateReport[]> {
  return (await journal.get<{ late?: LateReport[] }>(runKeys.lateOf(recordKey)))?.late ?? [];
}

/** The effect, by the order at the head of this file. */
export function callEffect(record: ToolJournalRecord | undefined, late: LateReport[]): CallEffect {
  if (record?.status === 'succeeded') return { state: 'happened', output: record.output, by: 'record' };
  if (late.length > 0) return { state: 'happened', output: late[0]!.output, by: 'late-report' };
  if (record?.status === 'running' || record?.status === 'failed') return { state: 'in-doubt' };
  return { state: 'none' };
}

/** A call's outcome from all its records. `raw`: the record as the caller already read it. */
export async function readCallOutcome(journal: Journal, recordKey: string, raw?: { value: unknown }): Promise<CallOutcome> {
  const value = raw ? raw.value : await journal.get(recordKey);
  const released = (value as { status?: unknown } | undefined)?.status === 'released';
  const record = released ? undefined : (upgradeFormat(value as ToolJournalRecord | undefined, recordKey) as ToolJournalRecord | undefined);
  // A success is the call's result and its effect: nothing beside it changes either.
  const late = record?.status === 'succeeded' ? [] : await lateReportsOf(journal, recordKey);
  return { record, late, effect: callEffect(record, late) };
}

/**
 * Whose records answer the call `toolCallId` of run `runId`: its own, or — a background call — its task's
 * (the head of this file). `taskRunId` is set for a background call.
 */
export async function callRecordKey(journal: Journal, runId: string, toolCallId: string): Promise<{ runId: string; key: string; taskRunId?: string }> {
  if ((await journal.get(runKeys.taskSpec(runId, toolCallId))) === undefined) return { runId, key: runKeys.tool(runId, toolCallId) };
  const taskRunId = deferredTaskRunId(runId, toolCallId);
  return { runId: taskRunId, key: runKeys.tool(taskRunId, toolCallId), taskRunId };
}

/** The run whose attempt writes a late report, and what it remembered of the erasure fence at its entry. */
export interface LateWriter { runId: string; baseline?: ErasureBaseline }

/**
 * Keeps one late report beside the record `recordKey`, behind the erasure fence (the head of this file).
 * `kept`: it stands; `erased`: its owner was deleted, and nothing of it stays; `not-written`: three
 * compare-and-set rounds lost to other writers.
 */
export async function keepLateReport(journal: Journal, recordKey: string, writer: LateWriter, report: Omit<LateReport, 'at' | 'id'>): Promise<'kept' | 'erased' | 'not-written'> {
  const key = runKeys.lateOf(recordKey);
  const id = randomUUID();
  let written = false;
  for (let round = 0; round < 3 && !written; round++) {
    const raw = await journal.get<{ late?: LateReport[] }>(key);
    written = await compareAndSet(journal, key, raw, { late: [...(raw?.late ?? []), { ...report, id, at: await journalNow(journal) }] });
  }
  if (!written) return 'not-written';
  const recordGone = (await journal.get(recordKey)) === undefined;
  if (!recordGone && !(await runErasedSince(journal, writer.runId, writer.baseline))) return 'kept';
  // Everything on the row went with what was deleted — the record it reports on, or the erased run whose
  // own row it is: the row goes. Exactly this key: a key is a prefix of its neighbours' too
  // (`<run>:proc:late-call-1` of `…-call-10`).
  if (recordGone || key.startsWith(`${writer.runId}:`)) {
    await deleteExactKey(journal, key);
    return 'erased';
  }
  // A row other runs report on: only this report goes.
  for (;;) {
    const raw = await journal.get<{ late?: LateReport[] }>(key);
    const late = raw?.late ?? [];
    if (!late.some((r) => r.id === id)) return 'erased';
    if (await compareAndSet(journal, key, raw, { ...raw, late: late.filter((r) => r.id !== id) })) return 'erased';
  }
}
