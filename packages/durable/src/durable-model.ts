import { wrapLanguageModel, simulateReadableStream } from 'ai';
import { requestOf, bornOnFirstWrite } from './run-identity.js';
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4Middleware } from '@ai-sdk/provider';
import { argsHash, stableStringify } from './hash.js';
import { ctxGet, runKeys } from './journal.js';
import { AttemptLost, compareAndSet } from './attempt.js';
import { stampFormat } from './format.js';
import { enforceStepLimits } from './limits.js';
import { assertNotCanceled } from './cancel.js';
import { isDraining, RunDrainedError, procStampFor, bindOwnLiveness } from './process-liveness.js';
import { claimIsLive, newHoldId, holdHere, releaseHold } from './liveness.js';
import { assertNotErased } from './erasure-fence.js';
import { settleModelContent } from './time-travel.js';
import { RunBusyError } from './errors.js';
import { withTimeout } from './timeout.js';
import type { DurableCtx } from './journal.js';
import type { JournalReader } from './journal.js';
import { refuseUnknownNames } from '@gnldev/options';
import { DURABLE_MODEL_NAMES, EXCLUSIVE_STEP_NAMES } from './option-names.js';

/**
 * Wraps the model: RECORDS every LLM response into the journal keyed by (runId, stepIndex);
 * on resume, REPLAYS the same response → the agent makes the same decision (deterministic replay).
 *
 * stepIndex only advances after a SUCCESSFUL generate; on a transient error (retry) the same
 * key is reused → retries do not shift the replay key.
 */

// Model-step write-ahead claim record — SAME IDEA as durableTool's 'running'/'succeeded'/'failed'
// claim pattern, but carries a model-specific field (reqHash).
type ModelClaimRecord = { status: 'running' | 'succeeded' | 'failed'; startedAt: number; reqHash?: string };

/**
 * the core-hardening review (opt-in): model-step exclusivity. When enabled, the worker that LOSES the
 * claim race gets a `RunBusyError` if the existing record is 'running' and FRESH (startedAt newer
 * than ttlMs ago) → prevents duplicate `doGenerate` (double token cost) under concurrent multi-resume.
 * STALE 'running' (crashed owner) continues with the existing behavior — the fast crash-resume window
 * is NOT BROKEN.
 */
export type ExclusiveStepOptions = { ttlMs?: number };

/** Opt-in behavior switches for withDurableModel (default: all off = existing behavior). */
export type DurableModelOptions = {
  exclusiveStep?: ExclusiveStepOptions;
  /**
   * Y1 (opt-in): model step timeout (ms). Applied to the entire doGenerate in generate; in stream,
   * applied to the doStream call (up to the first byte) — NOT to the entire streaming flow (the
   * stream already progresses in chunks, the hang risk is in connection setup). On timeout,
   * StepTimeoutError is thrown → claim is marked 'failed', retry/resume retries the same step
   * (replay key does not shift).
   */
  stepTimeoutMs?: number;
};

// §5.3: default for the "fresh running" threshold — same order of magnitude as run-lock TTLs (seconds).
const DEFAULT_EXCLUSIVE_TTL_MS = 30_000;

// H2: use the storage's own clock if available (clock-skew-resistant TTL decision), otherwise Date.now.
async function journalNow(ctx: DurableCtx): Promise<number> {
  return ctx.journal.now ? ctx.journal.now() : Date.now();
}

/**
 * The claim one attempt at a model step wrote: its later writes to the claim are compare-and-sets over
 * exactly this value, so an attempt whose claim was taken over writes nothing over the taker's.
 */
type ModelClaim = { hold: string | undefined; mine: ModelClaimRecord };

