// d25 P4 / madde 10 (KARAR-1, secenek A), the third ending: a run that STOPPED PART-WAY and cannot be
// continued by this process waits for an operator (`run_not_continued`). The client must be able to tell it
// from a canceled run (`run_canceled`, server/test/d25-p4-run-end-mapping.test.ts) and from a failed one —
// through every door, by the same `code`. Today /run answers `409 run_not_continued` (the one door that does);
// /stream sends an error event with no `code`, the chat surface masks it as "An error occurred.", AG-UI
// sends RUN_ERROR with no code.
//
// The run is made genuinely stuck: it has a past (its tool began and the process was killed inside it), and
// the restarted deployment declares the tool wrongly (an idempotencyKey without a window), so the engine
// refuses to continue it. Two real OS processes over one SQLite file.
import { describe, it, expect } from 'vitest';
import { crashThenServe } from './d25-resume/drive.js';

function codesIn(door: string, status: number, full: string): { codes: string[]; text: string } {
  const codes: string[] = [];
  if (door === 'run') { try { const b = JSON.parse(full); if (b.code) codes.push(b.code); } catch { /* */ } return { codes, text: full }; }
  for (const raw of full.split('\n\n')) {
    const ev = /^event: (.*)$/m.exec(raw)?.[1]; const data = /^data: (.*)$/m.exec(raw)?.[1];
    if (!data) continue;
    try {
      const d = JSON.parse(data);
      if (door === 'stream' && ev === 'error' && d.code) codes.push(d.code);
      if (door === 'agui' && d.type === 'RUN_ERROR' && d.code) codes.push(d.code);
    } catch { /* */ }
  }
  return { codes, text: full };
}

describe('d25 P4 #10 — a run stuck waiting for an operator is told `run_not_continued`, through every door', () => {
  for (const door of ['run', 'stream', 'chat', 'agui']) {
    it(`${door}: the re-sent turn is answered with the code, the effect did not run again`, () => {
      const { c, s } = crashThenServe({ DOOR: door }, { DOOR: door, WINDOW: 'none', WAIT_MS: '1500' });
      expect(c.status).not.toBe(0); // killed inside the tool: the run has a past
      const parked = (s.lines.AFTER_WAIT?.exec ?? []).filter((r: any) => r.status === 'parked' && /could not be continued/.test(r.reason ?? ''));
      expect(parked.length).toBe(1); // precondition: it IS stuck (not a cancel, not a launch that never began)
      const r = s.lines.REDRIVE;
      const a = codesIn(door, r.status, r.full);
      console.log(`[stuck ${door}]`, r.status, a.codes, r.full.slice(0, 260).replace(/\n/g, ' | '));
      if (door === 'run') { expect(r.status).toBe(409); expect(a.codes).toContain('run_not_continued'); }
      else if (door === 'chat') expect(r.full).toContain('run_not_continued');
      else expect(a.codes).toContain('run_not_continued');
      expect(s.lines.AFTER_REDRIVE.effects).toBe(1); // nothing was run again
    }, 120_000);
  }
});
