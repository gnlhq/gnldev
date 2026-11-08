// UseChat (AI SDK v5) wire format: a StreamTextResult's `toUIMessageStream()`/`toUIMessageStreamResponse()`
// already exist on the object streamDurable returns (packages/durable/src/run.ts's
// `guardStreamTerminalPromises` is a Proxy that BINDS methods off the real AI SDK StreamTextResult — it
// does not replace or hide them). This module wraps those two native entry points with a MANDATORY
// sentinel-masking transform: durable-tool.ts's three internal sentinels (`__gnl_suspend`,
// `__gnl_limit_exceeded`, `__gnl_blocked` — see packages/server/src/sse.ts's tool-result handling, which
// this is kept in sync with) show up as ordinary tool OUTPUTS in the native UI chunk stream and must
// never reach the browser verbatim (see sentinel-mask.ts for the shared masking shape).
//
// P0.2 `toUIMessageStreamResponse` here NEVER calls the native
// `result.toUIMessageStreamResponse()` directly — that would skip the masking transform entirely. It
// always builds the masked chunk stream first, then wraps it with `createUIMessageStreamResponse`.
//
// Chunk type names below (`tool-input-start`, `tool-input-available`, `tool-output-available`,
// `data-${string}`) are verified against the INSTALLED `ai` major's `UIMessageChunk` definition —
// tsc compiles this file against that .d.ts, so a renamed chunk type fails the build rather than
// silently passing through unmasked. (Originally verified on ai@5; re-verified on the ai@7 upgrade.)
import { createUIMessageStreamResponse } from 'ai';
import type { AsyncIterableStream, StreamTextResult, UIMessage, UIMessageChunk, UIMessageStreamOptions } from 'ai';
import { maskSentinelOutput } from './sentinel-mask.js';
import { refuseMisspelledNames, optionNames } from '@gnldev/options';
import { endAnswerOf, endUserError, upstreamWire, clientFeedOf } from '@gnldev/durable';

/** A `data-gnl-interrupt` chunk's payload — one entry per newly-masked suspend in this transform call.
 * FAZ-2: `runId` (when the caller provided one) is the approval ADDRESS — without it the client's
 * "approve" re-POST derives a FRESH runId from its new message id, the approval lands on a brand-new
 * run, and the suspended run stays suspended forever (retention keeps suspended runs deliberately →
 * unbounded accumulation). Approve by re-POSTing with THIS runId — see `approvalPayload`/`approve`. */
export interface GnlInterruptData {
  interrupts: Array<{ toolCallId: string; toolName: string; args: unknown; reason?: string; runId?: string }>;
}

/**
 * Wraps a native `UIMessageChunk` stream with sentinel masking:
 * a `tool-output-available` chunk whose `output` carries `__gnl_suspend` → the chunk's `output` is
 *    Replaced with `{ pending: 'approval', toolName, reason }`, and a `data-gnl-interrupt` chunk
 *    `{ type: 'data-gnl-interrupt', data: { interrupts: [...] } }` is appended right after it (so a
 *    `useChat` client can render an approval UI without inspecting tool internals).
 * `__gnl_limit_exceeded` / `__gnl_blocked` outputs → replaced with `{ blocked: true, code, message }`
 *    (no internal `detail`/raw fields leak).
 * everything else passes through untouched.
 * `toolName` is tracked from `tool-input-start`/`tool-input-available` chunks (`tool-output-available`
 * itself carries only `toolCallId`, not `toolName` — see the UIMessageChunk union in ai@5's .d.ts) so the
 * masked suspend payload can still report which tool is awaiting approval.
 */
