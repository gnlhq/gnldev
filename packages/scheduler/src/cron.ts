// Minimal 5-field cron (minute resolution, UTC). Supports '*', list ',', range '-', step '/'.
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
 * 5 fields: minute hour day-of-month month day-of-week (0=Sunday). UTC.
 *
 * Walks DAYS, not minutes: the old minute-by-minute scan capped at 366 days (527 040 steps), which
 * cannot reach a leap day four years out; eight years of days is under 3 000 steps. UTC has no DST, so
 * a day is always 1 440 minutes and the first allowed hour:minute of a matching day is its first match.
 */
export function nextCronTime(expr: string, after: number): number {
  const c = parseCron(expr);
  const never = cronNeverFires(expr);
  if (never) throw new Error(`cron can never fire: ${never}`);
  const minutes: number[] = [];
  for (const h of [...c.hour].sort((a, b) => a - b)) for (const m of [...c.min].sort((a, b) => a - b)) minutes.push(h * 60 + m);

  const first = Math.ceil((after + 1) / 60000) * 60000; // next minute boundary
  const day0 = Math.floor(first / DAY) * DAY;
  for (let i = 0; i <= HORIZON_DAYS; i++) {
    const midnight = day0 + i * DAY;
    const d = new Date(midnight);
    if (!c.mon.has(d.getUTCMonth() + 1)) continue;
    const domOk = c.dom.has(d.getUTCDate());
    const dowOk = c.dow.has(d.getUTCDay());
    if (!(c.domRestricted && c.dowRestricted ? domOk || dowOk : domOk && dowOk)) continue;
    const from = i === 0 ? (first - midnight) / 60000 : 0;
    const hit = minutes.find((m) => m >= from);
    if (hit !== undefined) return midnight + hit * 60000;
  }
  // Unreachable for a cron that can fire (see HORIZON_DAYS); kept as an honest error, not a loop.
  throw new Error(`cron: no match within ${HORIZON_DAYS} days: '${expr}'`);
}
