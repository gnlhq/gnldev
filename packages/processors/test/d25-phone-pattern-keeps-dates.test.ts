// d25 finding 4: the built-in `phone` pattern must not eat ISO dates/times. Reported: `2026-11-09T06:00` -> `[REDACTED_PHONE]:00`.
import { describe, it, expect } from 'vitest';
import { piiRedactor } from '../src/index.js';

const run = async (text: string) => {
  const p: any = piiRedactor();
  const out = await p.processInput({ prompt: text, messages: [{ role: 'user', content: text }] }, {});
  return out.messages[0].content as string;
};
describe('phone pattern vs dates and times', () => {
  for (const s of ['2026-11-09T06:00', '2026-11-09T06:00:00Z', '2026-11-09 06:00', '2026-11-09', '2026-11-09T06:00:00+03:00', '09.11.2026 06:00', '06:00-07:30', '2026-11-09T06:00/2026-11-09T07:00']) {
    it(`keeps "${s}"`, async () => {
      const out = await run(`randevu ${s} olsun`);
      expect(out).toBe(`randevu ${s} olsun`);
    });
  }
  it('still masks a real phone', async () => {
    expect(await run('ara 0532 123 45 67 lütfen')).toContain('[REDACTED_PHONE]');
    expect(await run('ara +90 532 123 45 67 lütfen')).toContain('[REDACTED_PHONE]');
  });
});
