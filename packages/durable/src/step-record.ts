// How @gnldev/workflow stores a step's output, and how to read it back — for every reader outside the
// engine (the durable registry's run result, Studio's run views and playground).
//
// A step's record is its output as-is, with two exceptions under ONE reserved key:
//   • `undefined` is stored as `{ __gnlStepRecord: 'void' }` — a key holding `undefined` reads back like
//     no key at all, so a void step looked unrun and re-ran on every resume;
//   • an output that itself carries the reserved key is stored wrapped,
//     `{ __gnlStepRecord: 'value', value: <output> }`, so no output reads back as anything but itself.
// A value without the key — every record 0.9.0 wrote — is the output itself.
//
// @gnldev/workflow is dependency-free, so it keeps its own copy of this pair (the writer); this is the
// reader's copy. test/step-record-parity.test.ts runs a table of outputs through that writer and this
// reader, so the two cannot drift apart unnoticed.

const STEP_RECORD_KEY = '__gnlStepRecord' as const;

function hasOwn(v: unknown, k: string): boolean {
  return !!v && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, k);
}

/** The record @gnldev/workflow writes for a step output. */
export function encodeStepRecord(out: unknown): unknown {
  if (out === undefined) return { [STEP_RECORD_KEY]: 'void' };
  return hasOwn(out, STEP_RECORD_KEY) ? { [STEP_RECORD_KEY]: 'value', value: out } : out;
}

/** The output a stored workflow step record stands for — what the step returned. */
export function decodeStepRecord(v: unknown): unknown {
  if (!hasOwn(v, STEP_RECORD_KEY)) return v;
  const r = v as Record<string, unknown>;
  const keys = Object.keys(r);
  if (r[STEP_RECORD_KEY] === 'void' && keys.length === 1) return undefined;
  if (r[STEP_RECORD_KEY] === 'value' && keys.length === 2 && 'value' in r) return r.value;
  return v;
}
