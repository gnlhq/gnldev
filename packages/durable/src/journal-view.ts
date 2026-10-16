// A JOURNAL VIEW THAT HIDES ROWS — the one way such a view is built.
//
// THE RULE: a view that hides a row hides it from EVERY read. Two views hide rows: the root scope
// (`withRootScope`, every organization's) and an end user's (`withSubjectJournal`, every run not theirs).
// Both used to be proxies that named the reads they filtered and handed every other member to the raw
// journal. `readRange` arrived (a run's event log is read with it), neither named it, and both returned
// the rows their `get` hides (release audit 2026-10-12 A3/D3) — as `getMany`, `getCounters`,
// `listOwnerRecords` and `listStaleRuns` already did through the end user's view.
//
// So the filtering is not each view's list any more:
//   · JOURNAL_PORT classifies EVERY member of the port, checked by type: a member added to `Journal` or
//     `JournalReader` does not compile until it is classified here.
//   · Every read BY KEY (`key`) is derived from the view's one key rule (`hides`).
//   · Every read BY RUN (`run`) — ids, listings, counts — is answered by the view itself, each one named:
//     the view's type requires all of them (`undefined` is an answer: "not served here").
//   · Writes and the clock (`pass`) go to the journal underneath.
//   · A method the port does not have (an adapter's own) is NOT passed: a view serves the port, and a
//     read nobody classified is a read nobody filtered.
import type { Journal, JournalReader } from './journal.js';

export type JournalPortMember = keyof Journal | keyof JournalReader;
export type JournalPortKind = 'key' | 'run' | 'pass';

/** Every member of the Journal port, by what a view that hides rows does with it. */
export const JOURNAL_PORT = {
  get: 'key', getMany: 'key', getCounters: 'key', listKeys: 'key', readRange: 'key', listOwnerRecords: 'key',
  readRun: 'run', readRunStats: 'run', listRuns: 'run', listRunsPaged: 'run', listStaleRuns: 'run',
  countRuns: 'run', countRunsByStatus: 'run', listRunsChangedSince: 'run',
  put: 'pass', putIfAbsent: 'pass', putIfMatch: 'pass', deletePrefix: 'pass', incrBy: 'pass', applyBatch: 'pass', now: 'pass',
} as const satisfies Record<JournalPortMember, JournalPortKind>;

type RunMember = { [K in keyof typeof JOURNAL_PORT]: (typeof JOURNAL_PORT)[K] extends 'run' ? K : never }[keyof typeof JOURNAL_PORT];

/** A listing in hand while its keys are judged: what `hides` may answer from without a read. */
export interface Listed { prefix: string; keys: readonly string[] }

export interface HidingRule {
  /** THE key rule: whether `key` is hidden from this view. `listed`: the listing the key came from, whole. */
  hides(key: string, listed?: Listed): boolean | Promise<boolean>;
  /** Every key under `prefix` is hidden (a shortcut only: the result is the same without it). */
  hidesPrefix?(prefix: string): boolean;
  /** Each read by run, answered by the view (`undefined`: not served by this view). */
  runs: { [K in RunMember]: ((...args: any[]) => Promise<unknown>) | undefined };
  /** Markers the view carries (a brand, the journal it hides rows of). */
  marks?: Record<PropertyKey, unknown>;
}

/** The page size a filtered range read asks the store for while it fills the caller's page. */
const RANGE_CHUNK = 256;

export function hidingView<J extends object>(journal: J, rule: HidingRule): J {
  const j = journal as Partial<Journal> & Partial<JournalReader>;
  const hidden = (k: string, listed?: Listed) => rule.hides(k, listed);
  const prefixHidden = (p: string) => rule.hidesPrefix?.(p) === true;
  const keep = async (keys: string[], listed?: Listed) => {
    const out: string[] = [];
    for (const k of keys) if (!(await hidden(k, listed))) out.push(k);
    return out;
  };
  const derived: Record<keyof typeof JOURNAL_PORT & string, unknown> = {
    get: j.get && (async (key: string) => ((await hidden(key)) ? undefined : j.get!(key))),
    getCounters: j.getCounters && (async (key: string) => ((await hidden(key)) ? undefined : j.getCounters!(key))),
    getMany: j.getMany && (async (keys: string[]) => {
      const shown: string[] = [];
      const show: boolean[] = [];
      for (const k of keys) { const s = !(await hidden(k)); show.push(s); if (s) shown.push(k); }
      const got = shown.length ? await j.getMany!(shown) : [];
      let i = 0;
      return keys.map((_, n) => (show[n] ? got[i++] : undefined));
    }),
    listKeys: j.listKeys && (async (p: string, o?: { limit?: number }) => {
      if (prefixHidden(p)) return [];
      const keys = await j.listKeys!(p, o);
      return keep(keys, o?.limit === undefined ? { prefix: p, keys } : undefined);
    }),
    // A page of the store's range is filtered and the next one read until the caller's page is full or
    // the range is over: a page that comes back short means "no more", through the view as underneath.
    readRange: j.readRange && (async <T>(p: string, o: { after?: string; limit: number; desc?: boolean }) => {
      if (prefixHidden(p)) return [];
      const out: Array<[string, T]> = [];
      let after = o.after;
      for (;;) {
        const chunk = Math.max(o.limit, RANGE_CHUNK);
        const page = await j.readRange!<T>(p, { ...o, ...(after !== undefined ? { after } : {}), limit: chunk });
        for (const row of page) {
          if (!(await hidden(row[0]))) out.push(row);
          if (out.length >= o.limit) return out;
        }
        if (page.length < chunk) return out;
        after = page[page.length - 1]![0];
      }
    }),
    listOwnerRecords: j.listOwnerRecords && (async (rid: string, o?: { prefix?: string }) =>
      (prefixHidden(o?.prefix ?? '') ? [] : keep(await j.listOwnerRecords!(rid, o)))),
    ...rule.runs,
    put: undefined, putIfAbsent: undefined, putIfMatch: undefined, deletePrefix: undefined, incrBy: undefined, applyBatch: undefined, now: undefined,
  };
  const own = (prop: PropertyKey) => Object.prototype.hasOwnProperty.call(rule.marks ?? {}, prop);
  const kind = (prop: PropertyKey): JournalPortKind | undefined =>
    (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(JOURNAL_PORT, prop) ? JOURNAL_PORT[prop as keyof typeof JOURNAL_PORT] : undefined);
  const resolve = (t: J, prop: PropertyKey): unknown => {
    if (own(prop)) return rule.marks![prop];
    const k = kind(prop);
    if (k === 'key' || k === 'run') return derived[prop as keyof typeof derived];
    const v = Reflect.get(t, prop, t);
    if (typeof v !== 'function') return v; // a marker underneath (an organization's, process-local) stays readable
    return k === 'pass' ? v.bind(t) : undefined; // an adapter's own method: not the port's, not passed
  };
  return new Proxy(journal, {
    get: (t, prop) => resolve(t, prop),
    has: (t, prop) => resolve(t, prop) !== undefined,
  });
}
