// Where each part of a run's frozen input came from — written by the run itself, next to `:memctx`.
//
// `:memctx` says what memory contributed (recalled refs, the recent window, the turn). A reader that
// wants to point at a SPAN of the frozen `:input` ("these three rows were recall") cannot redo that
// from the counts: input processors run between memory and the freeze (redaction, trimming, injected
// reminders), and a processor that drops one row and inserts another keeps every count true while
// moving every label. So the run — the one party that saw the array before AND after the chain —
// records the answer, or records that it has none. There is no count-derived fallback anywhere: a
// record without `layout` is read as "absent" (readMemoryLayout), never reconstructed.
//
// Every span is half-open `[start, end)` over the FROZEN `:input.messages` (what the model was sent),
// never over the pre-chain array. Nothing here is a content hash: the layout is written by the attempt
// that froze `:input` and read next to it, so it is checked against `:input` by its length (`n`), and a
// fingerprint of message content kept beside the messages would only be one more copy of personal data.
import { argsHash } from './hash.js';
import { runKeys, type Journal } from './journal.js';

export type Span = [start: number, end: number];
export type LayoutPart = 'observations' | 'recall' | 'recent' | 'incoming';

export interface MemoryLayout {
  v: 1;
  /** Length of the frozen `:input.messages` this layout is relative to. */
  n: number;
  /**
   * `exact` — every row of the history block is one memory returned, unchanged, at a proven position
   * (rows the chain only REMOVED are counted in `droppedByChain` and change nothing else).
   * `changed` — the spans are proven, but some positions are not memory's rows as memory returned
   * them: `rewritten` (a row replaced one-for-one by a row of the same role — a redaction, or a swap:
   * the run cannot tell which) and `foreign` (a row no memory row accounts for).
   * `unresolved` — the history is too large to align within the budget (ALIGN_CELL_CAP): no history
   * span is claimed, the counts stay memory's own report, and readMemoryLayout reads it `absent`.
   * `counts-mismatch` — the memory implementation's own counts (observations + recalled + recent) do
   * not add up to the rows it returned, so the split inside the history is unknown.
   * `boundary-lost` — the turn itself could not be located (see `incomingUnrecoverable`).
   * `no-messages` — the frozen input carries no `messages` array.
   * (Only the attempt that froze `:input` writes `:memctx` — a later one's memory read is no evidence
   * about what the input was built from — so there is no status for "written later".)
   */
  status: 'exact' | 'changed' | 'unresolved' | 'counts-mismatch' | 'boundary-lost' | 'no-messages';
  observations?: Span;
  recall?: Span;
  recent?: Span;
  incoming?: Span;
  /**
   * Positions inside a span whose row an input processor replaced one-for-one with a row of the same
   * role. The span's label there is POSITIONAL ONLY — the content is not the row memory returned.
   */
  rewritten?: number[];
  /**
   * Positions in the history block that no memory row accounts for (a processor's own row, a reordered
   * row). Labelled by no part; one that sits between two rows of the same part lies inside that span
   * and must still be read as unlabelled.
   */
  foreign?: number[];
  /**
   * Positions paired with memory content that occurs in more than one part (recall AND recent) when not
   * every copy reached the frozen input: which copy this is cannot be told. Labelled by no part.
   */
  ambiguous?: number[];
  /**
   * The attempt that wrote this record — the same token `:input.turn.token` carries. Two concurrent
   * attempts of one run id can each win one of the two writes; a reader that finds them different
   * reads `absent` ('input-mismatch') instead of one attempt's layout over the other's input.
   */
  token?: string;
  /** Rows memory returned that the chain removed (a trim). Not in the frozen input, so in no span. */
  droppedByChain?: number;
  /** Rows at the end of memory's window that ARE this turn (a prior attempt already stored them — retry dedupe). */
  incomingAlreadyInThread?: number;
}

