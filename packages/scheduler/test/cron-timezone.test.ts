// `cron` with a time zone (`tz`, an IANA name). Before: cron was UTC only, and a UTC cron cannot say
// "09:00 in Berlin" — measured over 2026, `0 8 * * *` UTC is 09:00 in Berlin on 155 days and 10:00 on
// the other 210 (New York: 127 / 238; Sydney: 183 / 182). Only zones without DST (Istanbul, Tokyo) can
// be written as UTC.
//
// DST rules, the same as Temporal's `disambiguation: 'compatible'` plus Vixie cron's rule for the
// repeated hour:
//   - a wall time that does not exist (spring forward) fires once, shifted forward by the gap
//     (02:30 → 03:30) — skipping it would drop that day's run;
//   - a wall time that happens twice (fall back) fires once, at its first occurrence — unless the cron's
//     hour field is `*`: then every real hour is a run, and both happen.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { nextCronTime, scheduleWorkflow, pollScheduler, listTriggers, type WorkflowRunner } from '../src/index.js';

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { warn.mockRestore(); });

const local = (t: number, tz: string) =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: tz, dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23' }).format(new Date(t));
const iso = (t: number) => new Date(t).toISOString().slice(0, 16);

/** Every fire of `expr` from `from` while it is before `to`. */
function fires(expr: string, tz: string | undefined, from: number, to: number): number[] {
  const out: number[] = [];
  for (let t = nextCronTime(expr, from, tz); t < to; t = nextCronTime(expr, t, tz)) out.push(t);
  return out;
}

describe('nextCronTime with a time zone', () => {
  it('09:00 Europe/Berlin is 09:00 local on every day of 2026 — 365 of 365', () => {
    const all = fires('0 9 * * *', 'Europe/Berlin', Date.UTC(2025, 11, 31, 12), Date.UTC(2026, 11, 31, 12));
    expect(all).toHaveLength(365);
    expect(all.filter((t) => !local(t, 'Europe/Berlin').endsWith(' 09:00'))).toEqual([]);
  });

  it('spring forward (Berlin, 29 Mar 2026): a daily 02:30 fires once that day, at 03:30 CEST', () => {
    const all = fires('30 2 * * *', 'Europe/Berlin', Date.UTC(2026, 2, 27, 12), Date.UTC(2026, 2, 30, 12));
    expect(all.map(iso)).toEqual([
      '2026-03-28T01:30', // 02:30 CET
      '2026-03-29T01:30', // 02:30 does not exist → 03:30 CEST
      '2026-03-30T00:30', // 02:30 CEST
    ]);
  });

  it('fall back (Berlin, 25 Oct 2026): a daily 02:30 fires once, at the first 02:30', () => {
    const all = fires('30 2 * * *', 'Europe/Berlin', Date.UTC(2026, 9, 24, 12), Date.UTC(2026, 9, 26, 12));
    expect(all.map(iso)).toEqual(['2026-10-25T00:30', '2026-10-26T01:30']);
  });

  it('fall back: an hourly cron (hour `*`) runs in both real 02:xx hours — 25 runs on a 25-hour day', () => {
    const day = fires('30 * * * *', 'Europe/Berlin', Date.UTC(2026, 9, 24, 22), Date.UTC(2026, 9, 25, 23));
    expect(day).toHaveLength(25);
    expect(day.filter((t) => local(t, 'Europe/Berlin').endsWith(' 02:30')).map(iso)).toEqual(['2026-10-25T00:30', '2026-10-25T01:30']);
  });

  it('spring forward: an every-15-minutes cron neither stalls nor doubles in the missing hour (23 h → 92 runs)', () => {
    const day = fires('*/15 * * * *', 'Europe/Berlin', Date.UTC(2026, 2, 28, 22, 59), Date.UTC(2026, 2, 29, 21, 59));
    expect(day).toHaveLength(92);
    expect(new Set(day).size).toBe(day.length);
  });

  it('America/New_York (8 Mar 2026, gap at 02:00) and a southern zone (Sydney, 5 Apr 2026, fall back)', () => {
    expect(fires('30 2 * * *', 'America/New_York', Date.UTC(2026, 2, 7, 12), Date.UTC(2026, 2, 9, 12)).map(iso))
      .toEqual(['2026-03-08T07:30', '2026-03-09T06:30']); // 03:30 EDT on the gap day, then 02:30 EDT
    expect(fires('30 2 * * *', 'Australia/Sydney', Date.UTC(2026, 3, 3, 12), Date.UTC(2026, 3, 5, 12)).map(iso))
      .toEqual(['2026-04-03T15:30', '2026-04-04T15:30']); // 02:30 AEDT; on 5 Apr the first 02:30 is still AEDT
  });

  it('without tz (or tz UTC) the result is the UTC one, unchanged', () => {
    const from = Date.UTC(2026, 2, 27, 12);
    const to = Date.UTC(2026, 3, 2);
    expect(fires('30 2 * * 1-5', 'UTC', from, to)).toEqual(fires('30 2 * * 1-5', undefined, from, to));
  });
});