/**
 * §5.3: write the model-step 'running' claim — with an optional exclusivity gate.
 *
 * exclusive OFF (default): unconditional `put` (overwrites), never throws. Two attempts may then call
 * the model for one step; the step is still answered once (`answerStep`).
 * exclusive ON: tries an atomic `claim` (putIfAbsent); if lost, checks the existing record:
 * 'running' + LIVE (`claimIsLive`: held by an attempt in this process, or by a live process, else younger than
 *     ttlMs) → `RunBusyError` (another worker is processing that step).
 * 'running' + STALE / 'failed' / other → taken over by compare-and-set over the record read (the
 *     double-call risk is deliberately accepted — the FAST resume after a real crash happens in this
 *     window). Two takers of one stale claim: one wins, the other meets a live claim and is busy.
 * NOTE: RunBusyError is thrown WITHOUT touching the claim (the record belongs to the other worker) and
 * since it's not an APICallError, it isn't swallowed by the AI SDK's retry — it reaches the caller as-is.
 */
async function acquireModelClaim(
  ctx: DurableCtx,
  claimKey: string,
  reqHash: string | undefined,
  exclusive: ExclusiveStepOptions | undefined,
): Promise<ModelClaim> {
  if (!exclusive) {
    const mine: ModelClaimRecord = { status: 'running', startedAt: Date.now(), reqHash };
    await ctx.journal.put(claimKey, mine);
    return { hold: undefined, mine };
  }
  // The claim names this process and this call (liveness.ts): a holder that stalls past the step TTL keeps
  // it — judged by the one rule every claim is judged by, not by its age alone.
  await bindOwnLiveness(ctx.journal);
  const ttlMs = exclusive.ttlMs ?? DEFAULT_EXCLUSIVE_TTL_MS;
  for (let round = 0; ; round++) {
    const now = await journalNow(ctx);
    const hold = newHoldId();
    const mine = { status: 'running' as const, startedAt: now, reqHash, ...procStampFor(ctx.journal), hold };
    const existing = await ctx.journal.get<ModelClaimRecord & { proc?: string; hold?: string }>(claimKey);
    const busy = existing !== undefined && (await claimIsLive(existing, now, ttlMs, ctx.journal));
    // STALE running (crash) / failed (retry) / leftover succeeded → taken over, over the record read.
    if (!busy && (await compareAndSet(ctx.journal, claimKey, existing, mine))) {
      holdHere(hold, ctx.journal);
      return { hold, mine };
    }
    if (busy || round >= 2) {
      throw new RunBusyError(
        `model step '${claimKey}' is being processed by another worker (claim ${now - (existing?.startedAt ?? now)}ms old, ttl ${ttlMs}ms)`,
      );
    }
  }
}

/** The claim's outcome, written over this attempt's own claim only: one that was taken over is the taker's to settle. */
async function settleModelClaim(ctx: DurableCtx, claimKey: string, claimed: ModelClaim, status: 'succeeded' | 'failed', reqHash: string | undefined): Promise<void> {
  await compareAndSet(ctx.journal, claimKey, claimed.mine, { status, startedAt: Date.now(), reqHash });
}

/**
 * A model step is answered ONCE. The first complete answer recorded for (run, step) is the step's
 * answer, and every attempt at the step returns it — the attempt that recorded it, a twin that called
 * the model beside it, a holder that stalled or was partitioned past its claim and woke after a
 * takeover had answered. An attempt's own answer is another plan: other tool calls under other
 * toolCallIds, which durableTool cannot collapse into the recorded ones, so returning it ran a second
 * set of side effects beside the first (measured: two charges for one step). The answer is the run's
 * history; nothing writes over it.
 *
 * `mine` is what this attempt has tried to write to the step so far (the write-ahead copies of its own
 * stream; empty on the generate path): the next write is a compare-and-set over the last of them. A
 * write whose outcome it never saw (the journal threw) may or may not have landed, so what stands
 * there is read: nothing, or a copy of its own, is still its own to write over. Returns the step's
 * answer as recorded — this attempt's own when it won, or the one that was there (`lost: true`).
 */
async function answerStep(ctx: DurableCtx, key: string, mine: object[], next: object): Promise<{ lost: boolean; recorded: unknown }> {
  let expected: unknown = mine[mine.length - 1];
  mine.push(next);
  for (let round = 0; round < 3; round++) {
    if (await compareAndSet(ctx.journal, key, expected, next)) return { lost: false, recorded: next };
    const raw = await ctx.journal.get<unknown>(key);
    if (raw !== undefined && !mine.some((m) => stableStringify(m) === stableStringify(raw))) break;
    expected = raw;
  }
  const recorded = await ctxGet<unknown>(ctx, key);
  if (recorded === undefined) throw new AttemptLost(key); // the step's record went away under this attempt (an erasure)
  return { lost: true, recorded };
}

