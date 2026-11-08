// The agent stream wire schema, owned in ONE place and free of any HTTP framework: a StreamTextResult
// in, `{ event, data }` out. @gnldev/server and @gnldev/studio each wrap it in a few lines of SSE
// writing. They used to carry two copies of this mapping kept "in sync" by comment, and the copies
// drifted — the REST stream hid the internal limit/blocked sentinels and ended with a typed `error`;
// the playground leaked the sentinel and ended with `done`.
//
// Schema (event → data): text-delta {text} · tool-call {toolCallId,toolName,input} · tool-result {…}
// reasoning-start/delta/end · tool-input-start/delta/end · source · file · step-start · step-finish
// tool-error (non-terminal) · raw {type} (unknown part, payload withheld) · error {error,code?,detail?}
// (terminal) · interrupt {runId,interrupts[]} · done {runId,finishReason,usage}.
//
// Every known part has a case. The first version knew four part types and had no default, so every
// reasoning-*/source/file/step-*/tool-input-* part was SILENTLY DROPPED (a reasoning model's whole
// thinking trace vanished with no error). A few parts are deliberately not events ('start'/'finish'
// → covered by done; 'text-start'/'text-end' → text framing is delta-only; 'abort'/'raw' →
// transport-internal), and anything else becomes `raw {type}`: type only, payload withheld, so an
// unknown part can neither vanish nor leak an internal payload.
import { limitBreachFromSteps, blockedFromSteps, surfacedInterrupts } from './run.js';
import { BLOCKED_ERROR_CODES, endAnswerOf, withRunHandle } from './errors.js';
import type { Interrupt } from './guard.js';

export interface AgentStreamEvent { event: string; data: unknown }

/** The wire codes for the two limit endings — the SURFACE owns them (each enumerates its own codes). */
export interface AgentStreamCodes { runLimitExceeded: string; toolLoopDetected: string }

/** Suspended tool calls in a finished step list, surfaced the way runDurable surfaces them. */
export function interruptsFromSteps(steps: any[]): Interrupt[] {
  const out: Interrupt[] = [];
  for (const step of steps ?? []) {
    for (const part of step?.content ?? []) {
      if (part?.type === 'tool-result' && part.output?.__gnl_suspend) out.push(...surfacedInterrupts(part.output.__gnl_suspend));
    }
  }
  return out;
}

const errText = (e: any) => String(e?.message ?? e);

/**
 * WHICH EVENTS REACH THE CLIENT — the one owner of that rule. The model's reasoning is its inner
 * workings (internal rules, tool names, hidden context can sit in it): it stays off the wire unless the
 * developer turns it on with `stream: { reasoning: true }` (createGnl config, or per call). The journal
 * keeps it either way — it is the run's record, not the client feed. Every wire format asks `reachesClient`
 * (this module's REST/Studio events, AG-UI's events, the chat door's `sendReasoning`), so a rule added here
 * holds on all of them at once.
 */
export interface StreamFeed { readonly reasoning: boolean }
export const DEFAULT_STREAM_FEED: StreamFeed = { reasoning: false };

/** The feed of one call: the per-call value wins over the instance config, field by field; reasoning is off by default. */
export function resolveStreamFeed(config?: { reasoning?: boolean }, call?: { reasoning?: boolean }): StreamFeed {
  const reasoning = call?.reasoning ?? config?.reasoning;
  if (reasoning !== undefined && typeof reasoning !== 'boolean') throw new TypeError("@gnldev/durable: `stream.reasoning` must be true or false");
  return { reasoning: reasoning ?? DEFAULT_STREAM_FEED.reasoning };
}

/** Whether a stream part of this type goes to the client under `feed`. */
export function reachesClient(partType: string, feed: StreamFeed): boolean {
  return feed.reasoning || !partType.startsWith('reasoning-');
}

/**
 * What a stream result knows about its run that a wire format needs and cannot read from the stream itself:
 * handed over by the registry that started the run (it holds the journal), read here. A result without it
 * (a plain `streamDurable`, a test double) simply has no run facts, and an answer says nothing it cannot know.
 */
export interface StreamFacts { effectsRan(): Promise<boolean>; feed: StreamFeed }
const FACTS_KEY = '__gnlStreamFacts';
export function attachStreamFacts(result: object, facts: StreamFacts): void {
  Object.defineProperty(result, FACTS_KEY, { value: facts });
}
export const streamFactsOf = (result: any): StreamFacts | undefined => result?.[FACTS_KEY];
/** The feed a result was started with; reasoning off for a result that carries none. */
export const clientFeedOf = (result: any): StreamFeed => streamFactsOf(result)?.feed ?? DEFAULT_STREAM_FEED;