export interface SystemSpans {
  /**
   * The memory system text (working memory) inside the frozen `:input.system`. `exact` — at the offset
   * it was appended at. `moved` — found verbatim elsewhere. `rewritten` — not found verbatim, but both
   * ends are anchored: the caller's system prefix and the text's own head survived in front, and its
   * own tail at the end, so nothing was put BEFORE or BEHIND it. `unbounded` — rewritten, and an end is
   * not anchored, so no span is claimed: with `start`, the front is and the end is not (a redaction at
   * the tail, or a note appended behind — the run cannot tell which); without `start`, not even the
   * front (a note prepended with no caller system looks the same as a rewritten head).
   * `lost` — neither; no span.
   */
  workingMemory?: { span?: Span; start?: number; chars: number; status: 'exact' | 'moved' | 'rewritten' | 'unbounded' | 'lost' };
}

/** What memory handed the run, captured BEFORE the input chain ran. */
export interface LayoutSeed {
  observations: number;
  recalled: number;
  recent: number;
  /** The loaded history rows (pre-chain), same objects memory returned. */
  history: any[];
  /**
   * A content key per history row, taken BEFORE the chain ran — set only when processors will run. A
   * processor that rewrites a row IN PLACE mutates the very object `history` holds, so comparing the
   * frozen row with `history[i]` afterwards would find them equal; the key taken first does not move.
   */
  keys?: string[];
  wm?: { text: string; prefix: string };
}

/** Which of memory's rows reached the frozen input, by part — what the run settles `:memctx`'s counts with. */
export interface LayoutSurvivors {
  observations: boolean;
  /** Indices WITHIN the part (0 = the part's first row as memory returned it). */
  recall: number[];
  recent: number[];
}

/** What a reader gets for one run. `absent` is a definite answer: this run cannot be diagnosed by position. */
export type MemoryLayoutReading =
  | { status: 'absent'; reason: 'no-record' | 'no-layout' | 'unknown-version' | 'malformed' | 'input-mismatch' | 'unresolved' }
  | { status: 'present'; layout: MemoryLayout; systemSpans?: SystemSpans };

export const rowKey = (row: unknown): string => argsHash(row);

/**
 * Above this many cells a stretch between two anchors is not searched: the alignment is then UNRESOLVED
 * (status `unresolved`, no spans) — never guessed at by calling the stretch foreign or dropped.
 */
const ALIGN_CELL_CAP = 250_000;

type Key = unknown;

/**
 * Pair the frozen history rows with memory's rows, order preserved. Three steps, cheapest first:
 *  1. the common prefix and suffix;
 *  2. ANCHORS — rows whose content occurs exactly once on each side, kept in order (the longest
 *     increasing run of them): a redaction or a trim leaves almost every row unique and untouched, so
 *     a 600-row window is split into tiny stretches without a single large table;
 *  3. a longest-common-subsequence table inside each stretch between anchors, up to ALIGN_CELL_CAP
 *     cells; a stretch over it makes the whole alignment `unresolved`.
 * A gap between two pairs where both sides hold the same number of rows with the same roles is a
 * ONE-FOR-ONE replacement (`rewritten`): the position is memory's, the content is not. Any other unpaired
 * frozen row is foreign. Identity is the key when no processor ran (nothing is hashed); with processors,
 * content decides — a processor may have mutated the very object in place (LayoutSeed.keys).
 */