// DETERMINISTIC components of the model request: messages/tool schema/sampling parameters.
// DELIBERATELY EXCLUDED fields (nondeterministic/opaque → should not produce false positives):
// abortSignal (a fresh object on every call), headers (may carry trace/request-id),
// providerOptions (some providers may inject a timestamp/nonce).
const DETERMINISTIC_PARAM_KEYS = [
  'prompt',
  'maxOutputTokens',
  'temperature',
  'stopSequences',
  'topP',
  'topK',
  'presencePenalty',
  'frequencyPenalty',
  'responseFormat',
  'seed',
  'tools',
  'toolChoice',
] as const;

/**
 * Hash of the model request's determining input (parity with argsHash — the same
 * stableStringify+sha256 pattern). If a field is not serializable (e.g. a circular reference),
 * SILENTLY returns `undefined` → the check is SKIPPED, the run is never BROKEN because of this
 * (PROTECTIVE).
 */
function safeRequestHash(params: LanguageModelV4CallOptions): string | undefined {
  try {
    const picked: Record<string, unknown> = {};
    for (const k of DETERMINISTIC_PARAM_KEYS) {
      const v = (params as Record<string, unknown>)[k];
      if (v !== undefined) picked[k] = v;
    }
    return argsHash(picked);
  } catch {
    return undefined;
  }
}

/**
 * Replay divergence check: DELIBERATELY soft.
 *
 * Observation (discovered while making this change, by running the full test suite): in flows using
 * memory/input-processor, when the caller calls `runDurable` again with the SAME raw arguments
 * (not resumeRun — a common pattern in tests/real usage), the input already written to the journal by
 * `persistInput` is NOT READ BACK; the input processor/memory injection does NOT RUN AGAIN on resume
 * due to idempotency. Result: the `params` the model SEES in this second call may differ from the
 * first run — but this is HARMLESS because that step is already REPLAYED from the journal (the live
 * model is never called). This produces a FALSE POSITIVE for a hard error (an existing, working usage
 * pattern). Therefore: (1) only produce a CHECK/WARNING when `replay:'strict'` (opt-in visibility — no
 * noise for the default user), (2) NEVER THROW a DivergenceError (only console.warn) — the model
 * request is a much broader/noisier surface than a tool argument; a hard error risks breaking a
 * legitimate resume.
 */
async function warnOnModelDivergence(
  ctx: DurableCtx,
  claimKey: string,
  key: string,
  reqHash: string | undefined,
  label: string,
): Promise<void> {
  if (ctx.replay !== 'strict' || reqHash === undefined) return;
  const claimed = await ctxGet<ModelClaimRecord>(ctx, claimKey);
  if (claimed?.reqHash !== undefined && claimed.reqHash !== reqHash) {
    console.warn(`@gnldev/durable: divergence — ${label} (${key}) produced a different request on replay (informational; run not stopped)`);
  }
}


/**
 * A truncated (write-ahead) record, made replayable.
 *
 * The write-ahead copy is cut off at the tool-call chunk, so it has no `finish` part. AI SDK 5
 * executed a tool the moment its call arrived, so replaying those chunks was enough to carry the
 * recorded work forward. AI SDK 7 defers tool execution to the END of a step — measured against
 * ai@7.0.66 — so a stream that never says it finished completes no tools at all: the resume of a
 * crashed run produces silence, which is the exact opposite of what the checkpoint was written for.
 *
 * Appending the missing terminator is honest rather than inventive. The record already tells us what
 * the model produced; the only thing absent is the marker saying it stopped, and the run DID stop —
 * that is why the record is partial. `finishReason` is derived from the recorded content, and usage
 * is zeroed because the truncated record genuinely never carried it (billing a guess would be worse
 * than billing nothing). warnOnPartialReplay has already told the operator this record is partial.
 *
 * Exactly-once is unaffected: the tool calls this lets through are still gated per toolCallId by
 * durableTool, so a tool that already ran replays from its own record instead of running again.
 */
