// A RUN AS ITS READER SEES IT — what `gnl.stream()` returns now that a run executes apart from the caller
// (detached.ts). It has the parts of a stream result a door reads — `fullStream`, `toUIMessageStream()`,
// `steps`, `text`, `finishReason`, `usage` — built from the run's event log through the one translation
// (event-codec.ts `decodeEvent`), so every door's encoder reads a followed run as it read the in-request
// stream: from any process, from any cursor.
//
// Ending this reader's follow (its `signal`, or cancelling its stream) ends the reading, not the run.
//
// A STEP PRODUCED AGAIN (`step-retry`, after a takeover): the log only grows, so a reader that was
// streaming the cut step has already received part of it. `steps` and `text` drop the cut attempt; a live
// `fullStream` cannot take back what it sent, so it shows at most one partial step before the new one.
import { toUIMessageStream, createUIMessageStreamResponse } from 'ai';
import type { DetachedRuns } from './detached.js';
import { readRunEvents, formatCursor, readCursor, type RunCursor, type RunEvent, type RunState } from './run-events.js';
import { decodeEvent, errorOf, type ErrorData } from './event-codec.js';
import type { Journal } from './journal.js';

/** How a run ended for its reader: its last state, and what that state carries. */
export interface RunEnding { state: RunState; interrupts?: unknown[]; error?: ErrorData }

export interface FollowedRun {
  runId: string;
  /** How the call that returned this found the run (`started`, `attached`, `finished`, `parked`, …). */
  state: string;
  /** Where this reader is (a door's `Last-Event-ID`): the last event's `seq`, or `seq.offset` mid-segment (run-events.ts). */
  cursor(): string;
  readonly fullStream: ReadableStream<any>;
  /** The answer's text, delta by delta (the AI SDK's `textStream`). */
  readonly textStream: ReadableStream<string>;
  readonly steps: Promise<any[]>;
  readonly text: Promise<string>;
  readonly finishReason: Promise<unknown>;
  readonly usage: Promise<unknown>;
  readonly totalUsage: Promise<unknown>;
  /** The run's ending as this reader saw it (undefined when the follow ended before the run did). */
  readonly ended: Promise<RunEnding | undefined>;
  toUIMessageStream(opts?: Record<string, unknown>): ReadableStream<any>;
  toUIMessageStreamResponse(opts?: Record<string, unknown> & { headers?: Record<string, string>; status?: number }): Response;
  toTextStreamResponse(init?: { headers?: Record<string, string>; status?: number }): Response;
  consumeStream(): Promise<void>;
}

const ENDINGS = new Set<RunState>(['completed', 'failed', 'canceled', 'waiting-approval', 'waiting-outcome']);

/** The steps of a run rebuilt from its events: per step, its text, tool calls, results and finish. A retried step is dropped. */
export function stepsFromEvents(events: RunEvent[]): any[] {
  const steps = new Map<number, { text: string; content: any[]; finishReason?: unknown; usage?: unknown }>();
  for (const ev of events) {
    if (ev.kind === 'step-retry') {
      const from = (ev.data as { step: number }).step;
      for (const k of [...steps.keys()]) if (k >= from) steps.delete(k);
      continue;
    }
    if (ev.step < 0) continue;
    const s = steps.get(ev.step) ?? { text: '', content: [] };
    steps.set(ev.step, s);
    const d = ev.data as any;
    if (ev.kind === 'text') s.text += d.text ?? '';
    else if (ev.kind === 'tool-call' || ev.kind === 'tool-result' || ev.kind === 'tool-error') s.content.push(decodeEvent(ev.kind, d));
    else if (ev.kind === 'step-finish') { s.finishReason = d.finishReason; s.usage = d.usage; }
  }
  return [...steps.entries()].sort((a, b) => a[0] - b[0]).map(([, s]) => ({
    content: [...(s.text ? [{ type: 'text', text: s.text }] : []), ...s.content],
    text: s.text,
    toolCalls: s.content.filter((c) => c.type === 'tool-call'),
    toolResults: s.content.filter((c) => c.type === 'tool-result'),
    finishReason: s.finishReason,
    usage: s.usage,
  }));
}

/** Every event of a run after `after`, page by page. */
export async function allRunEvents(journal: Journal, runId: string, after = 0): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for (let cursor = after; ;) {
    const page = await readRunEvents(journal, runId, cursor);
    if (!page.length) return out;
    out.push(...page);
    cursor = page[page.length - 1]!.seq;
  }
}

/** The ending a run's events record (its last ending status), if it has one. */
export function endingOf(events: RunEvent[]): RunEnding | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.kind === 'status' && ENDINGS.has((ev.data as RunEnding).state)) return ev.data as RunEnding;
  }
  return undefined;
}

/**
 * Follows a detached run as a stream result. `after` is the reader's cursor (0: from the start); every
 * access to `fullStream` follows from where this reader is. The follow ends when the run ends or waits on
 * a human (`untilPause`), or when `signal` aborts.
 *
 * @internal — the registry and the doors build it from a run they admitted; a host reads `gnl.follow`.
 */
