// THE ONE PRODUCER of the sentence a person reads when a side effect would be repeated.
//
// The question used to be spelled out by hand at six places in durable-tool.ts (the duplicate marker, the
// twin in flight, the cross-channel identity twice, the two semantic questions) and each said it slightly
// differently: a fixed English sentence, an internal `call-…` id, "another channel" even for another
// conversation in the same channel. A developer could change none of it and could not translate it.
//
// Now every call site hands over what it KNOWS (`RepeatFacts`: structured, no sentences) and this module
// writes the words. `createGnl({ questionText })` lets the developer write them instead (any language, any
// house style); a hook that answers `undefined` falls back to the default below. The facts are also what a UI
// can build its own sentence from.
//
// What the default never says: an internal call id (a person cannot act on it; the journal keeps it, and the
// suspend payload carries it in `prior.toolCallId`).

/** Where the earlier work happened, relative to the call that is asking. */
export type RepeatWhere = 'this-run' | 'this-conversation' | 'another-conversation' | 'another-channel';

/** What a call site knows about the repeat — facts, not words. */
export interface RepeatFacts {
  /** The tool whose call would run again. */
  tool: string;
  /** How the earlier work was recognised: identical arguments, the same declared business identity, or a similar one. */
  match: 'identical-arguments' | 'same-business-identity' | 'similar-work';
  /** The earlier work finished, or was started and has not finished (it may have run). */
  state: 'completed' | 'in-flight';
  where: RepeatWhere;
  /** How long ago the earlier work happened, in ms, when known. */
  ageMs?: number;
  /** The channel the earlier work came through, when known (`chat`, `api`, `batch:…`). */
  priorChannel?: string;
  /** Declared amount fields that differ between the earlier work and this call. */
  amountsDiffer?: string[];
  /** Similarity score 0–100 (only for `similar-work`). */
  similarityPct?: number;
  /** The earlier work in words, when the semantic layer has one (only for `similar-work`). */
  priorCanonical?: string;
  /** Similar work found by the judge after the identity fields differed (only for `similar-work`). */
  identityDiffers?: boolean;
  /** The same work stands completed under ANOTHER run's name (a thread's marker is shared by every run of the conversation). */
  otherRun?: { runId: string; ageMs: number };
}

/** `createGnl({ questionText })`: the developer's sentence for a repeat question, or `undefined` for the default. */
export type QuestionTextHook = (facts: RepeatFacts) => string | undefined;

/** "just now", "5 min ago", "2 h ago", "3 d ago". */
function ago(ageMs: number): string {
  const mins = Math.round(Math.max(0, ageMs) / 60_000);
  return mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : mins < 1440 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} d ago`;
}

/** "another run (<id>, 5 min ago) already completed the same work" — the one sentence for work a different run did. */
export function otherRunWords(o: { runId: string; ageMs: number }): string {
  return `another run (${o.runId}, ${ago(o.ageMs)}) already completed the same work`;
}

const WHERE_WORDS: Record<RepeatWhere, string> = {
  'this-run': 'in this run',
  'this-conversation': 'earlier in this conversation',
  'another-conversation': 'in another conversation',
  'another-channel': 'in another channel',
};

function whenWhere(f: RepeatFacts): string {
  const via = f.priorChannel && f.where === 'another-channel' ? `, via ${f.priorChannel}` : '';
  const age = f.ageMs !== undefined ? ` (${ago(f.ageMs)}${via})` : via ? ` (${via.slice(2)})` : '';
  return `${WHERE_WORDS[f.where]}${age}`;
}

function defaultText(f: RepeatFacts): string {
  if (f.match === 'similar-work') {
    const pct = f.similarityPct !== undefined ? ` (${f.similarityPct}% match)` : '';
    const what = f.priorCanonical ? `: "${f.priorCanonical}"` : '';
    if (f.amountsDiffer?.length) {
      return `Semantically similar work already succeeded ${WHERE_WORDS[f.where]}${pct} but the amounts differ (${f.amountsDiffer.join(', ')}). A human must decide: new job, or a duplicate with a typo?`;
    }
    return `Similar work already succeeded ${WHERE_WORDS[f.where]}${pct}${what}.${f.identityDiffers ? ' The identity fields differ, so this may be the same job written differently.' : ''} A human must approve executing it again.`;
  }
  const same = f.match === 'same-business-identity' ? 'the same business identity' : 'identical arguments';
  if (f.state === 'in-flight') {
    return `Duplicate side effect: '${f.tool}' with ${same} was started ${whenWhere(f)} and has not finished — it may have run. A human must approve executing it again.`;
  }
  const amounts = f.amountsDiffer?.length ? ` but the amounts DIFFER (${f.amountsDiffer.join(', ')}) — check carefully before approving` : '';
  const other = f.otherRun ? ` (${otherRunWords(f.otherRun)})` : '';
  return `Duplicate side effect: '${f.tool}' already succeeded with ${same} ${whenWhere(f)}${other}${amounts}. A human must approve executing it again.`;
}

/**
 * The sentence for a repeat question. The developer's hook first; its `undefined` (or an empty string) falls
 * back to the default, so a hook that only knows some situations never leaves a question blank.
 */
export function repeatQuestion(facts: RepeatFacts, hook?: QuestionTextHook): string {
  const custom = hook?.(facts);
  return typeof custom === 'string' && custom.trim() !== '' ? custom : defaultText(facts);
}

/**
 * The same facts as a sentence that is APPENDED to a `confirm` question (the tool already asks for approval;
 * the repeat only adds what it found). The hook is consulted too, so one hook serves both shapes.
 */
export function repeatNote(facts: RepeatFacts, hook?: QuestionTextHook): string {
  const custom = hook?.(facts);
  if (typeof custom === 'string' && custom.trim() !== '') return ` ⚠ ${custom}`;
  const same = facts.match === 'same-business-identity' ? 'the same business identity' : 'identical work';
  if (facts.state === 'in-flight') return ` ⚠ Work with ${same} was started ${whenWhere(facts)} and has not finished — it may have run; check before approving.`;
  const what = `${facts.priorCanonical ? ` ("${facts.priorCanonical}")` : ''}${facts.otherRun ? `: ${otherRunWords(facts.otherRun)}` : ''}`;
  if (facts.amountsDiffer?.length) return ` ⚠ Work with ${same} was completed ${whenWhere(facts)}${what} but the amounts DIFFER (${facts.amountsDiffer.join(', ')}) — check carefully before approving.`;
  return ` ⚠ ${facts.match === 'same-business-identity' ? 'Work with the same business identity' : 'Identical work'} was ALREADY COMPLETED ${whenWhere(facts)}${what} — approve only if you intend a deliberate repeat.`;
}

/**
 * Where earlier work that came through the cross-channel identity record (`xid`) happened, from this call's
 * point of view: another CHANNEL only when both channels are known and differ, otherwise another
 * conversation (the same user, the same way in, a different thread or run).
 */
export function priorOrigin(prior: { at: number; channel?: string }, now: number, thisChannel?: string): Pick<RepeatFacts, 'where' | 'ageMs' | 'priorChannel'> {
  const differs = prior.channel !== undefined && thisChannel !== undefined && prior.channel !== thisChannel;
  return { where: differs ? 'another-channel' : 'another-conversation', ageMs: Math.max(0, now - prior.at), ...(prior.channel !== undefined ? { priorChannel: prior.channel } : {}) };
}