function completeIfTruncated(hit: StreamStepRecord): unknown[] {
  const parts = hit.parts ?? [];
  if (hit.partial !== true) return parts as unknown[];
  if (parts.some((p: any) => p?.type === 'finish')) return parts as unknown[];
  const hasToolCall = parts.some((p: any) => p?.type === 'tool-call');
  return [
    ...parts,
    {
      type: 'finish',
      finishReason: { unified: hasToolCall ? 'tool-calls' : 'stop', raw: 'gnl:partial-replay' },
      usage: {
        inputTokens: { total: 0, noCache: 0, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 0, text: 0, reasoning: undefined },
      },
    },
  ];
}

/** The journaled shape of a streaming step; `partial: true` is only ever set by the write-ahead copy. */
type StreamStepRecord = { parts?: unknown[]; rest?: Record<string, unknown>; partial?: boolean };

/**
 * Memo for the partial-replay warning, keyed on the journal object so it cannot outlive it (same
 * shape as the fallback warnings in journal.ts/limits.ts). The inner set only grows with genuinely
 * partial replays — one entry per crashed step — not per run.
 */
const partialReplayWarned = new WeakMap<object, Set<string>>();

/**
 * A replayed step can be a TRUNCATED one, and nothing used to say so.
 *
 * The streaming recorder below writes a write-ahead copy of the step the moment a tool call arrives
 * (`{ parts, rest, partial: true }`, cut off at that chunk — see stream-crash-window.test.ts). That
 * copy is what a crash-resume reads, and replaying it is the RIGHT call: it is precisely what stops
 * the resume from re-planning and running the side effect a second time. But it is NOT what the model
 * finished saying. Everything streamed after the tool call was never journaled, so the resumed
 * assistant turn ends at the tool call — no closing text, no finish reason, no usage.
 *
 * Serving that as truth without a word is how an operator ends up staring at an assistant turn with
 * its tail missing and nothing anywhere explaining why. So: replay it, and SAY SO — once per
 * (runId, step), naming what the record concretely lacks rather than a generic 'partial data' line.
 */
function warnOnPartialReplay(ctx: DurableCtx, hit: StreamStepRecord, key: string, step: number): void {
  if (hit?.partial !== true) return;
  let seen = partialReplayWarned.get(ctx.journal);
  if (!seen) {
    seen = new Set<string>();
    partialReplayWarned.set(ctx.journal, seen);
  }
  if (seen.has(key)) return;
  seen.add(key);

  const parts = Array.isArray(hit.parts) ? (hit.parts as Array<{ type?: string }>) : [];
  const count = (type: string) => parts.filter((p) => p?.type === type).length;
  // Name what a flushed record would have carried and this one does not — the tail of a stream is
  // exactly the `finish` part plus whatever blocks were still open when the write-ahead fired.
  const missing: string[] = [];
  if (count('finish') === 0) missing.push('the `finish` part (finishReason + usage for this step)');
  const openText = count('text-start') - count('text-end');
  if (openText > 0) missing.push(`the end of ${openText} text block(s) still open at the cut`);
  const openReasoning = count('reasoning-start') - count('reasoning-end');
  if (openReasoning > 0) missing.push(`the end of ${openReasoning} reasoning block(s) still open at the cut`);

  console.warn(
    `@gnldev/durable: replaying a PARTIAL model step — '${key}' (run '${ctx.runId}', step ${step}) was journaled ` +
      'mid-stream by the write-ahead checkpoint on its tool call, not at stream end: the record carries ' +
      `\`partial: true\` and ${parts.length} chunk(s). Absent from it: ` +
      `${missing.length > 0 ? missing.join(', ') : 'whatever followed the tool call'}. ` +
      'Whatever the model streamed AFTER its tool call was never journaled, so this resumed turn ends at the ' +
      'tool call. The tool calls it DID make are recorded — which is why this record is replayed instead of ' +
      're-planned (re-planning would re-run the side effect). Start a fresh runId if you need a complete turn.',
  );
}