function align(frozen: unknown[], seed: unknown[], seedKeys: string[] | undefined): { origin: number[]; rewritten: boolean[]; unresolved: boolean; keyA: (i: number) => Key; keyB: (j: number) => Key; inPlaceA: (i: number) => boolean; inPlaceB: (j: number) => boolean } {
  const A = frozen.length, B = seed.length;
  const origin = new Array<number>(A).fill(-1);
  const rewritten = new Array<boolean>(A).fill(false);
  const memoA: string[] = [];
  const keyA: (i: number) => Key = seedKeys ? (i) => (memoA[i] ??= rowKey(frozen[i])) : (i) => frozen[i];
  const keyB: (j: number) => Key = seedKeys ? (j) => seedKeys[j]! : (j) => seed[j];
  const same = (i: number, j: number) => keyA(i) === keyB(j);
  let p = 0;
  while (p < A && p < B && same(p, p)) { origin[p] = p; p++; }
  let s = 0;
  while (s < A - p && s < B - p && same(A - 1 - s, B - 1 - s)) { origin[A - 1 - s] = B - 1 - s; s++; }
  const a0 = p, a1 = A - s, b0 = p, b1 = B - s;
  // A row inside the common prefix or suffix sits where memory put it, row for row with its neighbours.
  const inPlaceA = (i: number) => i < a0 || i >= a1, inPlaceB = (j: number) => j < b0 || j >= b1;
  // 2. anchors: unique on both sides, then the longest run increasing in both.
  const countA = new Map<Key, number>(), countB = new Map<Key, number>(), atB = new Map<Key, number>();
  for (let i = a0; i < a1; i++) countA.set(keyA(i), (countA.get(keyA(i)) ?? 0) + 1);
  for (let j = b0; j < b1; j++) { countB.set(keyB(j), (countB.get(keyB(j)) ?? 0) + 1); atB.set(keyB(j), j); }
  const cand: Array<[number, number]> = [];
  for (let i = a0; i < a1; i++) { const k = keyA(i); if (countA.get(k) === 1 && countB.get(k) === 1) cand.push([i, atB.get(k)!]); }
  const tails: number[] = [], prev = new Array<number>(cand.length).fill(-1), tailIdx: number[] = [];
  for (let c = 0; c < cand.length; c++) {
    const j = cand[c]![1];
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid]! < j) lo = mid + 1; else hi = mid; }
    tails[lo] = j; tailIdx[lo] = c; prev[c] = lo > 0 ? tailIdx[lo - 1]! : -1;
  }
  const anchorsMid: Array<[number, number]> = [];
  for (let c = tails.length ? tailIdx[tails.length - 1]! : -1; c >= 0; c = prev[c]!) anchorsMid.unshift(cand[c]!);
  // 3. LCS inside each stretch between anchors.
  const pairs: Array<[number, number]> = [];
  let unresolved = false;
  const stretches: Array<[number, number]> = [[a0 - 1, b0 - 1], ...anchorsMid, [a1, b1]];
  for (let g = 0; g + 1 < stretches.length; g++) {
    const [ia, ja] = stretches[g]!, [ib, jb] = stretches[g + 1]!;
    const x0 = ia + 1, y0 = ja + 1, m = ib - x0, k = jb - y0;
    if (m > 0 && k > 0) {
      if (m * k > ALIGN_CELL_CAP) { unresolved = true; break; }
      const L = new Uint32Array((m + 1) * (k + 1));
      const at = (i: number, j: number) => i * (k + 1) + j;
      for (let i = m - 1; i >= 0; i--) for (let j = k - 1; j >= 0; j--) {
        L[at(i, j)] = same(x0 + i, y0 + j) ? L[at(i + 1, j + 1)]! + 1 : Math.max(L[at(i + 1, j)]!, L[at(i, j + 1)]!);
      }
      let i = 0, j = 0;
      while (i < m && j < k) {
        if (same(x0 + i, y0 + j)) { pairs.push([x0 + i, y0 + j]); i++; j++; }
        else if (L[at(i + 1, j)]! >= L[at(i, j + 1)]!) i++;
        else j++;
      }
    }
    if (g + 1 < stretches.length - 1) pairs.push(stretches[g + 1]!);
  }
  if (unresolved) return { origin, rewritten, unresolved, keyA, keyB, inPlaceA, inPlaceB };
  for (const [i, j] of pairs) origin[i] = j;
  // Gaps between pairs (including the region's two ends): a same-size, same-roles gap is a 1:1 rewrite.
  const anchors: Array<[number, number]> = [[a0 - 1, b0 - 1], ...pairs, [a1, b1]];
  for (let g = 0; g + 1 < anchors.length; g++) {
    const [ia, ja] = anchors[g]!, [ib, jb] = anchors[g + 1]!;
    const fa = ia + 1, fb = ib, sa = ja + 1, sb = jb;
    if (fb - fa > 0 && fb - fa === sb - sa) {
      let roles = true;
      for (let t = 0; t < fb - fa; t++) if ((frozen[fa + t] as any)?.role !== (seed[sa + t] as any)?.role) { roles = false; break; }
      if (roles) for (let t = 0; t < fb - fa; t++) { origin[fa + t] = sa + t; rewritten[fa + t] = true; }
    }
  }
  return { origin, rewritten, unresolved, keyA, keyB, inPlaceA, inPlaceB };
}

