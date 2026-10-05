// Minimal 5-field cron (minute resolution; UTC, or an IANA time zone). Supports '*', list ',', range '-', step '/'.
// dom/dow POSIX OR semantics: if both are restricted, "day-of-month OR day-of-week"; if one is '*', the other decides.

/** Converts a cron field into the set of allowed values within [min,max]. */
export function parseField(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const [rangeRaw, stepRaw] = part.split('/');
    const step = stepRaw !== undefined ? parseInt(stepRaw, 10) : 1;
    if (!Number.isFinite(step) || step < 1) throw new Error(`cron: invalid step '${part}'`);
    let lo: number;
    let hi: number;
    if (rangeRaw === '*' || rangeRaw === '') {
      lo = min;
      hi = max;
    } else if (rangeRaw.includes('-')) {
      const [a, b] = rangeRaw.split('-').map((x) => parseInt(x, 10));
      lo = a!;
      hi = b!;
    } else {
      lo = hi = parseInt(rangeRaw, 10);
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`cron: invalid range '${part}' (expected ${min}-${max})`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/** A parsed 5-field cron: the allowed values of each field, and which day fields were restricted. */
interface Cron {
  min: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  mon: Set<number>;
  dow: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

function parseCron(expr: string): Cron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron expects 5 fields (min hour day month weekday): '${expr}'`);
  return {
    min: parseField(fields[0]!, 0, 59),
    hour: parseField(fields[1]!, 0, 23),
    dom: parseField(fields[2]!, 1, 31),
    mon: parseField(fields[3]!, 1, 12),
    dow: parseField(fields[4]!, 0, 6),
    domRestricted: fields[2] !== '*',
    dowRestricted: fields[4] !== '*',
  };
}

/** The most days each month ever has (February: 29, in a leap year). */
const MAX_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * Why `expr` can NEVER fire, or `undefined` when it can. Throws for an expression that does not parse.
 *
 * A property of the expression alone, never of the date it is asked on. It used to be "does a match
 * exist within 366 days of now", which made the same spec valid on one day and invalid on another:
 * `0 0 29 2 *` (every leap day) was refused on 2026-01-01 and accepted on 2027-03-01, and the poller,
 * re-asking at the due time, failed the trigger it had accepted (the leap day after is four years on).
 *
 * The day fields are the only way to write a cron that never fires: every hour and minute exists on
 * every day. With day-of-week restricted the cron fires every week (POSIX: restricted day-of-month OR
 * restricted day-of-week; day-of-week alone decides when day-of-month is `*`). With day-of-month alone
 * restricted it fires iff some listed day exists in some listed month in SOME year — 29 February counts.
 */
export function cronNeverFires(expr: string): string | undefined {
  const c = parseCron(expr);
  if (!c.domRestricted || c.dowRestricted) return undefined;
  for (const m of c.mon) for (const d of c.dom) if (d <= MAX_DAYS[m - 1]!) return undefined;
  return `no month in '${expr.trim().split(/\s+/)[3]}' has day ${[...c.dom].sort((a, b) => a - b).join(',')}`;
}

/**
 * How far `nextCronTime` looks. The longest gap between two matches of a cron that can fire is the
 * leap day across a century that is not a leap year: 29 Feb 2096 → 29 Feb 2104, eight years.
 */
const HORIZON_DAYS = 8 * 366 + 31;
const DAY = 86_400_000;

/**
 * Returns the first cron match (epoch ms, minute boundary) AFTER the `after` (epoch ms) time.
 * 5 fields: minute hour day-of-month month day-of-week (0=Sunday). UTC unless `tz` names a zone.
 *
 * Walks DAYS, not minutes: the old minute-by-minute scan capped at 366 days (527 040 steps), which
 * cannot reach a leap day four years out; eight years of days is under 3 000 steps. UTC has no DST, so
 * a day is always 1 440 minutes and the first allowed hour:minute of a matching day is its first match.
 * With a `tz`, see `nextZonedCronTime` for what a DST day does.
 */
export function nextCronTime(expr: string, after: number, tz?: string): number {
  const c = parseCron(expr);
  const never = cronNeverFires(expr);
  if (never) throw new Error(`cron can never fire: ${never}`);
  const minutes: number[] = [];
  for (const h of [...c.hour].sort((a, b) => a - b)) for (const m of [...c.min].sort((a, b) => a - b)) minutes.push(h * 60 + m);
  if (tz !== undefined && tz !== 'UTC') return nextZonedCronTime(c, minutes, after, tz, expr);

  const first = Math.ceil((after + 1) / 60000) * 60000; // next minute boundary
  const day0 = Math.floor(first / DAY) * DAY;
  for (let i = 0; i <= HORIZON_DAYS; i++) {
    const midnight = day0 + i * DAY;
    const d = new Date(midnight);
    if (!dayMatches(c, d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCDay())) continue;
    const from = i === 0 ? (first - midnight) / 60000 : 0;
    const hit = minutes.find((m) => m >= from);
    if (hit !== undefined) return midnight + hit * 60000;
  }
  // Unreachable for a cron that can fire (see HORIZON_DAYS); kept as an honest error, not a loop.
  throw new Error(`cron: no match within ${HORIZON_DAYS} days: '${expr}'`);
}

function dayMatches(c: Cron, month: number, dom: number, dow: number): boolean {
  if (!c.mon.has(month)) return false;
  const domOk = c.dom.has(dom);
  const dowOk = c.dow.has(dow);
  return c.domRestricted && c.dowRestricted ? domOk || dowOk : domOk && dowOk;
}

// ─── Time zones ────────────────────────────────────────────────────────────────────────────────
// Node's own Intl (full ICU since Node 13) is the zone database: no dependency, and the rules update
// with the runtime. One formatter per zone, cached: constructing one costs far more than using it.
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    formatters.set(tz, f);
  }
  return f;
}

/**
 * The canonical IANA name of `tz` ('europe/berlin' → 'Europe/Berlin'), or `undefined` when the runtime
 * does not know the zone. The one check `scheduleWorkflow` and the poller use.
 */
export function canonicalTimeZone(tz: string): string | undefined {
  if (typeof tz !== 'string' || tz === '') return undefined;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

/** The wall clock in `tz` at instant `t`, as the epoch ms that wall clock would be in UTC. */
function wallMs(t: number, tz: string): number {
  const p: Record<string, number> = {};
  for (const x of formatter(tz).formatToParts(new Date(t))) if (x.type !== 'literal') p[x.type] = Number(x.value);
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
}
/** The zone's offset (ms, wall − UTC) at instant `t`. */
const offsetAt = (t: number, tz: string): number => wallMs(t, tz) - Math.floor(t / 1000) * 1000;

/**
 * `nextCronTime` in a zone. The cron is read against the zone's WALL CLOCK; the result is an instant.
 *
 * A DST day has a wall time that never happens (spring forward) or happens twice (fall back):
 *   - never happens (02:30 on a 02:00→03:00 day): fires once, shifted forward by the gap (03:30) —
 *     Temporal's `disambiguation: 'compatible'`. Skipping it would drop that day's run of a daily job;
 *     the shifted time of an every-N-minutes cron lands on a real time it also matches, so nothing doubles.
 *   - happens twice (02:30 on a 03:00→02:00 day): fires once, at the FIRST occurrence — unless the hour
 *     field is `*`, where every real hour is an occurrence of its own and both run (Vixie cron's rule:
 *     an hourly job runs 25 times on a 25-hour day, a 02:30 job once).
 *
 * Per local day: the zone's offset at the day's two ends. Equal (every day but two a year) → each wall
 * time is one instant, no further zone lookups. Different → each wall time is resolved on its own.
 */
function nextZonedCronTime(c: Cron, minutes: number[], after: number, tz: string, expr: string): number {
  const hourIsWild = c.hour.size === 24;
  const startWall = wallMs(after, tz);
  const day0 = Math.floor(startWall / DAY) * DAY - DAY; // the day before: an instant can belong to it
  for (let i = 0; i <= HORIZON_DAYS + 1; i++) {
    const midnight = day0 + i * DAY; // the local date, as UTC midnight of the same calendar date
    const d = new Date(midnight);
    if (!dayMatches(c, d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCDay())) continue;
    // Offsets that can apply on this local date: ±14 h covers every zone's distance from UTC.
    const offA = offsetAt(midnight - 14 * 3_600_000, tz);
    const offB = offsetAt(midnight + DAY + 14 * 3_600_000, tz);
    let best: number | undefined;
    for (const m of minutes) {
      const wall = midnight + m * 60000;
      let instants: number[];
      if (offA === offB) {
        instants = [wall - offA];
      } else {
        const valid = [...new Set([wall - offA, wall - offB])].filter((t) => wallMs(t, tz) === wall).sort((x, y) => x - y);
        if (valid.length === 0) instants = [wall - Math.min(offA, offB)]; // in the gap: shifted forward by it
        else instants = hourIsWild ? valid : [valid[0]!]; // repeated: once, or every real hour
      }
      for (const t of instants) if (t > after && (best === undefined || t < best)) best = t;
    }
    if (best !== undefined) return best;
  }
  throw new Error(`cron: no match within ${HORIZON_DAYS} days: '${expr}' (tz ${tz})`);
}
