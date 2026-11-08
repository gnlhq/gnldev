// `endAnswerOf` — THE one mapping from how a run ended to what a door tells its client (errors.ts). Every
// door renders it; this pins the mapping itself, once, instead of once per door.
import { describe, it, expect } from 'vitest';
import { endAnswerOf, WIRE_ERROR_STATUS } from '../src/index.js';

const named = (name: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(`${name} happened`), { name }, extra);

describe('endAnswerOf', () => {
  it('a canceled run is 409 run_canceled, from the code table', () => {
    const a = endAnswerOf(named('RunCanceledError'))!;
    expect(a).toMatchObject({ status: 409, code: 'run_canceled', hidden: false, ownership: false });
    expect(a.status).toBe(WIRE_ERROR_STATUS.run_canceled);
    expect(a.body).toEqual({ error: 'RunCanceledError happened', code: 'run_canceled' });
  });
  it('a run waiting for an operator is 409 run_not_continued and resumable', () => {
    expect(endAnswerOf(named('RunNotContinuedError'))).toMatchObject({ status: 409, code: 'run_not_continued', body: { resumable: true } });
  });
  it('limits are 422 resumable; a retry limit is 422 and not resumable; run_busy carries Retry-After', () => {
    expect(endAnswerOf(named('RunLimitExceededError', { detail: { a: 1 } }))).toMatchObject({ status: 422, code: 'run_limit_exceeded', body: { resumable: true, detail: { a: 1 } } });
    expect(endAnswerOf(named('RetryLimitExceededError'))!.body).not.toHaveProperty('resumable');
    expect(endAnswerOf(named('RunBusyError'))!.headers).toEqual({ 'Retry-After': '5' });
  });
  it('a "not your run" refusal reads as an absent run, hidden', () => {
    expect(endAnswerOf(named('RunOwnerMismatchError', { detail: { owner: 'x' } }))).toMatchObject({ status: 404, code: 'run_not_found', hidden: true, ownership: true });
  });
  it('a caller conflict keeps its 409, its detail without foreign parties, and the caller\'s own workKey', () => {
    const a = endAnswerOf(named('RunInputMismatchError', { detail: { expectedHash: 'a', owner: 'someone' } }), 'wk')!;
    expect(a).toMatchObject({ status: 409, code: 'run_input_mismatch', ownership: false });
    expect(a.body.detail).toEqual({ expectedHash: 'a', workKey: 'wk' });
  });
  it('a request refusal and a provider failure are answered as before', () => {
    expect(endAnswerOf(named('DrainingError'))).toMatchObject({ status: 503, code: 'draining', headers: { 'Retry-After': '1' } });
    expect(endAnswerOf(named('APICallError', { statusCode: 429 }))).toMatchObject({ status: 429, code: 'upstream_rate_limited', upstream: { status: 429 } });
  });
  it('an error of the host\'s own is not a framework ending: undefined', () => {
    expect(endAnswerOf(new Error('boom'))).toBeUndefined();
    expect(endAnswerOf('a string')).toBeUndefined();
    expect(endAnswerOf(undefined)).toBeUndefined();
  });
});