export function buildMemoryLayout(
  seed: LayoutSeed,
  frozenMessages: unknown,
  frozenSystem: string | undefined,
  incomingCount: number,
  lost: boolean,
  /** The turn is the tail of memory's own window (a prior attempt stored it — the retry dedupe). */
  incomingInHistory = false,
): { layout: MemoryLayout; systemSpans?: SystemSpans; survivors?: LayoutSurvivors } {
  const systemSpans = seed.wm ? { workingMemory: locateSystemText(seed.wm, frozenSystem) } : undefined;
  const out = (layout: MemoryLayout, survivors?: LayoutSurvivors) => ({ layout, ...(systemSpans ? { systemSpans } : {}), ...(survivors ? { survivors } : {}) });
  if (!Array.isArray(frozenMessages)) return out({ v: 1, n: 0, status: 'no-messages' });
  const msgs = frozenMessages;
  const n = msgs.length;
  if (lost) return out({ v: 1, n, status: 'boundary-lost' });
  const k = Math.max(0, Math.min(incomingCount, n));
  const histEnd = n - k;
  const incoming: Span = [histEnd, n];
  const base = (status: MemoryLayout['status']): MemoryLayout => ({ v: 1, n, status, ...(k > 0 ? { incoming } : {}) });
  const H = seed.history.length;
  if (seed.observations + seed.recalled + seed.recent !== H) return out(base('counts-mismatch'));
  // On the retry dedupe the turn is memory's own last `k` rows: they are the turn, not history.
  const overlap = incomingInHistory ? Math.min(k, H) : 0;
  const hist = seed.history.slice(0, H - overlap);
  const { origin, rewritten, unresolved, keyA, keyB, inPlaceA, inPlaceB } = align(msgs.slice(0, histEnd), hist, seed.keys?.slice(0, H - overlap));
  // Too large to align within the budget: say so. Calling the rows foreign and memory's rows dropped
  // would settle the counts to a false zero — and the sum check (obs + recalled + recentCount + foreign
  // + incoming = n) would still hold, so nothing downstream could tell. No spans, no settling.
  if (unresolved) return out(base('unresolved'));
  const o = seed.observations, r = o + seed.recalled;
  const partOf = (j: number): Exclude<LayoutPart, 'incoming'> => (j < o ? 'observations' : j < r ? 'recall' : 'recent');
  // AMBIGUOUS pairings: the same content in two parts of memory's window. Which copy a frozen row is
  // cannot be told from content — the chain may have dropped one ('yes' in recall and in recent, one
  // gone) or MOVED one (the recall copy put behind the recent window: equal counts, and an LCS pairs the
  // front row with recall). Such a row is labelled by no part, like a foreign one. The one proven case:
  // the counts are equal and EVERY copy, on both sides, lies in the common prefix or suffix — rows that
  // match memory's row for row, so no copy can have come from elsewhere.
  const ambiguous = new Set<number>();
  if (seed.keys) {
    const parts = new Map<Key, Set<string>>(), nSeed = new Map<Key, number>(), nFrozen = new Map<Key, number>();
    const moved = new Set<Key>(); // a multi-part key with a copy outside the in-place rows, on either side
    for (let j = 0; j < hist.length; j++) { const k = keyB(j); (parts.get(k) ?? parts.set(k, new Set()).get(k)!).add(partOf(j)); nSeed.set(k, (nSeed.get(k) ?? 0) + 1); if (!inPlaceB(j)) moved.add(k); }
    for (let i = 0; i < histEnd; i++) { const k = keyA(i); nFrozen.set(k, (nFrozen.get(k) ?? 0) + 1); if (!inPlaceA(i)) moved.add(k); }
    for (let i = 0; i < histEnd; i++) {
      if (origin[i]! < 0 || rewritten[i]) continue;
      const k = keyA(i);
      if ((parts.get(k)?.size ?? 0) > 1 && (nFrozen.get(k) !== nSeed.get(k) || moved.has(k))) ambiguous.add(i);
    }
  }
  const first: Partial<Record<LayoutPart, number>> = {}, last: Partial<Record<LayoutPart, number>> = {};
  const survivors: LayoutSurvivors = { observations: false, recall: [], recent: [] };
  const foreign: number[] = [], rw: number[] = [];
  for (let i = 0; i < histEnd; i++) {
    const j = origin[i]!;
    if (j < 0) { foreign.push(i); continue; }
    if (ambiguous.has(i)) continue;
    const part = partOf(j);
    first[part] ??= i;
    last[part] = i;
    if (rewritten[i]) rw.push(i);
    if (part === 'observations') survivors.observations = true;
    else survivors[part].push(j - (part === 'recall' ? o : r));
  }
  const kept = (survivors.observations ? 1 : 0) + survivors.recall.length + survivors.recent.length;
  const layout = base(foreign.length || rw.length || ambiguous.size ? 'changed' : 'exact');
  for (const part of ['observations', 'recall', 'recent'] as const) {
    if (first[part] !== undefined) layout[part] = [first[part]!, last[part]! + 1];
  }
  if (rw.length) layout.rewritten = rw;
  if (foreign.length) layout.foreign = foreign;
  if (ambiguous.size) layout.ambiguous = [...ambiguous];
  if (hist.length > kept + ambiguous.size) layout.droppedByChain = hist.length - kept - ambiguous.size;
  if (overlap) layout.incomingAlreadyInThread = overlap;
  return out(layout, survivors);
}

