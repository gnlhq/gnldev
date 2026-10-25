// Old tool output, left out of the model's context once it is a few steps behind.
//
// A tool result rides along in every later model step and is billed every time. After a few steps the
// model has used it; carrying it further costs input tokens. This replaces the OUTPUT of a tool result
// older than `keepLast` steps with a one-line note naming the tool — the call and its result part stay,
// so the conversation keeps its shape (every provider requires a result for every call).
//
// Transient: it changes what the model is sent for a step, never what the journal keeps. A pure function
// of the step's messages, so a resumed run computes the same thing (the processor determinism contract).
// Whether an agent still needs an old result is not something to assume: try it with replayCounterfactual
// (`prepareStep: maskOldToolOutputs().prepareStep`) before you add it to the agent.
import type { Processor, ProcessorStepInput } from '@gnldev/durable';
import { refuseUnknownNames } from '@gnldev/options';
import { MASK_NAMES } from './option-names.js';

export interface MaskOldToolOutputsOptions {
  /** A result produced more than this many steps ago is left out (default 2). */
  keepLast?: number;
  /** A result shorter than this many characters is kept whatever its age (default 200). */
  minChars?: number;
}

type Msg = { role: string; content: unknown };

/** The messages with old tool outputs replaced, or undefined when nothing was old enough to change. */
export function maskMessages(messages: readonly Msg[], opts: MaskOldToolOutputsOptions = {}): Msg[] | undefined {
  refuseUnknownNames('maskMessages', opts, MASK_NAMES);
  const keepLast = opts.keepLast ?? 2;
  const minChars = opts.minChars ?? 200;
  // The step being asked for is the number of model turns already in the conversation.
  const current = messages.filter((m) => m.role === 'assistant').length;
  let step = -1;
  let changed = false;
  const out = messages.map((m) => {
    if (m.role === 'assistant') { step++; return m; }
    if (m.role !== 'tool' || !Array.isArray(m.content) || step < 0 || current - step <= keepLast) return m;
    const content = (m.content as any[]).map((p) => {
      if (p?.type !== 'tool-result') return p;
      const size = JSON.stringify(p.output ?? '').length;
      if (size < minChars) return p;
      changed = true;
      return { ...p, output: { type: 'text', value: `[${p.toolName ?? 'tool'} output from ${current - step} steps ago, ${size} characters, left out to save tokens]` } };
    });
    return { ...m, content };
  });
  return changed ? out : undefined;
}

/**
 * A processor (and an AI SDK `prepareStep`) that leaves tool outputs older than `keepLast` steps out of
 * the model's context.
 */
export function maskOldToolOutputs(opts: MaskOldToolOutputsOptions = {}): Processor & {
  prepareStep: (step: { messages: Msg[] }) => { messages: Msg[] } | undefined;
} {
  refuseUnknownNames('maskOldToolOutputs', opts, MASK_NAMES);
  const run = (step: { messages: Msg[] }) => {
    const messages = maskMessages(step.messages, opts);
    return messages ? { messages } : undefined;
  };
  return {
    name: `mask-old-tool-outputs:${opts.keepLast ?? 2}:${opts.minChars ?? 200}`,
    processInputStep: (step: ProcessorStepInput) => run(step as never) as never,
    prepareStep: run,
  };
}