function maskSentinelChunks(runId?: string): TransformStream<UIMessageChunk, UIMessageChunk> {
  const toolNames = new Map<string, string>();
  return new TransformStream<UIMessageChunk, UIMessageChunk>({
    transform(chunk, controller) {
      if (
        (chunk.type === 'tool-input-start' || chunk.type === 'tool-input-available' || chunk.type === 'tool-input-error') &&
        'toolName' in chunk
      ) {
        toolNames.set(chunk.toolCallId, chunk.toolName);
      }
      if (chunk.type === 'tool-output-available') {
        const { display, interrupts } = maskSentinelOutput(chunk.output, toolNames.get(chunk.toolCallId));
        if (display !== chunk.output) {
          controller.enqueue({ ...chunk, output: display });
          if (interrupts?.length) {
            // FAZ-2: stamp the run's id onto each interrupt — the client must approve THIS run, not a
            // freshly-derived one (see GnlInterruptData's JSDoc). ALL of them, not just the first: one
            // suspended parent can be standing in for several child questions, and the useChat channel
            // was the last surface still promising exactly one (see MaskedToolOutput.interrupts).
            const data: GnlInterruptData = { interrupts: runId ? interrupts.map((i) => ({ ...i, runId })) : interrupts };
            controller.enqueue({ type: 'data-gnl-interrupt', data } as UIMessageChunk);
          }
          return;
        }
      }
      controller.enqueue(chunk);
    },
  });
}

// Held to the INSTALLED ai's types by the compiler (`optionNames`): a name the SDK adds fails this
// build until it is listed here — which is how ai@7.0.132's `onStepEnd`/`onStepFinish` were found. At
// runtime the list only decides what counts as a misspelling, so an older 7.x is unaffected by it.
const UI_STREAM_NAMES = optionNames<UIMessageStreamOptions<UIMessage> & { runId?: string }>()([
  'originalMessages', 'generateMessageId', 'onStepEnd', 'onStepFinish', 'onEnd', 'onFinish', 'messageMetadata', 'sendReasoning',
  'sendSources', 'sendFinish', 'sendStart', 'onError', 'runId',
]);
const UI_RESPONSE_NAMES = optionNames<ToUIMessageStreamResponseOptions<UIMessage>>()([
  'originalMessages', 'generateMessageId', 'onStepEnd', 'onStepFinish', 'onEnd', 'onFinish', 'messageMetadata', 'sendReasoning',
  'sendSources', 'sendFinish', 'sendStart', 'onError', 'runId', 'consumeSseStream', 'headers', 'status', 'statusText',
]);

/**
 * What the chat stream's error part says, and where its cause goes. EVERY error is written to the server log
 * with its cause and the run it belongs to: the stream part is for the person, the log is for the developer.
 * The part itself: a provider failure says so (its status always, and outside production the credential-free
 * URL it called and a short masked excerpt of its body); an error gnl authored (`endUserError`: a busy run, a
 * limit, a step timeout, a caller conflict) is named, with its code; every other error keeps the masked
 * default — its text is never sent to an end user, it may hold a password or a hostname.
 */
function chatErrorText(error: unknown, runId?: string): string {
  console.error(`@gnldev/chat-adapter: run '${runId ?? '?'}' ended with an error:`, error);
  // Read from THE one mapping of how a run ended (`endAnswerOf`, @gnldev/durable) — the same one `/run`, `/stream` and AG-UI render.
  const up = endAnswerOf(error)?.upstream;
  if (up) {
    const prod = typeof process !== 'undefined' && process.env?.NODE_ENV === 'production';
    const all = upstreamWire(up);
    const wire = prod ? {} : all;
    // The model and provider are configuration, so production says them too (a URL often names neither).
    const who = all.upstreamModel ? ` from ${all.upstreamProvider ? `${all.upstreamProvider} ` : ''}'${all.upstreamModel}'` : '';
    return `Model provider error${up.upstreamStatus !== undefined ? ` (HTTP ${up.upstreamStatus})` : ''}${who}${wire.upstreamUrl ? ` at ${wire.upstreamUrl}` : ''}${wire.upstreamBody ? `: ${wire.upstreamBody}` : ''}`;
  }
  const ours = endUserError(error);
  return ours ? `${ours.code ? `[${ours.code}] ` : ''}${ours.message}` : 'An error occurred.';
}