/**
 * Settle `:memctx`'s own counts with what reached the frozen input. Before the layout existed these
 * were memory's report, taken before the input processors ran — a tokenLimiter that trimmed four rows
 * left `recentCount` four too high, and the Inspector showed it as what the model saw. With survivors
 * known, every count and ref list says what the model was SENT; rows the chain removed are counted in
 * `layout.droppedByChain` and named nowhere else. Without survivors (counts-mismatch, boundary-lost,
 * no-messages) there is no frozen truth to settle with, and the layout's status says so.
 */
export function settleProvenance<R>(
  rec: { recalled: R[]; recent?: R[]; recentCount: number; observationCount?: number },
  seed: LayoutSeed,
  survivors: LayoutSurvivors | undefined,
): void {
  if (!survivors) return;
  const keepRecall = new Set(survivors.recall);
  if (rec.recalled.length === seed.recalled) rec.recalled = rec.recalled.filter((_, t) => keepRecall.has(t));
  const keepRecent = new Set(survivors.recent);
  if (rec.recent) {
    // `recent` refs are the LAST refs.length rows of memory's recent window (PROVENANCE_RECENT_CAP).
    const offset = seed.recent - rec.recent.length;
    rec.recent = rec.recent.filter((_, t) => keepRecent.has(offset + t));
  }
  rec.recentCount = survivors.recent.length;
  if (!survivors.observations) delete rec.observationCount;
}

/**
 * Read a run's layout from its `:memctx` record. Every record written before the layout existed — and
 * every one that is not what this version writes — reads `absent`, never a guess: a reader shows "this
 * run carries no layout; it cannot be diagnosed by position" and stops. Pass the frozen input's
 * `messages.length` and `turn.token` to also refuse a layout that describes another array, or another
 * attempt's input of the same length.
 */
