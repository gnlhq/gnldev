// THE RUN EVENT SCHEMA (v1) — how a detached run's stream is kept in its event log, and the ONE place it
// is translated to and from the AI SDK's stream parts.
//
// The log is persistent data: it outlives the library that produced it. Keeping the AI SDK's own part
// objects would tie every stored run to one release of that library — a renamed field, a new part type,
// and the runs written before it no longer read. So the log holds GNL's own small vocabulary, versioned
// (`v`), and this module is the only code that knows both sides: `encodePart` when the executor writes,
// `decodeEvent` when a reader rebuilds a stream a door's encoder (REST SSE, AG-UI, useChat) can read.
//
// The vocabulary keeps what a reader needs and nothing a provider sent for itself: text, reasoning, tool
// calls and their results (sentinels included — the doors' encoders hide them, as they always did), steps,
// sources, files (media type + base64), errors (message, name, code, detail — never a stack).

import * as EngineErrors from './errors.js';
import { RunCanceledError } from './cancel.js';
import { RunErasedError } from './erasure-fence.js';
import * as LimitErrors from './limits.js';

/** The schema version every event this module writes carries. */
export const RUN_EVENT_VERSION = 1;

/**
 * An error as an event keeps it: what a door classifies it by — name, code, detail, and for a provider's
 * failure its HTTP status and `Retry-After` (a door answers 429/502/504 from them). Never a stack, never a
 * provider's response body or other headers.
 */
export interface ErrorData { message: string; name?: string; code?: string; detail?: unknown; statusCode?: number; retryAfter?: string }

export function errorData(e: unknown): ErrorData {
  // A retry wrapper's own message says nothing; its last attempt's error is the failure.
  const r = e as { name?: unknown; lastError?: unknown } | null;
  const x = (r?.name === 'AI_RetryError' && r.lastError ? r.lastError : e) as { message?: unknown; name?: unknown; code?: unknown; detail?: unknown; statusCode?: unknown; responseHeaders?: Record<string, unknown> } | null;
  const retryAfter = x?.responseHeaders?.['retry-after'] ?? x?.responseHeaders?.['Retry-After'];
  return {
    message: String(x?.message ?? e),
    ...(typeof x?.name === 'string' && x.name !== 'Error' ? { name: x.name } : {}),
    ...(typeof x?.code === 'string' ? { code: x.code } : {}),
    ...(x?.detail !== undefined ? { detail: plain(x.detail) } : {}),
    ...(typeof x?.statusCode === 'number' ? { statusCode: x.statusCode } : {}),
    ...(typeof retryAfter === 'string' ? { retryAfter } : {}),
  };
}

/** The engine's own error classes, by name: an error read back from the log is an instance of its class again. */
const ERROR_CLASSES = new Map<string, { prototype: Error }>(
  ([...Object.values(EngineErrors), RunCanceledError, RunErasedError, ...Object.values(LimitErrors)] as unknown[])
    .filter((v): v is { prototype: Error; name: string } => typeof v === 'function' && (v as { prototype?: unknown }).prototype instanceof Error)
    .map((c) => [c.name, c]),
);

/**
 * An event's error back as an Error: an instance of the engine's class of the same name when there is one
 * (a caller's `instanceof` keeps working), with its name, code and detail — a door classifies it as it
 * classified the original.
 */
export function errorOf(e: ErrorData | undefined): Error {
  const cls = e?.name ? ERROR_CLASSES.get(e.name) : undefined;
  const err = (cls ? Object.create(cls.prototype) : new Error(e?.message ?? 'error')) as Error & { code?: string; detail?: unknown };
  if (cls) Object.defineProperty(err, 'message', { value: e?.message ?? 'error', writable: true, configurable: true });
  if (e?.name) err.name = e.name;
  if (e?.code) err.code = e.code;
  if (e?.detail !== undefined) err.detail = e.detail;
  if (e?.statusCode !== undefined) Object.assign(err, { statusCode: e.statusCode, ...(e.retryAfter !== undefined ? { responseHeaders: { 'retry-after': e.retryAfter } } : {}) });
  return err;
}

const plain = (v: unknown): any => (v === undefined ? undefined : JSON.parse(JSON.stringify(v, (_k, x) => (x instanceof Error ? errorData(x) : x instanceof Uint8Array ? undefined : x)) ?? 'null'));

/** The kinds of a stream's events (the executor adds `status` and `step-retry`). Deltas are the coalescable ones. */
export const DELTA_KINDS = new Set(['text', 'reasoning', 'tool-input-delta']);

