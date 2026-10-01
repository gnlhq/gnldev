// The one A2A signature definition: what it accepts and what it refuses, with no server involved.
import { describe, it, expect } from 'vitest';
import { signA2ARequest, verifyA2ARequest, a2aSigningInput, A2A_SIGNATURE_WINDOW_MS } from '../src/index.js';

const req = { method: 'POST', path: '/agents/a/run', body: '{"runId":"r1","prompt":"hi"}' };
const verify = (h: { 'x-gnl-timestamp': string; 'x-gnl-signature': string }, r = req, now?: number) =>
  verifyA2ARequest('s', { ...r, timestamp: h['x-gnl-timestamp'], signature: h['x-gnl-signature'] }, now);

describe('the A2A signature', () => {
  it('signs the timestamp, the method, the route and the body', () => {
    expect(a2aSigningInput('1', req)).toBe('1.POST /agents/a/run.{"runId":"r1","prompt":"hi"}');
  });
  it('verifies what it signed; the method is compared in any case', () => {
    expect(verify(signA2ARequest('s', req))).toBe('ok');
    expect(verify(signA2ARequest('s', { ...req, method: 'post' }))).toBe('ok');
  });
  it('refuses the same signature on another route, another method or another body', () => {
    const h = signA2ARequest('s', req);
    expect(verify(h, { ...req, path: '/agents/b/run' })).toBe('invalid');
    expect(verify(h, { ...req, path: '/agents/a/stream' })).toBe('invalid');
    expect(verify(h, { ...req, method: 'PUT' })).toBe('invalid');
    expect(verify(h, { ...req, body: req.body.replace('hi', 'refund') })).toBe('invalid');
  });
  it('refuses another secret, a stale timestamp and missing headers', () => {
    const now = 1_000_000_000_000;
    const h = signA2ARequest('s', req, now);
    expect(verifyA2ARequest('other', { ...req, timestamp: h['x-gnl-timestamp'], signature: h['x-gnl-signature'] }, now)).toBe('invalid');
    expect(verify(signA2ARequest('s', req, now - A2A_SIGNATURE_WINDOW_MS - 1), req, now)).toBe('stale');
    expect(verifyA2ARequest('s', { ...req, timestamp: undefined, signature: 'ab' })).toBe('missing');
  });
});
