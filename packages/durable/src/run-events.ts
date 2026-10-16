// THE RUN'S EVENT LOG — every step of a run, as the caller sees it, in the run's own journal.
//
// A run that executes detached from its caller is followed through this log: the process executing it
// appends, any process serves a reader from a cursor (`seq`). The log lives under the run's prefix
// (`<runId>:ev:<seq>`), so it is scoped and erased exactly like the run: an organization's view writes
// it under the organization's prefix, and deleting the run (`deletePrefix('<runId>:')`) deletes it.
//
// An append is a first-writer-wins claim of its sequence number: two executors of one run (which the
// execution record exists to prevent) cannot both write event N — the second learns it lost the run.
import { runRecordPrefix } from './run-id-grammar.js';
import type { Journal } from './journal.js';

/** One event of a run. `kind` is the agent stream's event name, or `status` (the short state). */
export interface RunEvent {
  /** The schema version (event-codec.ts). Absent on events written before it was introduced. */
  v?: number;
  seq: number;
  kind: string;
  data: unknown;
  /** The model step this event belongs to (-1 before the first step). */
  step: number;
  at: number;
  /**
   * Only on a delta a reader receives LIVE from the executing process, before the segment is written: how
   * much of event `seq + 1`'s text the reader now holds. Its cursor is then `seq` + this offset.
   */
  offset?: number;
}

/** A reader's cursor as a door carries it (`Last-Event-ID`): `seq`, or `seq.offset` mid-segment. */
export function formatCursor(seq: number, offset = 0): string {
  return offset ? `${seq}.${offset}` : String(seq);
}

/** A reader's place in a run's event log: after event `seq`, holding `offset` characters of the next. */
export interface RunCursor { seq: number; offset: number }

const CURSOR_TEXT = /^(\d+)(?:\.(\d+))?$/;
const place = (n: number) => Number.isSafeInteger(n) && n >= 0;

/**
 * The cursor `formatCursor` wrote (a number is a plain `seq`); undefined when it is not one. THE grammar,
 * in one place: whatever this accepts, `formatCursor` writes back as the same cursor — every part a safe
 * integer. A longer number used to pass (`99999999999999999999999` read as 1e23, written back as
 * '1e+23', which no reader takes), and the follow then started over from 0 (release audit A8).
 */
export function parseCursor(raw: unknown): RunCursor | undefined {
  if (typeof raw === 'number') return place(raw) ? { seq: raw, offset: 0 } : undefined;
  const m = typeof raw === 'string' ? CURSOR_TEXT.exec(raw) : null;
  if (!m) return undefined;
  const seq = Number(m[1]);
  const offset = m[2] === undefined ? 0 : Number(m[2]);
  return place(seq) && place(offset) ? { seq, offset } : undefined;
}

/** A cursor that is not one `formatCursor` writes: refused, never read as "from the start". */
export class InvalidCursorError extends Error {
  readonly code = 'invalid_cursor';
  constructor(raw: unknown) {
    super(`@gnldev/durable: '${String(raw).slice(0, 40)}' is not a run cursor — a cursor is an event's seq, or seq.offset mid-answer, as cursor() / Last-Event-ID gave it`);
    this.name = 'InvalidCursorError';
  }
}

/** A reader's cursor, given or not: absent is the start; one that is not a cursor is refused. */
export function readCursor(raw: unknown): RunCursor {
  if (raw === undefined) return { seq: 0, offset: 0 };
  const c = parseCursor(raw);
  if (!c) throw new InvalidCursorError(raw);
  return c;
}

/**
 * The short state a client shows like a notification. `step-retry` is not a state: it tells a reader
 * to discard what it holds of step `data.step` — a process that took the run over produces that
 * step again (its model output may differ from the cut one; its tool results come from the journal).
 */
