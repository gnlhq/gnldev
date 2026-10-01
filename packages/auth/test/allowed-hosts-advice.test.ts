// An allowedHosts entry is checked where the surface is built; the advice it gives must be safe and right.
//
// Measured by the round-2 panel (review2-B doors.mjs, build-time validation table), before:
//   'a.*.com'     → THREW "... for every name under com write '.com'"   — advice to allow every .com name
//   'localhost:*' → THREW "... for every name under a domain write '.example.com'" — a port is not a name
//   '::1', 'fe80::1' → THREW "write a host name ..." — an IPv6 address written the way people write one
// Invariant: an entry is accepted when its meaning is unambiguous; a refusal never suggests a broader
// entry than the one written, and names a fix that would be accepted.
import { describe, it, expect } from 'vitest';
import { makeGate, isHostAllowed, parseAllowedHosts } from '../src/index.js';

const build = (entry: string) => () => makeGate(undefined, { allowedHosts: [entry] });
const problem = (entry: string): string => { try { build(entry)(); return ''; } catch (e) { return (e as Error).message; } };

describe('allowedHosts entries', () => {
  it("panel: 'a.*.com' is refused without suggesting '.com' (or any suffix broader than what was written)", () => {
    const m = problem('a.*.com');
    expect(m).not.toBe('');
    expect(m).not.toMatch(/'\.com'/);
    expect(m).toContain('list each name');
  });

  it("sibling: '*.*.example.com' and 'api-*.example.com' do not suggest '.example.com' either", () => {
    for (const e of ['*.*.example.com', 'api-*.example.com']) {
      const m = problem(e);
      expect(m, e).not.toBe('');
      expect(m, e).not.toMatch(/'\.example\.com'/);
    }
  });

  it("panel: 'localhost:*' is accepted — a port is never compared, so it means 'localhost'", () => {
    expect(build('localhost:*')).not.toThrow();
    expect(build('mybox.test:*')).not.toThrow();
    expect(isHostAllowed('mybox.test:9999', parseAllowedHosts('mybox.test:*') as string[])).toBe(true);
  });

  it("panel: a bare IPv6 address ('::1', 'fe80::1', '2001:db8::1') is accepted as the bracketed form", () => {
    for (const e of ['::1', 'fe80::1', '2001:db8::1']) expect(build(e), e).not.toThrow();
    expect(parseAllowedHosts('2001:db8::1')).toEqual(['[2001:db8::1]']);
  });

  it("sibling: '*' still names allowedHosts: true; 'x y' still names the forms that work", () => {
    expect(problem('*')).toContain('allowedHosts: true');
    expect(problem('x y')).toContain("'.ngrok-free.app'");
  });
});
