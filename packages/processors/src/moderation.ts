import { ProcessorTripwire, recordProcessorReport } from '@gnldev/durable';
import type { Processor, ProcessorInput, ProcessorOutput, ProcessorCtx } from '@gnldev/durable';
import { callerText } from './message-text.js';
import { refuseUnknownNames } from '@gnldev/options';
import { MODERATION_PROCESSOR_NAMES } from './option-names.js';

export interface ModerationOptions {
  /**
   * Blocked terms (normalized to lowercase before matching) — pure substring matching, bypassable
   * (see `moderationProcessor` JSDoc). Not a real security boundary.
   */
  blocklist: string[];
  /** input/output/both (default: 'both'). `input` reads what the caller wrote — the prompt and the user messages; `output` the model's final text. */
  on?: 'input' | 'output' | 'both';
}

function firstHit(text: string, blocklist: string[]): string | null {
  const lower = text.toLowerCase();
  for (const term of blocklist) if (lower.includes(term.toLowerCase())) return term;
  return null;
}

/**
 * Rule-based moderation processor — throws `ProcessorTripwire` when a blocked term is found (run stops).
 * Deterministic (blocklist is fixed) → no journaling needed.
 *
 * HONEST WARNING (naive matching): Matching is a plain, case-insensitive **substring** search
 * (`String.includes`). This is NOT a real security/moderation boundary — it's easily bypassed:
 * inserting spaces/punctuation ("s e c r e t"), unicode homoglyphs, typos, synonyms, another
 * language, etc. — none of these are caught. Treat it as a first-line-of-defense / noise-reduction
 * layer only — do not use it as the SOLE protection mechanism in a critical flow; for real
 * moderation, layer in a model-based judge (see below) or a dedicated moderation service.
 *
 * For a model-based variant: inside `processInput`/`processOutput`, JOURNAL the LLM-judge call with
 * `ctx.step('moderation', () => judge(...))` → same decision on resume, no duplicate judge call. Example:
 *   processOutput: async (out, ctx) => {
 *     const verdict = await ctx.step('moderation', () => callJudgeModel(out.text));
 *     if (verdict.blocked) throw new ProcessorTripwire('blocked', 'moderation', verdict);
 *     return out;
 *   }
 */
export function moderationProcessor(opts: ModerationOptions): Processor {
  refuseUnknownNames('moderationProcessor', opts, MODERATION_PROCESSOR_NAMES);
  const on = opts.on ?? 'both';
  const proc: Processor = { name: 'moderation' };

  if (on === 'input' || on === 'both') {
    // Synchronous throw is PRESERVED (see safety.ts promptInjectionDetector, same rationale) — recordProcessorReport
    // is called fire-and-forget (best-effort, swallows errors), doesn't break the tripwire's synchronous behavior.
    proc.processInput = (input: ProcessorInput, ctx: ProcessorCtx) => {
      const hit = firstHit(callerText(input), opts.blocklist);
      if (hit) {
        void recordProcessorReport(ctx, 'moderation', 'input', { hit });
        throw new ProcessorTripwire(`Input blocked by moderation: "${hit}"`, 'moderation', { hit });
      }
      return input;
    };
  }

  if (on === 'output' || on === 'both') {
    proc.processOutput = (output: ProcessorOutput, ctx: ProcessorCtx) => {
      const hit = firstHit(output.text ?? '', opts.blocklist);
      if (hit) {
        void recordProcessorReport(ctx, 'moderation', 'output', { hit });
        throw new ProcessorTripwire(`Output blocked by moderation: "${hit}"`, 'moderation', { hit });
      }
      return output;
    };
  }

  return proc;
}
