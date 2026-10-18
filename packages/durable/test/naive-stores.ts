// Eight stores that each break ONE guarantee of a run store (and a control that breaks none) — each
// wraps a correct InMemoryJournal, so a scenario that fails on one is about that guarantee alone. What
// the store conformance kit is measured by: a store that breaks a guarantee must be refused where it
// enters or fail the kit; one that breaks nothing must pass it whole.
import { InMemoryJournal, JOURNAL_GUARANTEES } from '../src/journal.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** `base` (a correct journal, InMemoryJournal by default) with the methods `over` gives replaced and `hide`'s gone. */
export function wrap(over: (t: any) => Record<string, unknown>, hide: readonly string[] = [], base: any = new InMemoryJournal()): any {
  const t: any = base;
  const o = over(t);
  return new Proxy(t, {
    get(target, p) {
      if (typeof p === 'string' && hide.includes(p)) return undefined;
      if (typeof p === 'string' && p in o) return o[p];
      const v = Reflect.get(target, p, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
    has(target, p) { return typeof p === 'string' && hide.includes(p) ? false : Reflect.has(target, p); },
  });
}

export const NAIVE_STORES: Record<string, { breaks: string; make: () => any }> = {
  N1: { breaks: 'no guarantee at all — get and put only', make: () => wrap(() => ({}), JOURNAL_GUARANTEES) },
  N2: { breaks: 'putIfMatch reads, waits, then writes', make: () => wrap((t) => ({ putIfMatch: async (k: string, e: unknown, v: unknown) => { const cur = await t.get(k); await tick(); if (cur === undefined || !same(cur, e)) return false; await t.put(k, v); return true; } })) },
  N3: { breaks: 'putIfAbsent reads, waits, then writes', make: () => wrap((t) => ({ putIfAbsent: async (k: string, v: unknown) => { const had = await t.get(k); await tick(); if (had !== undefined) return false; await t.put(k, v); return true; } })) },
  N4: { breaks: 'applyBatch writes one by one, so a failing value leaves the earlier ones behind', make: () => wrap((t) => ({ applyBatch: async (b: any) => {
    if (b.claim && !(await t.putIfAbsent(b.claim.key, b.claim.value))) return false;
    for (const x of b.incrs ?? []) await t.incrBy(x.key, x.fields);
    for (const x of b.puts ?? []) await t.put(x.key, x.value);
    return true;
  } })) },
  N5: { breaks: 'incrBy reads, waits, then writes the sum', make: () => wrap((t) => {
    const plain = new Map<string, Record<string, number>>();
    return {
      incrBy: async (k: string, fields: Record<string, number>) => { const cur = { ...(plain.get(k) ?? {}) }; await tick(); for (const [f, d] of Object.entries(fields)) cur[f] = (cur[f] ?? 0) + d; plain.set(k, cur); return { ...cur }; },
      getCounters: async (k: string) => (plain.has(k) ? { ...plain.get(k)! } : undefined),
      deletePrefix: async (p: string) => { let n = await t.deletePrefix(p); for (const k of [...plain.keys()]) if (k.startsWith(p)) { plain.delete(k); n++; } return n; },
    };
  }) },
  N6: { breaks: 'listKeys is unsorted and not bounded by the prefix ("a:" also lists "a;x")', make: () => wrap((t) => ({ listKeys: async (prefix: string, opts?: { limit?: number }) => {
    const all: string[] = await t.listKeys('');
    const out = all.filter((k) => k.startsWith(prefix.length ? prefix.slice(0, -1) : prefix)).reverse();
    return opts?.limit !== undefined ? out.slice(0, opts.limit) : out;
  } })) },
  N7: { breaks: 'now() is this machine\'s clock plus 5 s', make: () => wrap(() => ({ now: async () => Date.now() + 5_000 })) },
  N8: { breaks: 'the change feed in key order, not change order', make: () => wrap((t) => ({ listRunsChangedSince: async (cursor?: string, opts?: any) => {
    const r = await t.listRunsChangedSince(cursor, { ...opts, limit: 10_000 });
    const items = [...r.items].sort((a: any, b: any) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0)).slice(0, opts?.limit ?? 200);
    return { ...r, items };
  } })) },
  CONTROL: { breaks: 'nothing', make: () => new InMemoryJournal() },
};
