// What a part contributed, and how far a number can be trusted — pure arithmetic, no model call.
//
// shapley: a part's share is the average of what adding it changes, over every set of the other parts
// (the Shapley value — the one split that is efficient, symmetric, gives nothing to a part that changes
// nothing, and adds up across games). The shares always sum to value(all parts) − value(no part); a
// table that does not is a bug, and a test holds it to that.
//
// meanInterval / wilson: a number from k trials is a sample. A mean is given with Student's t (k is
// small — 5 to 20 — and the normal interval is too narrow there); a rate with Wilson, which does not
// claim "1.0 ± 0.0" from twenty successes out of twenty.
//
// newcombe: the difference of two rates with its interval (Newcombe's hybrid score method, built from
// the two Wilson intervals) — what "this change made the right answer more frequent" rests on. Its `z`
// is the caller's: a comparison among m, held to a family-wide 5%, takes the Bonferroni z of 0.05/m.
//
// tvd: how different two outcome distributions are, 0 (same) to 1 (nothing in common). Measured: two
// sets of 5 runs of the very same prompt differed by 0.24 — the noise floor has to be measured beside
// any difference that is reported.

/** The key a set of parts is stored under: its ids sorted and joined, '∅' for none. */
export function coalitionKey(parts: Iterable<string>): string {
  return [...parts].sort().join('+') || '∅';
}

/** Every subset of `players`, the empty one first. 2^n of them: past 12 players this refuses. */
export function coalitions(players: readonly string[]): Set<string>[] {
  if (new Set(players).size !== players.length) throw new TypeError('@gnldev/experiment: coalitions: player ids must be unique');
  if (players.length > 12) {
    throw new RangeError(`@gnldev/experiment: ${players.length} players are 2^${players.length} subsets — group parts into at most 12 players`);
  }
  const out: Set<string>[] = [];
  for (let m = 0; m < 1 << players.length; m++) out.push(new Set(players.filter((_, i) => m & (1 << i))));
  return out;
}

const factorial = (k: number): number => (k <= 1 ? 1 : k * factorial(k - 1));

/**
 * Each player's Shapley value from a value for every subset (keyed by `coalitionKey`). A subset with no
 * value is an error, not a zero: a missing measurement would silently move share between players.
 */
export function shapley(players: readonly string[], values: Readonly<Record<string, number>>): Record<string, number> {
  const n = players.length;
  const v = (set: readonly string[]) => {
    const x = values[coalitionKey(set)];
    if (typeof x !== 'number' || Number.isNaN(x)) throw new RangeError(`@gnldev/experiment: shapley: no value for {${coalitionKey(set)}}`);
    return x;
  };
  const out: Record<string, number> = {};
  for (const p of players) {
    const others = players.filter((q) => q !== p);
    let sum = 0;
    for (let m = 0; m < 1 << others.length; m++) {
      const s = others.filter((_, i) => m & (1 << i));
      sum += ((factorial(s.length) * factorial(n - s.length - 1)) / factorial(n)) * (v([...s, p]) - v(s));
    }
    out[p] = sum;
  }
  return out;
}

// Two-sided 95% Student's t for 1..30 degrees of freedom; past 30 the normal 1.96.
const T95 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042];

export interface Interval {
  value: number;
  low: number;
  high: number;
  /** How many numbers it rests on. */
  n: number;
}

/** The mean of `xs` with a 95% interval (Student's t). Fewer than two numbers have no interval. */
export function meanInterval(xs: readonly number[]): Interval {
  const n = xs.length;
  if (n === 0) return { value: NaN, low: NaN, high: NaN, n };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { value: mean, low: NaN, high: NaN, n };
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  const half = (T95[n - 2] ?? 1.96) * (sd / Math.sqrt(n));
  return { value: mean, low: mean - half, high: mean + half, n };
}

/** A rate of `successes` in `n` trials with its Wilson interval — 95% unless another `z` is given. */
export function wilson(successes: number, n: number, z = 1.96): Interval {
  if (n === 0) return { value: NaN, low: NaN, high: NaN, n };
  const p = successes / n, d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n), h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { value: p, low: Math.max(0, (c - h) / d), high: Math.min(1, (c + h) / d), n };
}

/** The share of each distinct outcome in `outcomes`. */
export function distribution(outcomes: readonly string[]): Record<string, number> {
  const d: Record<string, number> = {};
  for (const o of outcomes) d[o] = (d[o] ?? 0) + 1 / outcomes.length;
  return d;
}

/** Total variation distance between two distributions: 0 the same, 1 nothing in common. */
export function tvd(a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>): number {
  let s = 0;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) s += Math.abs((a[k] ?? 0) - (b[k] ?? 0));
  return s / 2;
}

/**
 * The standard normal quantile: the z below which a share `p` of the distribution lies (Acklam's
 * rational approximation, relative error under 1.2e-9). `normalQuantile(0.975)` is 1.95996…
 */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError(`@gnldev/experiment: normalQuantile: p must lie strictly between 0 and 1 (got ${p})`);
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p > 1 - lo) return -normalQuantile(1 - p);
  const q = p - 0.5, r = q * q;
  return ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

/**
 * The difference of two rates, `a` minus `b`, with its interval at `z` (default 1.96, 95%): Newcombe's
 * hybrid score interval from the two Wilson intervals. `n` is the smaller of the two counts. A side with
 * no trials has no difference.
 */
export function newcombe(a: { successes: number; n: number }, b: { successes: number; n: number }, z = 1.96): Interval {
  const n = Math.min(a.n, b.n);
  if (a.n === 0 || b.n === 0) return { value: NaN, low: NaN, high: NaN, n };
  const A = wilson(a.successes, a.n, z), B = wilson(b.successes, b.n, z);
  const d = A.value - B.value;
  return {
    value: d,
    low: d - Math.sqrt((A.value - A.low) ** 2 + (B.high - B.value) ** 2),
    high: d + Math.sqrt((A.high - A.value) ** 2 + (B.value - B.low) ** 2),
    n,
  };
}