export function readMemoryLayout(rec: unknown, inputLength?: number, inputToken?: string): MemoryLayoutReading {
  if (rec === undefined || rec === null) return { status: 'absent', reason: 'no-record' };
  if (typeof rec !== 'object') return { status: 'absent', reason: 'malformed' };
  const L = (rec as { layout?: unknown }).layout;
  if (L === undefined) return { status: 'absent', reason: 'no-layout' };
  if (typeof L !== 'object' || L === null) return { status: 'absent', reason: 'malformed' };
  const l = L as Record<string, unknown>;
  if (l.v !== 1) return { status: 'absent', reason: 'unknown-version' };
  const n = l.n;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || typeof l.status !== 'string') return { status: 'absent', reason: 'malformed' };
  const span = (s: unknown) => s === undefined || (Array.isArray(s) && s.length === 2 && Number.isInteger(s[0]) && Number.isInteger(s[1]) && 0 <= s[0] && s[0] < s[1] && s[1] <= n);
  if (!['observations', 'recall', 'recent', 'incoming'].every((p) => span(l[p]))) return { status: 'absent', reason: 'malformed' };
  if (inputLength !== undefined) {
    // Same length is not the same input: two attempts of one run id can each win one of the two writes
    // (`:input` last-writer, `:memctx` first-writer). The attempt token (`:input.turn.token`) tells them apart.
    if (inputLength !== n || (l.token ?? undefined) !== inputToken) return { status: 'absent', reason: 'input-mismatch' };
  }
  if (l.status === 'unresolved') return { status: 'absent', reason: 'unresolved' };
  const sys = (rec as { systemSpans?: SystemSpans }).systemSpans;
  return { status: 'present', layout: L as MemoryLayout, ...(sys && typeof sys === 'object' ? { systemSpans: sys } : {}) };
}

/** `readMemoryLayout` over a run's own records: its `:memctx`, checked against its frozen `:input`. */
export async function readRunMemoryLayout(journal: Pick<Journal, 'get'>, runId: string): Promise<MemoryLayoutReading> {
  const [rec, input] = await Promise.all([journal.get(runKeys.memoryContext(runId)), journal.get<{ messages?: unknown; turn?: { token?: unknown } }>(runKeys.input(runId))]);
  const msgs = input?.messages;
  const token = input?.turn?.token;
  return readMemoryLayout(rec, Array.isArray(msgs) ? msgs.length : 0, typeof token === 'string' ? token : undefined);
}

/**
 * Which rows of a run's frozen input are memory's, by the run's own layout — the one rule every reader
 * that leaves memory out follows (the Lab's capsule, `replayRun({ stripMemoryContext })`).
 *
 * Read from spans only, never from counts. A row no memory row accounts for (`foreign`, a processor's
 * own) and a row whose part cannot be told (`ambiguous`) are not counted as memory's. A row a processor
 * rewrote in place IS memory's position (`rewritten` names it, so a reader can say its content was
 * changed). Under any status whose spans are not proven — and for a run without a layout — the answer is
 * `known: false` with a reason a person can read; nothing is guessed.
 */
export type MemoryRows =
  | {
      known: true;
      /** Positions in the frozen `:input.messages` that memory put there, ascending. */
      positions: number[];
      /** Memory's rows whose content an input processor replaced (a subset of `positions`). */
      rewritten: number[];
      /** Memory content whose part cannot be told — NOT in `positions`, and still in the input. */
      ambiguous: number[];
      /** Positions no memory row accounts for — NOT in `positions`. */
      foreign: number[];
      /** The working memory inside the frozen `:input.system`, when memory put one there. */
      workingMemory?: { status: 'exact' | 'moved' | 'rewritten'; span: Span } | { status: 'unbounded' | 'lost' };
    }
  | { known: false; reason: Exclude<MemoryLayoutReading, { status: 'present' }>['reason'] | 'counts-mismatch' | 'boundary-lost' | 'no-messages'; detail: string };

const ABSENT_DETAIL: Record<string, string> = {
  'no-record': 'the run has no memory record (:memctx)',
  'no-layout': 'the run carries no memory layout (it was recorded before layouts existed)',
  'unknown-version': 'the run\'s memory layout is of a version this release does not read',
  malformed: 'the run\'s memory layout is not readable',
  'input-mismatch': 'the run\'s memory layout describes another input than the one it froze',
  unresolved: 'the run\'s history was too large to align when it was recorded',
  'counts-mismatch': 'the memory implementation\'s own counts did not add up, so its rows inside the history are not known',
  'boundary-lost': 'the input processors left no recoverable copy of the turn',
  'no-messages': 'the run\'s frozen input has no messages',
};

