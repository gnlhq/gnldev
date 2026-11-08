// d25 P4 / madde 11 (KARAR-2, secenek A): a launch that is refused ends in one of three ways, by WHAT was
// refused, not by whether the run has an `outcome` record:
//   (a) the run is FINISHED (canceled, erased) -> its execution record is closed; it is not "waiting for an operator"
//   (b) the run never ran a step -> the record is deleted; the same request starts it from the beginning
//   (c) the run has a past and this process cannot continue it -> parked with the reason (today's behaviour)
// Real OS processes over one SQLite file (d25-resume/proc.ts). (c) is the negative control: it is green
// today and must stay green — parking is what protects a run whose side effect is uncertain.
//
// Not pinned (decision points): whether (a)/(b) "close" means the record is deleted or marked done — only
// that it is not `parked`.
import { describe, it, expect } from 'vitest';
import { crashThenServe } from './d25-resume/drive.js';

const parked = (exec: any[] = []) => exec.filter((r) => r.status === 'parked');

describe('d25 P4 #11 (b) — a run that never ran a step is not parked as "stopped part-way"', () => {
  for (const door of ['run', 'stream', 'chat', 'agui']) {
    it(`${door}: first launch refused (tool misdeclared), config fixed, the same turn runs`, () => {
      const { c, s } = crashThenServe({ WINDOW: 'none', DOOR: door }, { DOOR: door, WAIT_MS: '1500' });
      console.log(`[11b ${door}] first`, c.lines.CRASH_RESPONSE?.status, '| boot', JSON.stringify(s.lines.BOOT?.exec), '| redrive', s.lines.REDRIVE?.status, String(s.lines.REDRIVE?.full).slice(0, 160).replace(/\n/g, ' | '));
      if (door === 'run') expect(c.lines.CRASH_RESPONSE.status).toBe(400);
      expect(c.lines.CRASH_NOT_KILLED.effects).toBe(0); // nothing ran in the first process
      expect(parked(s.lines.BOOT.exec)).toEqual([]);
      expect(s.lines.REDRIVE.status).toBe(200);
      expect(s.lines.REDRIVE.full).toMatch(/paid/);
      expect(s.lines.AFTER_REDRIVE.effects).toBe(1);
      expect(parked(s.lines.AFTER_REDRIVE.exec)).toEqual([]);
    }, 120_000);
  }
});

describe('d25 P4 #11 (a) — a canceled run that is taken over ends canceled, not parked for an operator', () => {
  for (const door of ['run', 'stream', 'chat']) {
    it(`${door}: after the cancel, no execution record waits for an operator`, () => {
      const { s } = crashThenServe({ DOOR: door }, { DOOR: door, CANCEL: '1', WAIT_MS: '0', SETTLE_MS: '3000' });
      console.log(`[11a ${door}]`, s.lines.CANCEL?.status, JSON.stringify(s.lines.AFTER_REDRIVE?.exec).slice(0, 300));
      expect(s.lines.CANCEL.status).toBe(200);
      expect(parked(s.lines.AFTER_REDRIVE.exec)).toEqual([]);
      expect(s.lines.AFTER_REDRIVE.effects).toBe(1); // and the canceled run did not run its tool again
    }, 120_000);
  }
});

describe('d25 P4 #11 (c) negative control — a run with a past that this process cannot continue stays parked, and does not run again', () => {
  for (const door of ['run', 'stream']) {
    it(`${door}: still parked with its reason; the effect is not repeated by the re-sent turn`, () => {
      const { s } = crashThenServe({ DOOR: door }, { DOOR: door, WINDOW: 'none', WAIT_MS: '1500' });
      const p = parked(s.lines.AFTER_REDRIVE.exec);
      console.log(`[11c ${door}]`, JSON.stringify(p).slice(0, 240), 'effects', s.lines.AFTER_REDRIVE.effects);
      expect(p.length).toBe(1);
      expect(p[0].reason).toMatch(/could not be continued/);
      expect(s.lines.AFTER_REDRIVE.effects).toBe(1);
    }, 120_000);
  }
});
