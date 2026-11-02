// Did one play do what a right answer does? — the rule every lab reader that takes an `expect` follows.
//
// A play that stopped at a call no one answered did not finish, and what it would have done after that
// call is not known. It is judged only where the rest cannot change the answer: a forbidden call it
// already made is a failure whatever follows; every expected call made, with nothing asked of the answer
// and nothing forbidden, is a pass whatever follows. Anything else is `undetermined` — counted apart,
// never as a pass or a failure. Without the first two, a play whose right behaviour is a call the
// recording never made (the very thing a diagnosis looks for) could never be counted.
import { checkExpectation, type Expectation, type TracedCall } from '@gnldev/experiment';

export type PlayVerdict = { verdict: 'pass' } | { verdict: 'fail'; failures: string[] } | { verdict: 'undetermined' };

/** One play against `expect`: its calls (with where each result came from) and its final text. */
export function judgePlay(expect: Expectation, trace: readonly TracedCall[], text: string): PlayVerdict {
  const stopped = trace.some((c) => c.source === 'none');
  if (!stopped) {
    const failures = checkExpectation(expect, trace, text);
    return failures.length ? { verdict: 'fail', failures } : { verdict: 'pass' };
  }
  const forbidden = (expect.forbidden ?? []).filter((f) => trace.some((c) => c.toolName === f));
  if (forbidden.length) return { verdict: 'fail', failures: forbidden.map((f) => `called forbidden ${f}`) };
  const callsOnly = !(expect.answerIncludes?.length) && !(expect.forbidden?.length) && (expect.calls?.length ?? 0) > 0;
  if (callsOnly && checkExpectation({ calls: expect.calls! }, trace, '').length === 0) return { verdict: 'pass' };
  return { verdict: 'undetermined' };
}
