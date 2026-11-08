import { createHash } from 'node:crypto';

/**
 * THE RULE OF A CALL'S IDENTITY — one owner.
 *
 * A tool call is identified by (run, model step, the provider's id). The provider's id alone is unique
 * only inside ONE model answer: some providers restart at `call_0` in every answer (Kimi's
 * `functions.pay:0`, fixed-id proxies, mocks). Everything GNL keys by "the tool call's id" — the call's
 * record, the approval map, the duplicate marker — used to take that id at face value, so two calls of
 * one run (or of two runs) that shared an id were one call to it.
 *
 * Two parts, both here:
 *   · MINTING — the model boundary (durable-model.ts) gives every tool call a GNL id when the answer
 *     enters GNL, BEFORE it is journaled: `<providerId>.gnl-<runTag>-<step>-<index>`. Everyone inside
 *     GNL sees an id that is unique for the run and step; the provider is handed its own id back
 *     (`providerIdOf`) on the next request, so what it sees never changes.
 *   · OWNERSHIP — "is this MY call" is decided by (runId, id) (`sameCall`), never by the id alone: the
 *     doors that do not pass the model boundary (MCP, channels, batch) and the markers shared between
 *     runs (a thread's duplicate marker) carry ids this module does not mint.
 *
 * Pure functions, no state, nothing journaled by itself.
 */

const GNL_SUFFIX = /^(.*)\.gnl-[0-9a-z]{8}-\d+-\d+$/s;

/** 8 base-36 characters of sha256(runId): what tells two runs' ids apart without carrying the run id. */
export function runTag(runId: string): string {
  return BigInt('0x' + createHash('sha256').update(runId).digest('hex')).toString(36).slice(0, 8);
}

/** The GNL id of the `index`-th distinct provider id of model step `step` of `runId`. */
export function mintCallId(providerId: string, runId: string, step: number, index: number): string {
  return `${providerId}.gnl-${runTag(runId)}-${step}-${index}`;
}

/** The id the provider issued: the GNL suffix removed; an id GNL never minted comes back as it is. */
export function providerIdOf(id: string): string {
  const m = GNL_SUFFIX.exec(id);
  return m ? m[1]! : id;
}

export function isGnlCallId(id: string): boolean {
  return GNL_SUFFIX.test(id);
}

/**
 * @internal — engine plumbing: the identity rule's own comparison, not a host API.
 *
 * The same call: BOTH sides name their run and the runs are equal, and so are the ids. `a` is a stored
 * side (a marker, a record) and may predate the run field — then it is not provably the same call and
 * the answer is false; the caller applies the legacy rule (`ownsLegacyMarker`) where one exists.
 */
export function sameCall(a: { runId?: string; toolCallId: string }, b: { runId: string; toolCallId: string }): boolean {
  return a.runId !== undefined && a.runId === b.runId && a.toolCallId === b.toolCallId;
}

/** What a stored claim stamp carries of the attempt that wrote it (attempt.ts RunningStamp / DupMarker). */
export interface AttemptStamp { hold?: string; proc?: string }

/** The attempt stamp a stored claim record carries; none for a value that is not one. */
export function stampOf(record: unknown): AttemptStamp | undefined {
  if (typeof record !== 'object' || record === null) return undefined;
  const { hold, proc } = record as AttemptStamp;
  return { ...(typeof hold === 'string' ? { hold } : {}), ...(typeof proc === 'string' ? { proc } : {}) };
}

/**
 * The legacy rule, for a marker written before markers named their run. Its id alone proves nothing, but
 * the marker and the call's own record are written by the SAME attempt, so they carry the same `hold`
 * (the attempt) — or, with no `hold`, the same `proc` (the process). Equal: the marker is this call's own.
 * Anything else, a field missing included, is not proven: the caller asks rather than takes over.
 */
export function ownsLegacyMarker(marker: AttemptStamp, own: AttemptStamp | undefined): boolean {
  if (own === undefined) return false;
  const field: keyof AttemptStamp = marker.hold !== undefined ? 'hold' : 'proc';
  const theirs = marker[field];
  return theirs !== undefined && own[field] === theirs;
}

/**
 * Is this marker the call `me`'s own? A marker that names its run is decided by `sameCall`; one that
 * does not, by the legacy rule against the call's own earlier record (`own`).
 */
export function markerIsMine(
  marker: { firstRunId?: string; firstToolCallId: string } & AttemptStamp,
  me: { runId: string; toolCallId: string },
  own: AttemptStamp | undefined,
): boolean {
  if (marker.firstRunId !== undefined) return sameCall({ runId: marker.firstRunId, toolCallId: marker.firstToolCallId }, me);
  return marker.firstToolCallId === me.toolCallId && ownsLegacyMarker(marker, own);
}

/**
 * The ids of ONE model answer, renamed as they first appear. `index` counts distinct provider ids in the
 * order they first show up, so the same answer always yields the same ids (same runId, step, order).
 */
export interface StepMinter { (providerId: string): string }
export function stepMinter(runId: string, step: number): StepMinter {
  const seen = new Map<string, string>();
  return (providerId) => {
    if (isGnlCallId(providerId)) return providerId;
    let id = seen.get(providerId);
    if (id === undefined) {
      id = mintCallId(providerId, runId, step, seen.size);
      seen.set(providerId, id);
    }
    return id;
  };
}

type AnyPart = { type?: string; toolCallId?: string; id?: string };

/** A model-answer part (generate content or stream part) with its tool-call id renamed; others untouched. */
export function renameAnswerPart<T>(part: T, mint: StepMinter): T {
  const p = part as AnyPart | null;
  if (!p || typeof p !== 'object') return part;
  switch (p.type) {
    case 'tool-call':
    case 'tool-result':
    case 'tool-approval-request':
      return typeof p.toolCallId === 'string' ? ({ ...p, toolCallId: mint(p.toolCallId) } as T) : part;
    case 'tool-input-start':
    case 'tool-input-delta':
    case 'tool-input-end':
      return typeof p.id === 'string' ? ({ ...p, id: mint(p.id) } as T) : part;
    default:
      return part;
  }
}

/**
 * The request going back to the provider: GNL ids turned back into the provider's own. Copies what it
 * changes, never the caller's messages; returns the SAME array when nothing needed changing.
 */
export function restoreProviderIds<M extends { role?: string; content?: unknown }>(prompt: readonly M[]): readonly M[] {
  let changed = false;
  const out = prompt.map((msg) => {
    if (!Array.isArray(msg.content)) return msg;
    let touched = false;
    const content = (msg.content as AnyPart[]).map((part) => {
      if ((part?.type === 'tool-call' || part?.type === 'tool-result') && typeof part.toolCallId === 'string') {
        const back = providerIdOf(part.toolCallId);
        if (back !== part.toolCallId) { touched = true; return { ...part, toolCallId: back }; }
      }
      return part;
    });
    if (!touched) return msg;
    changed = true;
    return { ...msg, content };
  });
  return changed ? out : prompt;
}
