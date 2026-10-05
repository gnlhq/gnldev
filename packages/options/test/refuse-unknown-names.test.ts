import { describe, it, expect } from 'vitest';
import { refuseUnknownNames, refuseMisspelledNames } from '../src/index.js';

describe('refuseUnknownNames', () => {
  const names = ['identify', 'authorize', 'allowedHosts'];
  it('takes the names it knows, and a name set to undefined', () => {
    expect(() => refuseUnknownNames('door', { identify: 1, authorize: 2, x: undefined }, names)).not.toThrow();
  });
  it('refuses a misspelled name, naming the one it is closest to', () => {
    expect(() => refuseUnknownNames('door', { authorise: 1 }, names)).toThrow(/door: `authorise` is not an option — did you mean `authorize`\?/);
    expect(() => refuseUnknownNames('door', { AllowedHosts: 1 }, names)).toThrow(/did you mean `allowedHosts`/);
    expect(() => refuseUnknownNames('sign', { ttl: 1 }, ['ttlSec', 'now'])).toThrow(/did you mean `ttlSec`/);
    expect(() => refuseUnknownNames('sign', { ttlSeconds: 1 }, ['ttlSec', 'now'])).toThrow(/did you mean `ttlSec`/);
    expect(() => refuseUnknownNames('retry', { maxRetry: 1 }, ['maxRetries'])).toThrow(/did you mean `maxRetries`/);
    expect(() => refuseUnknownNames('sweep', { olderThanMS: 1 }, ['olderThanMs'])).toThrow(/did you mean `olderThanMs`/);
  });
  it('refuses a name close to nothing without guessing', () => {
    expect(() => refuseUnknownNames('door', { xyzzy: 1 }, names)).toThrow(/`xyzzy` is not an option\. /);
  });
  it('refuses a removed name with what replaced it', () => {
    expect(() => refuseUnknownNames('door', { identity: 1 }, names, { identity: 'was replaced by `identify`.' })).toThrow('door: `identity` was replaced by `identify`.');
  });
});

describe('refuseMisspelledNames — an object passed on to another library', () => {
  const names = ['guard', 'timeouts', 'timeout', 'temperature'];
  it('refuses a misspelling of a known name', () => {
    expect(() => refuseMisspelledNames('runDurable', { gaurd: 1 }, names)).toThrow(/runDurable: `gaurd` is not an option — did you mean `guard`\?/);
    expect(() => refuseMisspelledNames('runDurable', { temprature: 1 }, names)).toThrow(/did you mean `temperature`/);
  });
  it('passes a name close to none — the other library\'s newer option', () => {
    expect(() => refuseMisspelledNames('runDurable', { experimental_newThing: 1, timeout: 1, timeouts: {} }, names)).not.toThrow();
  });
});
