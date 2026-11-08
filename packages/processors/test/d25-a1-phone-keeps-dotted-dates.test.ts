// d25 A1 (memory/KARAR-2, option A): the built-in `phone` rule must not eat a written date or time.
// Reported: `randevu 09.11.2026 06:00 olsun` became `randevu [REDACTED_PHONE]:00 olsun` — the most common way a
// date is written in Turkey. The ISO form was already safe on 0.17.1 (pattern lookahead); the dotted day.month.year
// form was not. The rule: a candidate that is a valid calendar date / clock time is not a phone number.
//
// Equally load-bearing: the mask must NOT loosen. Real phone numbers — including dotted ones and ones
// sitting right next to a date — still mask, and a dotted shape that is NOT a valid calendar date still masks.
import { describe, it, expect } from 'vitest';
import { piiRedactor, piiTextRedactor } from '../src/index.js';

const viaProcessor = async (text: string) => {
  const p: any = piiRedactor();
  const out = await p.processInput({ prompt: text, messages: [{ role: 'user', content: text }] }, {});
  return out.messages[0].content as string;
};
const viaText = (text: string) => piiTextRedactor()(text);

describe('A1: written dates and times survive the phone rule', () => {
  // The reported shape, and the same rule through other written forms the decision names (dd.mm.yyyy, dd/mm/yyyy, hh:mm).
  const dates = [
    '09.11.2026 06:00',      // reported
    '09.11.2026',            // the date alone (8 digits: clears the phone digit floor on its own)
    '9.11.2026 14:30',       // single-digit day
    '31.12.2026 23:59',      // last day of the year, last minute
    '09.11.2026 06:00:00',   // with seconds
    '01.02.2027 09:15',
    '09/11/2026 06:00',      // slash form
  ];
  for (const d of dates) {
    it(`processor keeps "${d}"`, async () => {
      expect(await viaProcessor(`randevu ${d} olsun`)).toBe(`randevu ${d} olsun`);
    });
    it(`text redactor keeps "${d}"`, () => {
      expect(viaText(`randevu ${d} olsun`)).toBe(`randevu ${d} olsun`);
    });
  }
  it('two dotted dates in one sentence (a range) both survive', () => {
    const s = 'izin 09.11.2026 - 13.11.2026 arasi';
    expect(viaText(s)).toBe(s);
  });
});

describe('A1 negative controls: the phone mask does not loosen', () => {
  const phones = [
    '0532 123 45 67', '+90 532 123 45 67', '0212 555 12 34', '+90 5321234567',
    // dotted phones — the same separator a date uses
    '0532.123.45.67', '555.123.4567', '+90.532.123.4567', '0212.555.1234',
  ];
  for (const p of phones) {
    it(`still masks "${p}"`, async () => {
      expect(viaText(`ara ${p} lutfen`)).toBe('ara [REDACTED_PHONE] lutfen');
      expect(await viaProcessor(`ara ${p} lutfen`)).toBe('ara [REDACTED_PHONE] lutfen');
    });
  }
  it('a dotted number that is NOT a valid calendar date still masks (day 45, month 67)', () => {
    expect(viaText('ara 45.67.8901 23 lutfen')).toBe('ara [REDACTED_PHONE] lutfen');
  });
  it('a date and a phone in the same message: the date stays, the phone is masked', async () => {
    const out = await viaProcessor('randevu 09.11.2026 06:00, tel 0532 123 45 67');
    expect(out).toContain('09.11.2026 06:00');
    expect(out).toContain('[REDACTED_PHONE]');
    expect(out).not.toContain('0532');
    expect(out).not.toContain('123 45 67');
  });
  it('a phone right after a date (no comma) is still masked', () => {
    const out = viaText('09.11.2026 tarihinde 0532 123 45 67 arayin');
    expect(out).toContain('09.11.2026');
    expect(out).not.toContain('123 45 67');
  });
});