/** @internal — the reader rule @gnldev/lab and replayRun share; its argument is readMemoryLayout's reading, not an options bag (see MemoryRows). */
export function memoryRowsOf(reading: MemoryLayoutReading): MemoryRows {
  if (reading.status === 'absent') return { known: false, reason: reading.reason, detail: ABSENT_DETAIL[reading.reason]! };
  const L = reading.layout;
  if (L.status !== 'exact' && L.status !== 'changed') {
    const reason = L.status === 'unresolved' ? 'unresolved' : L.status;
    return { known: false, reason, detail: ABSENT_DETAIL[reason] ?? `the run's memory layout says '${L.status}'` };
  }
  const list = (x: unknown) => (Array.isArray(x) ? x.filter((i): i is number => Number.isInteger(i)) : []);
  const foreign = list(L.foreign), ambiguous = list(L.ambiguous);
  const out = new Set([...foreign, ...ambiguous]);
  const positions: number[] = [];
  for (const part of ['observations', 'recall', 'recent'] as const) {
    const sp = L[part];
    if (sp) for (let i = sp[0]; i < sp[1]; i++) if (!out.has(i)) positions.push(i);
  }
  positions.sort((a, b) => a - b);
  const mine = new Set(positions);
  const wm = reading.systemSpans?.workingMemory;
  const workingMemory: Extract<MemoryRows, { known: true }>['workingMemory'] = !wm ? undefined
    : (wm.status === 'exact' || wm.status === 'moved' || wm.status === 'rewritten') && Array.isArray(wm.span) ? { status: wm.status, span: wm.span }
    : { status: wm.status === 'lost' ? 'lost' : 'unbounded' };
  return { known: true, positions, rewritten: list(L.rewritten).filter((i) => mine.has(i)), ambiguous, foreign, ...(workingMemory ? { workingMemory } : {}) };
}

/**
 * The system text without the working memory at `span` — and without the blank line that joined it to
 * the text before it, so a system that was `caller + "\n\n" + wm` reads back as `caller`.
 */
export function cutWorkingMemory(system: string, span: Span): string {
  const [a, b] = span;
  const before = system.slice(0, a), after = system.slice(b);
  if (before.endsWith('\n\n')) return before.slice(0, -2) + after;
  if (before === '' && after.startsWith('\n\n')) return after.slice(2);
  return before + after;
}

function locateSystemText(wm: NonNullable<LayoutSeed['wm']>, sys: string | undefined): NonNullable<SystemSpans['workingMemory']> {
  const chars = wm.text.length;
  const s = typeof sys === 'string' ? sys : '';
  const start = wm.prefix ? wm.prefix.length + 2 : 0;
  const at = (a: number, b: number, status: 'exact' | 'moved' | 'rewritten') => ({ span: [a, b] as Span, chars, status });
  if (s.slice(start, start + chars) === wm.text) return at(start, start + chars, 'exact');
  const idx = s.lastIndexOf(wm.text);
  if (idx >= 0) return at(idx, idx + chars, 'moved');
  // Rewritten in place (a redaction): claimed only when BOTH ends are anchored. The front by the
  // caller's surviving prefix; the back by the text's own tail still ending the system — so a processor
  // that appended a note BEHIND the working memory is not read as part of it (the span would swallow it).
  // The front needs BOTH the caller's prefix (when there is one) and the text's own head right after it:
  // with no caller system, "anything before" is no anchor at all — a note a processor PREPENDED would be
  // read as working memory. Unproven front: no start, no span.
  const anchor = Math.min(TAIL_ANCHOR, chars);
  const front = (wm.prefix ? s.startsWith(wm.prefix + '\n\n') : true) && anchor > 0 && s.startsWith(wm.text.slice(0, anchor), start);
  if (front && s.length - start >= anchor && s.endsWith(wm.text.slice(-anchor))) return at(start, s.length, 'rewritten');
  if (front && s.length > start) return { start, chars, status: 'unbounded' };
  if (s.length > 0) return { chars, status: 'unbounded' };
  return { chars, status: 'lost' };
}

/** How many of the working memory's last characters must still end the system for a rewritten span to be claimed. */
const TAIL_ANCHOR = 8;
