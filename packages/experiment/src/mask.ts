// Parts of a conversation left out of what the model is sent — the knob every "what if this part were
// not there" question turns.
//
// It is an AI SDK prepareStep built, every step, from the two lists the SDK keeps apart: the run's
// input (`initialMessages`) and what the steps produced since (`responseMessages`). Measured, ai@7: the
// messages a prepareStep returns are what the next step is handed, so a mask that filtered `messages`
// by position cut the wrong messages from the second step on — 705 of 768 trials of one experiment
// were caught by a check and discarded. Built from the two lists, every step is masked from the
// conversation as it really is.
import type { ModelMessage } from 'ai';
import { refuseUnknownNames } from '@gnldev/options';
import { MASK_CONVERSATION_NAMES } from './option-names.js';

export interface MaskConversationOptions {
  /** Positions in the run's input to leave out (0 is the first message). */
  dropInput?: readonly number[];
  /**
   * Tool results produced while the run is played again, by tool name, whose output the model is not
   * shown: the call stays (a provider requires a result for every call), its output becomes a note.
   */
  hideToolResults?: readonly string[];
  /**
   * Input messages put in place of others, by position in the run's input — the same row changed
   * ("this working-memory line said something else"). A position may not also be dropped.
   */
  replaceInput?: Readonly<Record<number, ModelMessage>>;
  /**
   * Messages put into the run's input: each lands BEFORE the input message at `at` (the input's length
   * puts it at the end), in the order given. `at` names a position of the ORIGINAL input, so it does not
   * move when other positions are dropped or replaced.
   */
  insertInput?: ReadonlyArray<{ at: number; message: ModelMessage }>;
}

const HIDDEN = '[result hidden for this experiment]';

/**
 * A prepareStep that changes the run's input the same way on every step — the named input messages
 * replaced, then the named ones left out, then new ones put in, every position counted in the ORIGINAL
 * input — and leaves the named tool results out.
 */
export function maskConversation(opts: MaskConversationOptions) {
  refuseUnknownNames('maskConversation', opts, MASK_CONVERSATION_NAMES);
  const drop = new Set(opts.dropInput ?? []);
  const hide = new Set(opts.hideToolResults ?? []);
  const replace = new Map(Object.entries(opts.replaceInput ?? {}).map(([k, m]) => [Number(k), m] as const));
  const insert = opts.insertInput ?? [];
  for (const [i] of replace) {
    if (!Number.isInteger(i) || i < 0) throw new RangeError(`@gnldev/experiment: maskConversation: replaceInput position '${i}' is not an input position`);
    if (drop.has(i)) throw new RangeError(`@gnldev/experiment: maskConversation: input position ${i} is both replaced and dropped — choose one`);
  }
  const hideIn = (m: ModelMessage): ModelMessage => {
    if (hide.size === 0 || m.role !== 'tool' || !Array.isArray(m.content)) return m;
    return { ...m, content: (m.content as any[]).map((p) => (p?.type === 'tool-result' && hide.has(p.toolName) ? { ...p, output: { type: 'text', value: HIDDEN } } : p)) };
  };
  // The SDK documents it: "If you return a `messages` override, those messages carry forward to later steps."
  return (step: { initialMessages: ModelMessage[]; responseMessages: ModelMessage[] }): { messages: ModelMessage[] } => {
    if (!step.initialMessages || !step.responseMessages) {
      throw new TypeError('@gnldev/experiment: maskConversation needs the AI SDK step\'s initialMessages and responseMessages (ai@7)');
    }
    const n = step.initialMessages.length;
    for (const i of [...drop, ...replace.keys()]) {
      if (!Number.isInteger(i) || i < 0 || i >= n) {
        throw new RangeError(`@gnldev/experiment: maskConversation: input position ${i} is outside the run's ${n} input messages`);
      }
    }
    for (const { at } of insert) {
      if (!Number.isInteger(at) || at < 0 || at > n) {
        throw new RangeError(`@gnldev/experiment: maskConversation: insertInput position ${at} is outside 0…${n} (the run's ${n} input messages)`);
      }
    }
    const input: ModelMessage[] = [];
    for (let i = 0; i <= n; i++) {
      for (const x of insert) if (x.at === i) input.push(x.message);
      if (i < n && !drop.has(i)) input.push(replace.get(i) ?? step.initialMessages[i]!);
    }
    return { messages: [...input, ...step.responseMessages.map(hideIn)] };
  };
}