/**
 * Thin wrapper over `result.toUIMessageStream()` with the sentinel-masking transform ALWAYS applied.
 * `result` is whatever `gnl.stream()`/`streamDurable` returns (a real AI SDK `StreamTextResult` under a
 * method-binding Proxy — see run.ts's `guardStreamTerminalPromises`).
 */
export function toUIMessageStream<UI_MESSAGE extends UIMessage = UIMessage>(
  result: Pick<StreamTextResult<any, any, any>, 'toUIMessageStream'>,
  opts?: UIMessageStreamOptions<UI_MESSAGE> & { runId?: string },
): AsyncIterableStream<UIMessageChunk> {
  // The rest goes on to the AI SDK: a misspelling of a known name is refused, a newer SDK's name passes.
  refuseMisspelledNames('toUIMessageStream', opts, UI_STREAM_NAMES);
  // FAZ-2: `runId` is OURS (stamped onto interrupt chunks), not the AI SDK's — split it off before
  // handing the rest to the native stream builder.
  const { runId, ...native } = opts ?? {};
  // The AI SDK masks every stream error as "An error occurred." — right for a bug in the host, but it
  // hid the one fact a failing provider call carries (its status), and the URL that shows a wrong
  // baseURL / model type. A provider failure says so, so does an error gnl authored; anything else keeps the
  // masked default (and every error is logged — see chatErrorText).
  if (native.onError === undefined) native.onError = (error) => chatErrorText(error, runId);
  // Whether the model's reasoning goes to the client: @gnldev/durable's feed rule (off unless `stream: { reasoning: true }`); an explicit `sendReasoning` of the caller wins.
  if (native.sendReasoning === undefined) native.sendReasoning = clientFeedOf(result).reasoning;
  const nativeStream = result.toUIMessageStream(native as UIMessageStreamOptions<UI_MESSAGE>);
  // PipeThrough on a WHATWG ReadableStream keeps async-iterability (verified: Node's native
  // ReadableStream implements Symbol.asyncIterator; ai's own AsyncIterableStream helper relies on the
  // same `pipeThrough(new TransformStream())` pattern — see ai/dist/index.mjs's createAsyncIterableStream).
  return nativeStream.pipeThrough(maskSentinelChunks(runId)) as AsyncIterableStream<UIMessageChunk>;
}

/**
 * `UIMessageStreamResponseInit` (the native method's other option half) is NOT exported by the `ai`
 * package (private type) — this mirrors its structural shape (verified against
 * `toUIMessageStreamResponse`'s declared parameter in the INSTALLED ai major's .d.ts; originally on
 * ai@5, re-checked on the ai@7 upgrade) without importing a name that isn't part of the package's
 * public surface.
 */
export interface ToUIMessageStreamResponseOptions<UI_MESSAGE extends UIMessage = UIMessage>
  extends UIMessageStreamOptions<UI_MESSAGE>,
    ResponseInit {
  consumeSseStream?: (options: { stream: ReadableStream<string> }) => PromiseLike<void> | void;
  /** FAZ-2: stamped onto `data-gnl-interrupt` chunks as the approval address (see GnlInterruptData). */
  runId?: string;
}

/**
 * Thin wrapper over `createUIMessageStreamResponse` — ALWAYS runs the masking transform (see the module
 * header note: calling the native `result.toUIMessageStreamResponse()` directly is deliberately never
 * done here, since that would bypass masking).
 */
export function toUIMessageStreamResponse<UI_MESSAGE extends UIMessage = UIMessage>(
  result: Pick<StreamTextResult<any, any, any>, 'toUIMessageStream'>,
  opts?: ToUIMessageStreamResponseOptions<UI_MESSAGE>,
): Response {
  refuseMisspelledNames('toUIMessageStreamResponse', opts, UI_RESPONSE_NAMES);
  const { status, statusText, headers, consumeSseStream, ...streamOpts } = opts ?? {};
  const stream = toUIMessageStream(result, streamOpts as UIMessageStreamOptions<UI_MESSAGE> | undefined);
  return createUIMessageStreamResponse({ status, statusText, headers, consumeSseStream, stream });
}
