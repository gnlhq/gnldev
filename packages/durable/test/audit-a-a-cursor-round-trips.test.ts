// AUDIT A (red, low): a cursor `parseCursor` accepts must be one `formatCursor` writes back the same — a door
// parses `Last-Event-ID`, formats it again (server cursorOf), and the follow parses it a second time. A seq
// past Number.MAX_SAFE_INTEGER is accepted, formatted as '1e+23', and that is no cursor: the follow starts
// over from 0 and replays the whole run to a reader that said it holds everything.
import { describe, it, expect } from 'vitest';
import { parseCursor, formatCursor } from '../src/index.js';

describe('a cursor round-trips', () => {
  for (const raw of ['99999999999999999999999', '9007199254740993', '5.99999999999999999999999']) {
    it(`'${raw}' is refused or survives parse → format → parse`, () => {
      const p = parseCursor(raw);
      if (p === undefined) return;
      const again = parseCursor(formatCursor(p.seq, p.offset));
      expect(again, `parse('${raw}') = ${JSON.stringify(p)}, formatted '${formatCursor(p.seq, p.offset)}'`).toEqual(p);
      expect(Number.isSafeInteger(p.seq) && Number.isSafeInteger(p.offset), `parse('${raw}') = ${JSON.stringify(p)}`).toBe(true);
    });
  }
});