export function followedRun(runs: DetachedRuns, req: { runId: string; scope?: string; journal: Journal; after: RunCursor | number; signal?: AbortSignal; state: string }): FollowedRun {
  // A caller's cursor is read by `readCursor` (run-events.ts) where it arrived — refused there, before a
  // run was started or joined, when it is not one. A plain `seq` (where `start` said to read from) is read
  // by the same grammar here.
  const start = typeof req.after === 'number' ? readCursor(req.after) : req.after;
  let cursor = start.seq;
  let offset = start.offset;
  let ending: RunEnding | undefined;
  let finishPart: any;
  let streamed = false;
  let resolveStreamed!: () => void;
  const streamOver = new Promise<void>((r) => { resolveStreamed = r; });
  const scope = req.scope !== undefined ? { scope: req.scope } : {};

  const makeStream = (): ReadableStream<any> => {
    streamed = true;
    const it = runs.follow({ runId: req.runId, ...scope, after: cursor, ...(offset ? { afterOffset: offset } : {}), ...(req.signal ? { signal: req.signal } : {}), untilPause: true });
    return new ReadableStream<any>({
      async pull(c) {
        try {
          for (;;) {
            const { value: ev, done } = await it.next();
            if (done) { c.close(); resolveStreamed(); return; }
            cursor = ev.seq;
            offset = ev.offset ?? 0;
            if (ev.kind === 'status') {
              const st = ev.data as RunEnding;
              if (ENDINGS.has(st.state)) {
                ending = st;
                // An ending its stream never carried (a limit, a refusal read from the steps) ends the stream
                // with it, the way the in-request stream's reader learnt it.
                if (st.state === 'failed' && st.error && !finishPart) { c.enqueue({ type: 'error', error: errorOf(st.error) }); return; }
              }
              continue;
            }
            const part = decodeEvent(ev.kind, ev.data);
            if (!part) continue;
            if (part.type === 'finish') finishPart = part;
            c.enqueue(part);
            return;
          }
        } catch (e) {
          resolveStreamed();
          c.error(e);
        }
      },
      async cancel() { await it.return(undefined); resolveStreamed(); },
    // Nothing read ahead: `cursor()` is the place of the part the reader holds, not of one queued behind it
    // (a door stamps it on the event it writes — a reconnect must resume after THAT event).
    }, { highWaterMark: 0 });
  };

  // What a reader asks after the stream: built once, from the whole log.
  let summary: Promise<{ steps: any[]; finish: any }> | undefined;
  const summarize = () => (summary ??= (async () => {
    if (streamed) await streamOver;
    else for await (const _ of runs.follow({ runId: req.runId, ...scope, after: cursor, ...(req.signal ? { signal: req.signal } : {}), untilPause: true })) { /* to its end */ }
    const events = await allRunEvents(req.journal, req.runId);
    ending ??= endingOf(events);
    const finish = [...events].reverse().find((e) => e.kind === 'finish');
    return { steps: stepsFromEvents(events), finish: finish?.data };
  })());

  const result: FollowedRun = {
    runId: req.runId,
    state: req.state,
    cursor: () => formatCursor(cursor, offset),
    get fullStream() { return makeStream(); },
    get textStream() {
      return makeStream().pipeThrough(new TransformStream<any, string>({ transform(p, c) { if (p.type === 'text-delta' && p.text) c.enqueue(p.text); } }));
    },
    get steps() { return summarize().then((s) => s.steps); },
    // As the AI SDK's result: the text of the LAST step (the answer), not of every step.
    // A run that ended in an error rejects its text, as the in-request stream's did — a reader awaiting
    // the answer learns that there is none (and why), instead of reading an empty one.
    get text() { return summarize().then((s) => { if (ending?.state === 'failed' && ending.error) throw errorOf(ending.error); return s.steps[s.steps.length - 1]?.text ?? ''; }); },
    get finishReason() { return summarize().then((s) => s.finish?.finishReason); },
    get usage() { return summarize().then((s) => s.finish?.totalUsage); },
    get totalUsage() { return summarize().then((s) => s.finish?.totalUsage); },
    get ended() { return summarize().then(() => ending); },
    toUIMessageStream(opts = {}) { return toUIMessageStream({ stream: makeStream(), ...opts } as any) as ReadableStream<any>; },
    toUIMessageStreamResponse(opts = {}) {
      const { headers, status, ...rest } = opts;
      return createUIMessageStreamResponse({ stream: result.toUIMessageStream(rest), ...(headers ? { headers } : {}), ...(status ? { status } : {}) } as any);
    },
    toTextStreamResponse(init = {}) {
      return new Response(result.textStream.pipeThrough(new TextEncoderStream()), { status: init.status ?? 200, headers: { 'content-type': 'text/plain; charset=utf-8', ...(init.headers ?? {}) } });
    },
    async consumeStream() { const r = makeStream().getReader(); while (!(await r.read()).done) { /* drain */ } },
  };
  return result;
}