/** A stream part as an event (`kind`, `data`), or undefined for a part the log does not keep. */
export function encodePart(part: any): { kind: string; data: Record<string, unknown> } | undefined {
  switch (part?.type) {
    case 'start': return { kind: 'start', data: {} };
    case 'start-step': return { kind: 'step-start', data: {} };
    case 'text-start': return { kind: 'text-start', data: { id: part.id } };
    case 'text-delta': return { kind: 'text', data: { id: part.id, text: part.text ?? part.delta ?? '' } };
    case 'text-end': return { kind: 'text-end', data: { id: part.id } };
    case 'reasoning-start': return { kind: 'reasoning-start', data: { id: part.id } };
    case 'reasoning-delta': return { kind: 'reasoning', data: { id: part.id, text: part.text ?? part.delta ?? '' } };
    case 'reasoning-end': return { kind: 'reasoning-end', data: { id: part.id } };
    case 'tool-input-start': return { kind: 'tool-input-start', data: { id: part.id ?? part.toolCallId, toolName: part.toolName } };
    case 'tool-input-delta': return { kind: 'tool-input-delta', data: { id: part.id ?? part.toolCallId, text: part.delta ?? '' } };
    case 'tool-input-end': return { kind: 'tool-input-end', data: { id: part.id ?? part.toolCallId } };
    case 'tool-call': return { kind: 'tool-call', data: { toolCallId: part.toolCallId, toolName: part.toolName, input: plain(part.input), ...(part.dynamic ? { dynamic: true } : {}) } };
    case 'tool-result': return { kind: 'tool-result', data: { toolCallId: part.toolCallId, toolName: part.toolName, input: plain(part.input), output: plain(part.output), ...(part.preliminary ? { preliminary: true } : {}), ...(part.dynamic ? { dynamic: true } : {}) } };
    case 'tool-error': return { kind: 'tool-error', data: { toolCallId: part.toolCallId, toolName: part.toolName, input: plain(part.input), error: errorData(part.error), ...(part.dynamic ? { dynamic: true } : {}) } };
    case 'source': return { kind: 'source', data: plain({ ...part, type: undefined }) };
    case 'file': return { kind: 'file', data: { mediaType: part.file?.mediaType, base64: part.file?.base64 } };
    case 'finish-step': return { kind: 'step-finish', data: { finishReason: plain(part.finishReason), usage: plain(part.usage) } };
    case 'finish': return { kind: 'finish', data: { finishReason: plain(part.finishReason), totalUsage: plain(part.totalUsage) } };
    case 'error': return { kind: 'error', data: { error: errorData(part.error) } };
    default: return undefined; // 'abort', 'raw' and anything unknown: transport-internal or the provider's own
  }
}

const NO_RESPONSE = { id: '', timestamp: new Date(0), modelId: '' };

/** An event as the stream part a door's encoder reads, or undefined for an executor event (status, step-retry). */
export function decodeEvent(kind: string, data: any): any {
  switch (kind) {
    case 'start': return { type: 'start' };
    case 'step-start': return { type: 'start-step', request: {}, warnings: [] };
    case 'text-start': return { type: 'text-start', id: data.id };
    case 'text': return { type: 'text-delta', id: data.id, text: data.text };
    case 'text-end': return { type: 'text-end', id: data.id };
    case 'reasoning-start': return { type: 'reasoning-start', id: data.id };
    case 'reasoning': return { type: 'reasoning-delta', id: data.id, text: data.text };
    case 'reasoning-end': return { type: 'reasoning-end', id: data.id };
    case 'tool-input-start': return { type: 'tool-input-start', id: data.id, toolName: data.toolName };
    case 'tool-input-delta': return { type: 'tool-input-delta', id: data.id, delta: data.text };
    case 'tool-input-end': return { type: 'tool-input-end', id: data.id };
    case 'tool-call': return { type: 'tool-call', toolCallId: data.toolCallId, toolName: data.toolName, input: data.input, ...(data.dynamic ? { dynamic: true } : {}) };
    case 'tool-result': return { type: 'tool-result', toolCallId: data.toolCallId, toolName: data.toolName, input: data.input, output: data.output, ...(data.preliminary ? { preliminary: true } : {}), ...(data.dynamic ? { dynamic: true } : {}) };
    case 'tool-error': return { type: 'tool-error', toolCallId: data.toolCallId, toolName: data.toolName, input: data.input, error: errorOf(data.error), ...(data.dynamic ? { dynamic: true } : {}) };
    case 'source': return { type: 'source', ...data };
    case 'file': return { type: 'file', file: { mediaType: data.mediaType, base64: data.base64 } };
    case 'step-finish': return { type: 'finish-step', finishReason: data.finishReason, usage: data.usage, response: NO_RESPONSE, providerMetadata: undefined };
    case 'finish': return { type: 'finish', finishReason: data.finishReason, totalUsage: data.totalUsage };
    case 'error': return { type: 'error', error: errorOf(data.error) };
    default: return undefined;
  }
}