/**
 * `waiting-outcome`: a call reached its retry ceiling with its outcome unknown (OutcomeUnknownError) — the
 * run waits for the call's result and continues from it (detached.ts). Not an ending: it is a pause, like
 * `waiting-approval`.
 */
export type RunState = 'running' | 'tool' | 'waiting-approval' | 'waiting-outcome' | 'completed' | 'failed' | 'canceled' | 'released';

const SEQ_WIDTH = 10;
export const runEventPrefix = (runId: string): string => runRecordPrefix(runId, 'ev');
export const runEventKey = (runId: string, seq: number): string => `${runEventPrefix(runId)}${String(seq).padStart(SEQ_WIDTH, '0')}`;

/** Appends event `seq` — false when it is already there (another executor wrote it: this one lost the run). */
export async function appendRunEvent(journal: Journal, runId: string, ev: RunEvent): Promise<boolean> {
  const key = runEventKey(runId, ev.seq);
  if (journal.putIfAbsent) return journal.putIfAbsent(key, ev);
  if ((await journal.get(key)) !== undefined) return false;
  await journal.put(key, ev);
  return true;
}

/** The events after `after`, in order (two statements: the key range, then the values). */
export async function readRunEvents(journal: Journal, runId: string, after = 0, limit = 1_000): Promise<RunEvent[]> {
  // A journal that cannot list (get/put only) is read by key: the numbers are dense — each append claims
  // the next one — so the events after `after` are `after+1`, `after+2`, … until the first that is not there.
  if (!journal.listKeys) {
    const out: RunEvent[] = [];
    for (let seq = after + 1; out.length < limit; seq++) {
      const ev = await journal.get<RunEvent>(runEventKey(runId, seq));
      if (ev === undefined) break;
      out.push(ev);
    }
    return out;
  }
  const from = runEventKey(runId, after);
  // One index range from the cursor (Journal.readRange): measured, a follower of a 30 s answer listed
  // 54 243 keys per run through the whole-prefix listing below, and 0 this way.
  if (journal.readRange) return (await journal.readRange<RunEvent>(runEventPrefix(runId), { after: from, limit })).map(([, v]) => v);
  const keys = (await journal.listKeys(runEventPrefix(runId))).filter((k) => k > from).slice(0, limit);
  if (keys.length === 0) return [];
  const values = journal.getMany ? await journal.getMany<RunEvent>(keys) : await Promise.all(keys.map((k) => journal.get<RunEvent>(k)));
  return values.filter((v): v is RunEvent => v !== undefined);
}

/** The last event written (undefined for a run with none). */
export async function lastRunEvent(journal: Journal, runId: string): Promise<RunEvent | undefined> {
  if (journal.readRange) return (await journal.readRange<RunEvent>(runEventPrefix(runId), { limit: 1, desc: true }))[0]?.[1];
  if (!journal.listKeys) {
    // Dense numbers (see readRunEvents): find the last one by doubling, then halving.
    if ((await journal.get(runEventKey(runId, 1))) === undefined) return undefined;
    let lo = 1;
    let hi = 2;
    while ((await journal.get(runEventKey(runId, hi))) !== undefined) { lo = hi; hi *= 2; }
    while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if ((await journal.get(runEventKey(runId, mid))) !== undefined) lo = mid; else hi = mid; }
    return journal.get<RunEvent>(runEventKey(runId, lo));
  }
  const keys = await journal.listKeys(runEventPrefix(runId));
  const last = keys[keys.length - 1];
  return last === undefined ? undefined : journal.get<RunEvent>(last);
}

/** A status event that ends a reader's follow: the run is over (or, with `untilPause`, waits on a human). */
export function endsFollow(ev: RunEvent, untilPause = false): boolean {
  if (ev.kind !== 'status') return false;
  const state = (ev.data as { state?: RunState }).state;
  return state === 'completed' || state === 'failed' || state === 'canceled' || (untilPause && (state === 'waiting-approval' || state === 'waiting-outcome'));
}
