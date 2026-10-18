// The guarantees of a store (journal.ts JOURNAL_GUARANTEES), forwarded to `inner` — for a test that wraps a
// store to count or intercept some of its calls and must still hand the engine a complete store.
import { JOURNAL_GUARANTEES, type Journal } from '../src/journal.js';

export function forwardGuarantees(inner: Journal): Pick<Journal, (typeof JOURNAL_GUARANTEES)[number]> {
  return Object.fromEntries(JOURNAL_GUARANTEES.map((m) => [m, (...a: unknown[]) => (inner[m] as (...x: unknown[]) => unknown).apply(inner, a)])) as never;
}