/**
 * (entry-point switch breaks replay silently): a model step is journaled in one of TWO shapes —
 * `wrapGenerate` writes the raw doGenerate result (has `content`, NO `.parts`); `wrapStream` writes
 * `{ parts, rest }` (has a `parts` array). If a run created on one path is resumed on the OTHER, the
 * replayed record is the wrong shape: a generate record fed to `simulateReadableStream({ chunks: hit.parts })`
 * has `hit.parts === undefined` → a broken/empty stream; a stream record returned as a generate result is
 * missing `content`. Both used to fail cryptically (or silently). This throws a CLEAR error naming the
 * mismatch so the caller resumes through the same entry point (or starts a fresh runId).
 */
/**
 * ONE STEP, EITHER PATH (design decision D5). A step journaled by one path is read by the other: a
 * registry run executes on the stream path, while a host that resumes it directly (`resumeRun`,
 * `runDurable`) reads on the generate path — and runs born before the stream path became the registry's
 * were journaled as generate results. The conversion is mechanical: a generate result's content becomes
 * the parts a provider streams for it; a streamed step's parts become the content it generated.
 */
function asStreamRecord(hit: unknown): StreamStepRecord {
  const h = hit as StreamStepRecord & { content?: any[]; finishReason?: unknown; usage?: unknown; warnings?: unknown[]; providerMetadata?: unknown };
  if (Array.isArray(h?.parts)) return h;
  const parts: any[] = [{ type: 'stream-start', warnings: h?.warnings ?? [] }];
  let n = 0;
  for (const c of h?.content ?? []) {
    if (c?.type === 'text') { const id = `t${n++}`; parts.push({ type: 'text-start', id }, { type: 'text-delta', id, delta: c.text }, { type: 'text-end', id }); }
    else if (c?.type === 'reasoning') { const id = `r${n++}`; parts.push({ type: 'reasoning-start', id }, { type: 'reasoning-delta', id, delta: c.text }, { type: 'reasoning-end', id }); }
    else parts.push(c);
  }
  parts.push({ type: 'finish', finishReason: h?.finishReason, usage: h?.usage, ...(h?.providerMetadata ? { providerMetadata: h.providerMetadata } : {}) });
  const { content: _c, finishReason: _f, usage: _u, warnings: _w, providerMetadata: _p, ...rest } = (h ?? {}) as Record<string, unknown>;
  return { parts, rest };
}

function asGenerateRecord(hit: unknown): unknown {
  const h = hit as StreamStepRecord;
  if (!Array.isArray(h?.parts)) return hit;
  const parts = completeIfTruncated(h) as any[];
  // The content is time-travel's one reading of a streamed step (settleModelContent) — not a second copy.
  const finish = parts.find((p: any) => p?.type === 'finish');
  const warnings = parts.find((p: any) => p?.type === 'stream-start')?.warnings ?? [];
  return { ...(h.rest ?? {}), content: settleModelContent({ parts }), finishReason: finish?.finishReason, usage: finish?.usage, warnings, ...(finish?.providerMetadata ? { providerMetadata: finish.providerMetadata } : {}) };
}

