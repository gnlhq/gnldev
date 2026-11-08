// d25 A1 follow-up: the date fix must never loosen masking. A first version put `(?<!\d\.)` in the phone pattern;
// it stopped `v2.05321234567` from masking and left the country code of `3.+905321234567` open. The date is now
// stepped over whole by the scan, and the pattern is the one 0.17.1 shipped. Measured on 0.17.1 and after: the first four rows are identical before and after (0.17.1 masked them the same way);
// the date rows are the A1 improvement (0.17.1: `[phone]:00` and `09.11.[phone]`).
import { describe, it, expect } from 'vitest';
import { piiTextRedactor } from '../src/index.js';

const red = piiTextRedactor();
const table: Array<[string, string]> = [
  ['v2.05321234567', 'v2.[REDACTED_PHONE]'],
  ['3.+905321234567', '3.[REDACTED_PHONE]'],
  ['Madde 5.0532 123 45 67', 'Madde [REDACTED_PHONE]'],
  ['1.0532 123 45 67', '[REDACTED_PHONE]'],
  ['09.11.2026 06:00', '09.11.2026 06:00'],
  ['09.11.2026 0532 123 45 67', '09.11.2026 [REDACTED_PHONE]'],
];
describe('A1 follow-up: masking is not looser than 0.17.1', () => {
  for (const [input, expected] of table) it(`"${input}"`, () => { expect(red(input)).toBe(expected); });
});