describe('scheduleWorkflow({ cron, tz })', () => {
  const T0 = Date.UTC(2026, 2, 27, 12);
  const runner = (): WorkflowRunner => ({ async runWorkflow(_n, _i, o) { return { runId: o?.runId ?? '?' }; } });

  it('the poller fires a Berlin 02:30 trigger across the spring-forward day: once a day', async () => {
    const j = new InMemoryJournal();
    const r = runner();
    await scheduleWorkflow(j, { id: 'nightly', name: 'wf', cron: '30 2 * * *', tz: 'Europe/Berlin' }, T0);
    const seen: number[] = [];
    for (let t = T0; t < Date.UTC(2026, 2, 31, 12); t += 15 * 60_000) {
      const before = (await listTriggers(j))[0]!.nextRunAt;
      const res = await pollScheduler(j, r, t);
      if (res.fired) seen.push(before);
    }
    expect(seen.map(iso)).toEqual(['2026-03-28T01:30', '2026-03-29T01:30', '2026-03-30T00:30', '2026-03-31T00:30']);
    expect((await listTriggers(j))[0]).toMatchObject({ tz: 'Europe/Berlin', fireCount: 4 });
  });

  it('refuses a zone that does not exist, and tz on every / at — nothing written', async () => {
    const j = new InMemoryJournal();
    await expect(scheduleWorkflow(j, { id: 'a', name: 'wf', cron: '0 9 * * *', tz: 'Mars/Olympus' }, T0)).rejects.toThrow(/tz/);
    await expect(scheduleWorkflow(j, { id: 'b', name: 'wf', every: 60_000, tz: 'Europe/Berlin' }, T0)).rejects.toThrow(/tz/);
    await expect(scheduleWorkflow(j, { id: 'c', name: 'wf', at: T0, tz: 'Europe/Berlin' }, T0)).rejects.toThrow(/tz/);
    expect(await j.listKeys!('sched:')).toEqual([]);
  });

  it('a zone spelled two ways is one spec (the canonical IANA name is stored)', async () => {
    const j = new InMemoryJournal();
    await scheduleWorkflow(j, { id: 'n', name: 'wf', cron: '0 9 * * *', tz: 'europe/berlin' }, T0);
    await scheduleWorkflow(j, { id: 'n', name: 'wf', cron: '0 9 * * *', tz: 'Europe/Berlin' }, T0); // no refusal
    expect((await listTriggers(j))[0]!.tz).toBe('Europe/Berlin');
  });

  it('a trigger stored without tz keeps its definition: the same spec again is a no-op, not a "different spec"', async () => {
    const j = new InMemoryJournal();
    await scheduleWorkflow(j, { id: 'u', name: 'wf', cron: '0 9 * * *' }, T0);
    const def = await j.get('sched:def:u');
    expect(def).not.toHaveProperty('tz');
    await scheduleWorkflow(j, { id: 'u', name: 'wf', cron: '0 9 * * *' }, T0);
    await expect(scheduleWorkflow(j, { id: 'u', name: 'wf', cron: '0 9 * * *', tz: 'Europe/Berlin' }, T0)).rejects.toThrow(/differs in tz/);
  });
});
