// P2 "TokenLimiter" — the one trim of the processors package; `tokenLimit` (safety.ts) is this with defaults.
//
// THE UNIT IS A TURN: a user message and everything after it up to the next user message (the
// assistant's answer, its tool calls, their results). The CURRENT turn — from the last user message on —
// is never cut: cut, the model sees a tool result without the question it answers, or the question
// without the result it asked for, and answers from the part it has. Measured on the per-message trims
// this replaces: one kept the question and dropped the tool result, the other kept the result and dropped
// the question, and an older one sent nothing. Older turns are dropped whole, oldest first. When the
// current turn alone is over the budget nothing can be dropped to make it fit, and the run stops with a
// ProcessorTripwire that says so, rather than sending the model half a turn.
import { ProcessorTripwire, recordProcessorReport } from '@gnldev/durable';
import { messageText } from './message-text.js';
import type { Processor, ProcessorCtx, ProcessorInput } from '@gnldev/durable';
import { refuseUnknownNames } from '@gnldev/options';
import { TOKEN_LIMITER_NAMES } from './option-names.js';

export interface TokenLimiterOptions {
  /** Token budget for the whole input (system + messages). */
  maxInputTokens: number;
  /**
   * Token counter (default: the char/4 heuristic, SAME as @gnldev/memory's `approxTokens`). For a real
   * tokenizer, pass e.g. `gpt-tokenizer`/`tokenx`/`js-tiktoken`: `countTokens: (t) => enc.encode(t).length`.
   */
  countTokens?: (text: string) => number;
  /**
   * 'trim-oldest' (default): drops the oldest turns, whole, until under budget. The current turn (from
   *   the last user message on) is never dropped; if it alone is over budget, throws `ProcessorTripwire`.
   * 'error': throws `ProcessorTripwire` instead of trimming — the run stops.
   */
  strategy?: 'trim-oldest' | 'error';
  /**
   * Never drop messages with `role: 'system'` from the `messages` array (default: true). NOTE:
   * `input.system` (the separate system-prompt field) is NEVER trimmed either way — only entries in
   * `messages` are candidates for removal.
   */
  keepSystem?: boolean;
}

/** Default token counter — char/4 heuristic (not a real tokenizer; same approximation as @gnldev/memory's `approxTokens`). */
function approxTokens(s: string): number {
  return Math.ceil((s?.length ?? 0) / 4);
}

/**
 * Where each turn starts: index 0 (whatever precedes the first user message is a turn of its own) and
 * every user message. The last start is the current turn.
 */
function turnStarts(messages: readonly any[]): number[] {
  const starts = [0];
  messages.forEach((m, i) => { if (i > 0 && m?.role === 'user') starts.push(i); });
  return starts;
}

/**
 * tokenLimiter — estimates total input tokens (`input.system` + messages); over `maxInputTokens`:
 * 'trim-oldest' (default): drops older turns, whole and oldest first, keeping the newest turns that fit.
 *   Never dropped: the current turn, `role: 'system'` messages (if `keepSystem`, default true) and
 *   `input.system`. If what can never be dropped is already over the budget, throws `ProcessorTripwire`.
 * 'error': throws `ProcessorTripwire` (run stops) instead of trimming anything.
 * Deterministic (pure function of the input + countTokens) → no journaling needed.
 */
export function tokenLimiter(opts: TokenLimiterOptions): Processor {
  refuseUnknownNames('tokenLimiter', opts, TOKEN_LIMITER_NAMES);
  const countTokens = opts.countTokens ?? approxTokens;
  const strategy = opts.strategy ?? 'trim-oldest';
  const keepSystem = opts.keepSystem ?? true;

  return {
    name: 'token-limiter',
    // DELIBERATE synchronous (NOT async): same rationale as promptInjectionDetector/moderationProcessor —
    // the 'error' strategy's tripwire must throw SYNCHRONOUSLY. recordProcessorReport is fire-and-forget.
    processInput(input: ProcessorInput, ctx: ProcessorCtx) {
      const messages = input.messages ?? [];
      const systemTokens = typeof input.system === 'string' ? countTokens(input.system) : 0;
      const msgTokens = messages.map((m) => countTokens(messageText(m)));
      const total = systemTokens + msgTokens.reduce((a, b) => a + b, 0);

      if (total <= opts.maxInputTokens) return input;

      if (strategy === 'error') {
        void recordProcessorReport(ctx, 'token-limiter', 'input', { totalTokens: total, maxInputTokens: opts.maxInputTokens });
        throw new ProcessorTripwire(
          `Input exceeds token limit: ~${total} tokens > ${opts.maxInputTokens} max`,
          'token-limiter',
          { totalTokens: total, maxInputTokens: opts.maxInputTokens },
        );
      }

      // 'trim-oldest', by whole turns. `fixed` is what is never dropped: input.system, kept system
      // messages, and the current turn.
      const starts = turnStarts(messages);
      const current = starts[starts.length - 1]!;
      const pinned = (i: number) => i >= current || (keepSystem && messages[i]?.role === 'system');
      const keep = messages.map((_, i) => pinned(i));
      const fixed = msgTokens.reduce((n, t, i) => (keep[i] ? n + t : n), systemTokens);
      if (fixed > opts.maxInputTokens) {
        void recordProcessorReport(ctx, 'token-limiter', 'input', { totalTokens: total, currentTurnTokens: fixed, maxInputTokens: opts.maxInputTokens });
        throw new ProcessorTripwire(
          `The current turn alone is ~${fixed} tokens, over the ${opts.maxInputTokens} limit. Nothing older can be dropped to make it fit, and `
          + 'cutting the turn would show the model a question without its tool result, or a result without its question. '
          + 'Raise the limit, or have the tool return less.',
          'token-limiter',
          { totalTokens: total, currentTurnTokens: fixed, maxInputTokens: opts.maxInputTokens },
        );
      }
      let used = fixed;
      for (let t = starts.length - 2; t >= 0; t--) {
        const end = starts[t + 1]!;
        let cost = 0;
        for (let i = starts[t]!; i < end; i++) if (!keep[i]) cost += msgTokens[i]!;
        if (used + cost > opts.maxInputTokens) break; // the turns kept stay contiguous with the current one
        used += cost;
        for (let i = starts[t]!; i < end; i++) keep[i] = true;
      }
      const droppedCount = keep.filter((k) => !k).length;
      if (droppedCount === 0) return input;
      void recordProcessorReport(ctx, 'token-limiter', 'input', {
        droppedCount, totalTokens: total, remainingTokens: used, maxInputTokens: opts.maxInputTokens,
      });
      return { ...input, messages: messages.filter((_, i) => keep[i]) };
    },
  };
}
