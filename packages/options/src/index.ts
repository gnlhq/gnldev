// The one rule for every options object GNL reads: a name it does not take is refused, naming the
// option it is closest to. An options object read by name and never checked drops a misspelled
// name without a word — measured, a misspelled `authorize`, `guard` or `limits.maxToolCalls` left
// the door, the agent or the run without it.

/** Names a reader took once and no longer does, each with the sentence that says what replaced it. */
export type RemovedNames = Readonly<Record<string, string>>;

/**
 * Throws on the first name in `value` that is not one of `names`. `where` names the reader in the
 * message (`createChatRoute`, `limits`). A name set to `undefined` is no name: spreading an optional
 * value is not refused.
 */
export function refuseUnknownNames(where: string, value: unknown, names: readonly string[], removed: RemovedNames = {}): void {
  if (value === null || typeof value !== 'object') return;
  const o = value as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (o[k] === undefined || names.includes(k)) continue;
    if (Object.hasOwn(removed, k)) throw new TypeError(`${where}: \`${k}\` ${removed[k]}`);
    const near = closestName(k, names);
    throw new TypeError(
      `${where}: \`${k}\` is not an option${near ? ` — did you mean \`${near}\`?` : '.'} Nothing would read it, so it would run without it. Options: ${names.join(', ')}.`,
    );
  }
}

/**
 * For an object a reader passes on to another library (`runDurable`'s arguments go on to the AI SDK's
 * `generateText`): the names this reader knows are `names` — its own and the other library's as built
 * against — and a name that is not one of them is refused only when it is a misspelling of one. A name
 * close to none belongs to the other library (a newer version's option) and passes, so checking never
 * stands between the host and an option the other library added after this build.
 */
export function refuseMisspelledNames(where: string, value: unknown, names: readonly string[]): void {
  if (value === null || typeof value !== 'object') return;
  const o = value as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (o[k] === undefined || names.includes(k)) continue;
    const near = closestName(k, names);
    if (near) throw new TypeError(`${where}: \`${k}\` is not an option — did you mean \`${near}\`? Nothing would read it, so it would run without it.`);
  }
}

/** Every member name of every variant of `T` (`keyof` of a union is only the names all variants share). */
export type AnyVariantName<T> = T extends unknown ? keyof T & string : never;

/** `optionNames` for a union: held to the names of all its variants. */
export function variantNames<T>() {
  return <const K extends readonly AnyVariantName<T>[]>(
    keys: K & ([Exclude<AnyVariantName<T>, K[number]>] extends [never] ? unknown : { missing: Exclude<AnyVariantName<T>, K[number]> }),
  ): K => keys;
}

/**
 * The names of `T`, held to it by the compiler: a name that is no member does not typecheck, and a
 * member left out names itself in the error (`missing`). Symbol keys are no names a host writes, so
 * they are not listed (and `Object.keys` never sees them).
 *
 *   const KEYS = optionNames<MyOptions>()(['identify', 'authorize']);
 */
export function optionNames<T>() {
  return <const K extends readonly (keyof T & string)[]>(
    keys: K & ([Exclude<keyof T & string, K[number]>] extends [never] ? unknown : { missing: Exclude<keyof T & string, K[number]> }),
  ): K => keys;
}

/**
 * The name a misspelled one most likely meant: the same letters ignoring case, the same word in the
 * singular or plural (`maxRetry` for `maxRetries`), at most 2 edits away, or one the start of the other
 * (`ttl` for `ttlSec`) when that start is 3 letters or more.
 */
function closestName(name: string, names: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestD = 3;
  const n = name.toLowerCase();
  for (const k of names) {
    const l = k.toLowerCase();
    const d = l === n ? 0 : singular(l) === singular(n) ? 1 : Math.min(editDistance(name, k), Math.min(l.length, n.length) >= 3 && (l.startsWith(n) || n.startsWith(l)) ? 2 : 3);
    if (d < bestD) { best = k; bestD = d; }
  }
  return best;
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

function singular(w: string): string {
  return w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.endsWith('s') ? w.slice(0, -1) : w;
}