/** The terminal `error` event for a failed stream: the body of THE one mapping (`endAnswerOf`) — code and all — or just its text when the error is the host's own; a provider failure also names the run and what already ran. */
async function errorEvent(error: unknown, runId: string, result: any): Promise<AgentStreamEvent> {
  const a = endAnswerOf(error);
  if (!a) return { event: 'error', data: { error: errText(error) } };
  const facts = streamFactsOf(result);
  return { event: 'error', data: (facts ? await withRunHandle(a, runId, () => facts.effectsRan()) : a).body };
}

export async function* agentStreamEvents(result: any, runId: string, codes: AgentStreamCodes): AsyncGenerator<AgentStreamEvent> {
  const feed = clientFeedOf(result);
  try {
    for await (const part of result.fullStream) {
      if (!reachesClient(part.type, feed)) continue;
      switch (part.type) {
        case 'text-delta': { const text = part.text ?? part.delta ?? ''; if (text) yield { event: 'text-delta', data: { text } }; break; }
        case 'tool-call': yield { event: 'tool-call', data: { toolCallId: part.toolCallId, toolName: part.toolName, input: part.input } }; break;
        case 'tool-result':
          // The three sentinels are internal API: suspend is carried by `interrupt`, limit/blocked by the terminal `error`.
          if (part.output?.__gnl_suspend || part.output?.__gnl_limit_exceeded || part.output?.__gnl_blocked) break;
          // A streaming tool's yield before its last: progress of a call still running (`tool-progress`).
          if (part.preliminary) { yield { event: 'tool-progress', data: { toolCallId: part.toolCallId, toolName: part.toolName, progress: part.output } }; break; }
          yield { event: 'tool-result', data: { toolCallId: part.toolCallId, toolName: part.toolName, output: part.output } }; break;
        case 'reasoning-start': yield { event: 'reasoning-start', data: { id: part.id } }; break;
        case 'reasoning-delta': { const text = part.text ?? part.delta ?? ''; if (text) yield { event: 'reasoning-delta', data: { id: part.id, text } }; break; }
        case 'reasoning-end': yield { event: 'reasoning-end', data: { id: part.id } }; break;
        case 'tool-input-start': yield { event: 'tool-input-start', data: { toolCallId: part.toolCallId ?? part.id, toolName: part.toolName } }; break;
        case 'tool-input-delta': yield { event: 'tool-input-delta', data: { toolCallId: part.toolCallId ?? part.id, delta: part.delta } }; break;
        case 'tool-input-end': yield { event: 'tool-input-end', data: { toolCallId: part.toolCallId ?? part.id } }; break;
        case 'source': yield { event: 'source', data: { sourceType: part.sourceType, id: part.id, url: part.url, title: part.title } }; break;
        case 'file': yield { event: 'file', data: { mediaType: part.file?.mediaType, base64: part.file?.base64 } }; break;
        case 'start-step': yield { event: 'step-start', data: {} }; break;
        case 'finish-step': yield { event: 'step-finish', data: { finishReason: part.finishReason, usage: part.usage } }; break;
        case 'tool-error': yield { event: 'tool-error', data: { toolCallId: part.toolCallId, toolName: part.toolName, error: errText(part.error) } }; break;
        case 'error': yield await errorEvent(part.error, runId, result); break;
        // The run's reader is told what it waits for (a takeover): the run's own `status` vocabulary, on the wire (followed-run.ts).
        case 'gnl-status': yield { event: 'status', data: { state: part.state } }; break;
        // Deliberately no event: covered by done / delta-only framing / transport-internal.
        case 'start': case 'finish': case 'text-start': case 'text-end': case 'abort': case 'raw': break;
        default: yield { event: 'raw', data: { type: part.type } }; // never silent, never the payload
      }
    }
    const steps = await result.steps;
    const breach = limitBreachFromSteps(steps);
    if (breach) {
      yield { event: 'error', data: { error: breach.message, code: breach.kind === 'loop' ? codes.toolLoopDetected : codes.runLimitExceeded, detail: breach.detail } };
      return;
    }
    const blocked = blockedFromSteps(steps);
    if (blocked) {
      yield { event: 'error', data: { error: blocked.message, code: BLOCKED_ERROR_CODES[blocked.code] ?? 'run_busy', detail: blocked.detail } };
      return;
    }
    const interrupts = interruptsFromSteps(steps);
    if (interrupts.length) yield { event: 'interrupt', data: { runId, interrupts } };
    const finishReason = await Promise.resolve(result.finishReason).catch(() => undefined);
    const usage = await Promise.resolve(result.usage).catch(() => undefined);
    yield { event: 'done', data: { runId, finishReason, usage } };
  } catch (e) {
    yield await errorEvent(e, runId, result);
  }
}
