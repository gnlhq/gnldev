// THE BIRTH WITNESS — every test file of the repository runs with it (vitest.config.ts `setupFiles`).
//
// The rule it holds: a run's first record is its birth. Nothing writes a record under a run id
// (`<runId>:<family>…`, run-id-grammar.ts) that does not exist yet — no owner record, no rows — except
// the birth itself (`<runId>:input`, written by `claimRunOwner`, which holds the run-id gate) and the
// bookkeeping the grammar declares as saying nothing about a run (locks, leases, taint copies).
//
// It replaces a hand-kept list of entry points × refused ids: it does not know the entry points. It
// watches the store every test writes to (`InMemoryJournal`, also under `InMemoryStorage.runs`), so a
// writer added anywhere — in any package — that writes under an unborn id fails the test file that
// exercises it, naming the writer. A write a TEST makes directly (a fixture of rows without a record,
// a legacy journal) is the test's own setup and is not judged: the writer is the first frame outside
// the store, and a frame under `/test/` is a fixture.
import { afterAll, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { RUN_RECORD_FAMILIES, RESERVED_KEY_ROOTS, isBookkeepingRest } from '../packages/durable/src/run-id-grammar.js';

type Fam = { shape: 'leaf' | 'tree' };
const FAMILIES = RUN_RECORD_FAMILIES as unknown as Record<string, Fam>;
/** Roots that are not runs' namespaces: the reserved key families, the engine's `__…`, and the top-level registries. */
const NOT_RUNS = new Set([...RESERVED_KEY_ROOTS, 'wfrun', 'wfwake', 'idem', 'sched', 'batch-plan', 'q', 'job-index']);

/** Every run id `key` can be a record of: a prefix followed by a declared family in its shape. */
function runsOf(key: string): string[] {
  const segs = key.split(':');
  let start = 0;
  if (segs[0] === 'org' && segs.length > 2) start = 2; // an organization's view writes `org:<id>:<key>`
  const root = segs[start] ?? '';
  if (NOT_RUNS.has(root) || root.startsWith('__')) return [];
  const out: string[] = [];
  for (let i = start + 1; i < segs.length; i++) {
    const f = FAMILIES[segs[i]!];
    if (!f) continue;
    if (f.shape === 'leaf' ? i === segs.length - 1 : i < segs.length - 1) out.push(segs.slice(0, i).join(':'));
  }
  return out;
}

const STORE_FRAME = /[\\/]durable[\\/](src|dist)[\\/](journal|in-memory-storage|organization|storage|journal-view|run-identity)\.[jt]s/;
/** The writer: the first frame outside the store and this file. `undefined` for a test's own fixture. */
function writerOf(stack: string | undefined): string | undefined {
  for (const line of (stack ?? '').split('\n').slice(1)) {
    if (!/[\\/][^\\/]+\.[jt]s:\d+/.test(line) || line.includes('birth-witness.setup') || STORE_FRAME.test(line) || line.includes('node:') || line.includes('node_modules')) continue;
    if (/[\\/]test[\\/]/.test(line)) return undefined;
    // The conformance kit (`@gnldev/durable/testing`) writes scripted rows on purpose: it is a fixture too.
    if (/[\\/]durable[\\/](src|dist)[\\/]testing\.[jt]s/.test(line)) return undefined;
    return line.trim();
  }
  return undefined;
}

const violations: string[] = [];
type J = { get(k: string): Promise<unknown>; listKeys?(p: string, o?: { limit?: number }): Promise<string[]> };

/**
 * A run deleted under a live worker carries its fence (erasure-fence.ts): the worker's late writes land
 * and are taken back by the worker itself — the deletion's window, not a birth skipped.
 */
async function fenced(j: J, runId: string): Promise<boolean> {
  const m = /^(org:[^:]+:)(.*)$/.exec(runId);
  const [part, id] = m ? [m[1]!, m[2]!] : ['', runId];
  if (m !== null && (await j.get(`__org_purged__:${part.slice(4, -1)}`)) !== undefined) return true;
  // The run, or a run it was composed from (`task:<parent>:<call>` — its erasure is the parent's).
  const segs = id.split(':');
  for (let a = 0; a < segs.length; a++) {
    for (let b = segs.length; b > a; b--) {
      const candidate = segs.slice(a, b).join(':');
      if ((await j.get(`${part}__run_erased__:${createHash('sha256').update(candidate).digest('hex')}`)) !== undefined) return true;
    }
  }
  return false;
}

async function exists(j: J, runId: string): Promise<boolean> {
  if ((await j.get(`${runId}:input`)) !== undefined) return true;
  if (await fenced(j, runId)) return true;
  if (typeof j.listKeys !== 'function') return true;
  const head = `${runId}:`;
  return (await j.listKeys(head)).some((k) => !isBookkeepingRest(k.slice(head.length)));
}

/** Runs this store was seen to hold, so a run's every later write costs no read (forgotten on a deletion). */
const seen = new WeakMap<object, Set<string>>();
const seenIn = (j: object): Set<string> => { let s = seen.get(j); if (!s) seen.set(j, (s = new Set())); return s; };

async function witness(j: J, key: unknown): Promise<void> {
  if (typeof key !== 'string') return;
  const runs = runsOf(key);
  if (runs.length === 0) return;
  const known = seenIn(j);
  if (runs.some((r) => known.has(r))) return;
  if (runs.some((r) => key === `${r}:input` || isBookkeepingRest(key.slice(r.length + 1)))) {
    if (key.endsWith(':input')) known.add(key.slice(0, -':input'.length));
    return;
  }
  for (const r of runs) if (await exists(j, r)) { known.add(r); return; }
  const by = writerOf(new Error().stack);
  if (by) violations.push(`${key}  ← ${by}  [${expect.getState().currentTestName ?? '?'}]`);
}

function patch(proto: Record<string, any>): void {
  if (proto.__birthWitness) return;
  Object.defineProperty(proto, '__birthWitness', { value: true });
  for (const m of ['put', 'putIfAbsent', 'putIfMatch', 'incrBy']) {
    const orig = proto[m];
    if (typeof orig !== 'function') continue;
    proto[m] = async function (this: J, key: string, ...rest: unknown[]) {
      await witness(this, key);
      return orig.call(this, key, ...rest);
    };
  }
  // A deletion may take a run: what was seen of this store is forgotten.
  const del = proto.deletePrefix;
  if (typeof del === 'function') proto.deletePrefix = function (this: object, ...a: unknown[]) { seen.delete(this); return del.apply(this, a); };
  for (const m of ['delete', 'drop', 'rekey']) {
    const f = proto[m];
    if (typeof f === 'function') proto[m] = function (this: object, ...a: unknown[]) { seen.delete(this); return f.apply(this, a); };
  }
  const batch = proto.applyBatch;
  if (typeof batch === 'function') {
    proto.applyBatch = async function (this: J, b: { claim?: { key: string }; puts?: { key: string }[]; incrs?: { key: string }[] }) {
      for (const k of [b.claim?.key, ...(b.puts ?? []).map((p) => p.key), ...(b.incrs ?? []).map((p) => p.key)]) await witness(this, k);
      return batch.call(this, b);
    };
  }
}

// Which store a test file writes to is decided by its package: @gnldev/durable's own tests reach its
// source, a package that depends on it reaches its build (`@gnldev/durable` → dist), and a package that
// does not depend on it writes to no journal and pays for no import. Loading both module graphs in every
// file of the suite is what made a full run slow enough to time tests out.
const testPath: string = (expect.getState().testPath as string | undefined) ?? '';
const pkg = /[\\/]packages[\\/]([^\\/]+)[\\/]/.exec(testPath)?.[1];
const dependsOnDurable = (): boolean => {
  const manifest = new URL(`../packages/${pkg}/package.json`, import.meta.url);
  if (!pkg || !existsSync(manifest)) return true; // the root suite and the examples: assume it
  const m = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, Record<string, string> | undefined>;
  return ['dependencies', 'devDependencies', 'peerDependencies'].some((d) => m[d]?.['@gnldev/durable'] !== undefined);
};
if (pkg === 'durable') {
  const src = await import('../packages/durable/src/journal.js');
  patch(src.InMemoryJournal.prototype as unknown as Record<string, any>);
} else if (dependsOnDurable()) {
  // Imported by its path (the package a test resolves `@gnldev/durable` to is this file).
  const DIST = new URL('../packages/durable/dist/index.js', import.meta.url);
  if (existsSync(DIST)) patch(((await import(/* @vite-ignore */ DIST.href)) as { InMemoryJournal: { prototype: Record<string, any> } }).InMemoryJournal.prototype);
}

afterAll(() => {
  expect(violations, 'a record was written under a run id that was never born (the birth is claimRunOwner)').toEqual([]);
});

/** For the witness's own test: what it saw so far in this file, forgotten once read. */
export function drainWitness(): string[] {
  return violations.splice(0);
}