export function withDurableModel(model: LanguageModelV4, ctx: DurableCtx, opts?: DurableModelOptions): LanguageModelV4 {
  refuseUnknownNames('withDurableModel', opts, DURABLE_MODEL_NAMES);
  refuseUnknownNames('withDurableModel: exclusiveStep', opts?.exclusiveStep, EXCLUSIVE_STEP_NAMES);
  let step = 0;
  // The run is born at its first row (run-identity.ts `bornOnFirstWrite`).
  bornOnFirstWrite(ctx);
  const middleware: LanguageModelV4Middleware = {
    specificationVersion: 'v4',
    wrapGenerate: async ({ doGenerate, params }) => {
      const key = runKeys.model(ctx.runId, step);
      // Invisible to parseJournalKey (runKeys.proc) → does NOT AFFECT reader/time-travel/forkRun;
      // only this middleware's write-ahead ledger.
      const claimKey = runKeys.proc(ctx.runId, `__gnl_model_claim:${step}`);
      const reqHash = safeRequestHash(params);
      const hit = await ctxGet(ctx, key);

      if (hit !== undefined) {
        // A step the stream path journaled is read as the content it generated (see asGenerateRecord).
        const generated = asGenerateRecord(hit);
        // Replay divergence — see warnOnModelDivergence documentation (opt-in, soft).
        await warnOnModelDivergence(ctx, claimKey, key, reqHash, 'model step');
        step++;
        // Check on REPLAY too (not just on a fresh call) — if the same runId is called
        // repeatedly without the limit CHANGING, it re-throws IMMEDIATELY at the SAME step (progress
        // does NOT LEAK); deterministic (same result) since the journal did NOT CHANGE. If the limit
        // is raised, this point is passed through.
        if (ctx.limits) await enforceStepLimits(ctx.journal as unknown as JournalReader, ctx.runId, ctx.limits, {}, ctx.identity ? requestOf(ctx.identity) : ctx.runId);
        return generated as Awaited<ReturnType<typeof doGenerate>>;
      }

      // Write-ahead 'running' claim BEFORE the model call. Purpose: the crash window
      // BETWEEN the model response and journaling it becomes VISIBLE on resume (studio/time-travel can
      // read this record and say "this step was left half-done") + reqHash is FIXED here (the
      // divergence check above uses it). DELIBERATELY: unlike durableTool, there is NO TTL-based
      // RunBusyError here — the FAST resume after a real crash (see process-kill.test.ts) happens
      // exactly in this window; a hard lock would break a legitimate exactly-once resume. Protection
      // against concurrent multi-resume is already provided by the opt-in run-level `lock` (see
      // `acquireRunLock` in run.ts).
      // §5.3: if opts.exclusiveStep is given, an ADDITIONAL opt-in gate kicks in (see acquireModelClaim).
      // P2-cancel: durable cross-worker cancel gate — checked ONLY on the FRESH path (a replayed step
      // above returns untouched: replay reconstructs work that already happened, cancel stops NEW
      // spend). A run canceled from anywhere (server ?durable=true, cancelAgentRun) stops here at its
      // next model-step boundary regardless of which worker is executing it.
      // …and the run was not DELETED since this attempt started (erasure-fence.ts): same boundary, one read
      // beside the flag's — the deletion took the flag with everything else.
      await Promise.all([assertNotCanceled(ctx.journal, ctx.runId), assertNotErased(ctx.journal, ctx.runId, ctx.erasure)]);
      // GRACEFUL DRAIN (process-liveness.ts): a process shutting down starts no new model step.
      if (isDraining()) throw new RunDrainedError(ctx.runId);
      // A new step spends budget: none left (the request's — a sibling may have used it), no step.
      if (ctx.limits) await enforceStepLimits(ctx.journal as unknown as JournalReader, ctx.runId, ctx.limits, {}, ctx.identity ? requestOf(ctx.identity) : ctx.runId, 'before');
      const claimed = await acquireModelClaim(ctx, claimKey, reqHash, opts?.exclusiveStep);
      let result: Awaited<ReturnType<typeof doGenerate>>;
      try {
        // Y1: opt-in step timeout — a timeout falls into the catch, claim becomes 'failed' (retry key does not shift).
        const generated = opts?.stepTimeoutMs
          ? await withTimeout(doGenerate(), opts.stepTimeoutMs, `model step ${step}`)
          : await doGenerate();
        // H13: format stamp (a copy — _v does not leak into result). The step is answered once: an
        // answer recorded meanwhile is this step's, and this attempt returns it instead of its own.
        const answered = await answerStep(ctx, key, [], stampFormat(generated as object));
        result = answered.lost ? (asGenerateRecord(answered.recorded) as typeof generated) : generated;
        await settleModelClaim(ctx, claimKey, claimed, 'succeeded', reqHash);
      } catch (error) {
        // Transient error: mark the claim as 'failed' → the NEXT attempt (retry/resume) continues
        // immediately — the existing "retry does not shift the replay key" behavior is PRESERVED (step did not advance).
        await settleModelClaim(ctx, claimKey, claimed, 'failed', reqHash);
        throw error;
      } finally {
        releaseHold(claimed.hold, ctx.journal);
      }
      step++;
      // Checked AFTER the step is SUCCESSFULLY journaled (journal is already consistent) —
      // RunLimitExceededError is thrown from here on breach; since it's OUTSIDE the try/catch, it does
      // NOT MARK the claim as 'failed' (the step genuinely succeeded, only the run's CONTINUATION is being stopped).
      if (ctx.limits) await enforceStepLimits(ctx.journal as unknown as JournalReader, ctx.runId, ctx.limits, {}, ctx.identity ? requestOf(ctx.identity) : ctx.runId);
      return result;
    },
    // Streaming: record/replay stream chunks (reconstruct with simulateReadableStream).
    wrapStream: async ({ doStream, params }) => {
      const key = runKeys.model(ctx.runId, step);
      const claimKey = runKeys.proc(ctx.runId, `__gnl_model_claim:${step}`);
      const reqHash = safeRequestHash(params);
      const stored = await ctxGet<unknown>(ctx, key);
      if (stored !== undefined) {
        // A step the generate path journaled is read as the parts a provider streams for it (asStreamRecord).
        const hit = asStreamRecord(stored);
        // A write-ahead (truncated) record is still replayed — but never in silence (see warnOnPartialReplay).
        warnOnPartialReplay(ctx, hit, key, step);
        // SAME divergence check as generate (see warnOnModelDivergence).
        await warnOnModelDivergence(ctx, claimKey, key, reqHash, 'model stream step');
        step++;
        // SAME replay-recheck as generate (see wrapGenerate) — does not leak progress.
        if (ctx.limits) await enforceStepLimits(ctx.journal as unknown as JournalReader, ctx.runId, ctx.limits, {}, ctx.identity ? requestOf(ctx.identity) : ctx.runId);
        return {
          stream: simulateReadableStream({ chunks: completeIfTruncated(hit), initialDelayInMs: 0, chunkDelayInMs: 0 }),
          ...hit.rest,
        } as any;
      }
      // SAME write-ahead claim as generate (see above — rationale there).
      // §5.3: SAME opt-in exclusivity gate as generate (see acquireModelClaim).
      // P2-cancel: durable cross-worker cancel gate — checked ONLY on the FRESH path (a replayed step
      // above returns untouched: replay reconstructs work that already happened, cancel stops NEW
      // spend). A run canceled from anywhere (server ?durable=true, cancelAgentRun) stops here at its
      // next model-step boundary regardless of which worker is executing it.
      // …and the run was not DELETED since this attempt started (erasure-fence.ts): same boundary, one read
      // beside the flag's — the deletion took the flag with everything else.
      await Promise.all([assertNotCanceled(ctx.journal, ctx.runId), assertNotErased(ctx.journal, ctx.runId, ctx.erasure)]);
      // GRACEFUL DRAIN (process-liveness.ts): a process shutting down starts no new model step.
      if (isDraining()) throw new RunDrainedError(ctx.runId);
      // A new step spends budget: none left (the request's — a sibling may have used it), no step.
      if (ctx.limits) await enforceStepLimits(ctx.journal as unknown as JournalReader, ctx.runId, ctx.limits, {}, ctx.identity ? requestOf(ctx.identity) : ctx.runId, 'before');
      const claimed = await acquireModelClaim(ctx, claimKey, reqHash, opts?.exclusiveStep);
      let result: Awaited<ReturnType<typeof doStream>>;
      try {
        // Y1: in stream, the timeout is applied to the doStream call (up to the first byte) — see DurableModelOptions.
        result = opts?.stepTimeoutMs
          ? await withTimeout(doStream(), opts.stepTimeoutMs, `model stream step ${step}`)
          : await doStream();
      } catch (error) {
        await settleModelClaim(ctx, claimKey, claimed, 'failed', reqHash);
        throw error;
      } finally {
        // Held while the provider is asked (the call a twin would repeat), not while the caller reads the
        // stream: a stream nobody finishes reading would otherwise hold the step in this process forever.
        releaseHold(claimed.hold, ctx.journal);
      }
      const { stream, ...rest } = result;
      const myStep = step;
      step++;
      const parts: any[] = [];
      // Journal the step AS SOON AS IT CONTAINS A TOOL CALL, not only at flush.
      //
      // This is the difference between the two paths, and it decided how wide their crash windows
      // were. wrapGenerate writes the step the moment doGenerate() returns — before any tool in it
      // can run. The streaming path wrote it in flush(), after the stream had been fully consumed,
      // while the AI SDK executes tool calls as they ARRIVE. So a crash between "the tool ran" and
      // "the stream ended" left the tool record present and model:N absent; the resume re-called the
      // model, it re-planned, and a real provider mints a fresh toolCallId every completion — so the
      // per-toolCallId gate never matched and the side effect ran again.
      //
      // Writing on the tool-call part closes exactly that window: whatever the stream does
      // afterwards, the ids that were about to execute are recoverable. flush() still writes the
      // complete record over it, so a run that finishes normally journals precisely what it did
      // before. A partial record is only ever read by a resume that would otherwise have re-planned,
      // which is strictly the better of the two.
      //
      // There is no periodic copy of a long TEXT stream any more. It rewrote every part of the step so
      // far every 10 parts — nothing read it, and it was 71–94% of a streamed run's WAL on Postgres
      // (measured, ADR-0008). A detached run's event log (detached.ts) is what a
      // crash leaves of a text stream now, written once per segment.
      // A write-ahead put that fails silently reopens the exact window this checkpoint was added to
      // close — the caller's stream keeps flowing and nothing anywhere records that the step is no
      // longer recoverable. Warn once per STREAM, not per chunk: a step can carry many tool calls,
      // and a journal that is down is down for all of them (one line per chunk is noise, not signal).
      let writeAheadFailureWarned = false;
      // The step is answered once (`answerStep`), on this path too. A stream cannot take back what it has
      // already handed its reader, so an attempt that finds the step answered by another stops its
      // stream there with `AttemptLost` — before the tool call that would have run its own plan — and
      // its run's next attempt replays the recorded answer.
      const mine: object[] = [];
      const recorder = new TransformStream<any, any>({
        async transform(chunk, controller) {
          parts.push(chunk);
          if (chunk?.type === 'tool-call') {
            try {
              const answered = await answerStep(ctx, runKeys.model(ctx.runId, myStep), mine, stampFormat({ parts: parts.slice(), rest, partial: true }));
              if (answered.lost) {
                controller.error(new AttemptLost(runKeys.model(ctx.runId, myStep)));
                return;
              }
            } catch (err) {
              if (err instanceof AttemptLost) {
                controller.error(err);
                return;
              }
              // Best-effort stays best-effort: a journal hiccup must not stop the stream the caller
              // is reading. But it is said out loud.
              if (!writeAheadFailureWarned) {
                writeAheadFailureWarned = true;
                console.warn(
                  `@gnldev/durable: the mid-stream write-ahead checkpoint FAILED for run '${ctx.runId}' step ${myStep} ` +
                    `('${runKeys.model(ctx.runId, myStep)}'). The stream is NOT broken (this write is best-effort), but until ` +
                    'flush() lands the complete record, a crash after a tool call in this step leaves it unjournaled — the ' +
                    'resume re-plans, the provider mints a fresh toolCallId, and a side effect can run a SECOND time. ' +
                    'Further failures on this stream are not repeated. Cause:',
                  err,
                );
              }
            }
          }
          controller.enqueue(chunk);
        },
        flush: async () => {
          // Happy path: the final record is written with the full `parts` (H13), over this attempt's own copy.
          const answered = await answerStep(ctx, runKeys.model(ctx.runId, myStep), mine, stampFormat({ parts, rest }));
          await settleModelClaim(ctx, claimKey, claimed, 'succeeded', reqHash);
          if (answered.lost) throw new AttemptLost(runKeys.model(ctx.runId, myStep));
          // SAME post-hoc check as generate (see wrapGenerate) — the step is already journaled.
          if (ctx.limits) await enforceStepLimits(ctx.journal as unknown as JournalReader, ctx.runId, ctx.limits, {}, ctx.identity ? requestOf(ctx.identity) : ctx.runId);
        },
      });
      return { stream: (stream as any).pipeThrough(recorder), ...rest } as any;
    },
  };
  return wrapLanguageModel({ model, middleware });
}
