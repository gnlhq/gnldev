// ONE EXECUTOR PER PROCESS PER STORE — the detached runs of every registry built on one store share it.
//
// A server builds a registry per organization (each over its own view of the same store). Each kept its
// own executor and its own sweep, so a process with a thousand organizations swept the store a thousand
// times a second, and each sweep read every organization's execution records. The execution records,
// the process's liveness and its drain are the process's, not an organization's: so is the executor.
//
// A registry REGISTERS its scope here — the journal its runs live in, and how to continue one of them —
// and gets the shared executor back. The ROOT registry also says how to continue a run of ANY
// organization (`anyScope`: the registry an organization gets from the root's config, as every door
// builds it): the sweep is the process's, so it continues every organization's runs, not only those of
// the organizations a request happened to reach here. A scope nothing here can continue (no root
// registry, or a config that cannot be scoped) is somebody else's to continue (`pending()` lists it).
import { DetachedRuns, type DetachedRunsOptions, type ExecRecord, type Launch } from './detached.js';
import type { Journal } from './journal.js';
import { orgParentOf, orgScopeOf } from './organization.js';
import { storeLiveness, type ProcessLiveness } from './process-liveness.js';
import { JOURNAL_SOURCE } from './storage.js';

export interface ScopeEntry { journal: Journal; resume: (rec: ExecRecord) => Launch | Promise<Launch> }
interface Shared { scopes: Map<string, ScopeEntry>; runs: Promise<DetachedRuns>; anyScope?: (scope: string) => ScopeEntry | undefined }

const shared = new WeakMap<object, Shared>();
/** Every executor this process made, for the process-wide drain. */
const all = new Set<Promise<DetachedRuns>>();

/**
 * GRACEFUL DRAIN of this process (SIGTERM): every executor stops accepting runs (a door answers 503),
 * the running tools finish, no new step starts, the runs are released and another process continues
 * them. Resolves when none is left here.
 */
export async function drainExecutors(): Promise<void> {
  await Promise.all([...all].map(async (p) => (await p.catch(() => undefined))?.drain()));
}

/** The store a journal (or an organization's view of it) belongs to: one key per store, whatever wraps it. */
function storeKey(journal: Journal): { root: Journal; key: object } {
  const root = (orgParentOf(journal) ?? journal) as Journal;
  const key = ((root as unknown as Record<symbol, unknown>)[JOURNAL_SOURCE] as object | undefined) ?? root;
  return { root, key };
}

export interface ExecutorRegistration {
  /** How a run of this scope is continued by this process (a takeover, an approval): its launch. */
  resume: (rec: ExecRecord) => Launch | Promise<Launch>;
  /** The store's liveness, when the first registration settles it (`storeLiveness`): configured, or the store's own. */
  liveness?: { given?: ProcessLiveness; own?: () => ProcessLiveness | undefined | Promise<ProcessLiveness | undefined> };
  /** The root registry's way to continue a run of any organization (see the head of this file). */
  anyScope?: (scope: string) => ScopeEntry | undefined;
  /** Tuning, taken from the first registration on a store. */
  options?: Pick<DetachedRunsOptions, 'sweepMs' | 'pollMs' | 'coalesceMs' | 'outcomeAskMs' | 'signal' | 'onComplete'>;
}

/**
 * The store is closing: its executor here stops (no sweep, its local runs aborted — another process, or
 * this one after a reopen, continues them from the journal). Called by the storages' `close()`.
 */
export async function closeExecutorFor(journal: Journal): Promise<void> {
  const { key } = storeKey(journal);
  const s = shared.get(key);
  if (!s) return;
  shared.delete(key);
  all.delete(s.runs);
  const runs = await s.runs.catch(() => undefined);
  await runs?.close();
}

/** Registers `journal`'s scope with its store's executor in this process, and returns that executor. */
export function executorFor(journal: Journal, reg: ExecutorRegistration): Promise<DetachedRuns> {
  const { root, key } = storeKey(journal);
  const scope = orgScopeOf(journal) ?? '';
  let s = shared.get(key);
  if (!s) {
    const scopes = new Map<string, ScopeEntry>();
    // A scope registered here, else one the root registry can make (kept, as a registration of its own).
    const find = (sc: string | undefined): ScopeEntry | undefined => {
      const e = scopes.get(sc ?? '');
      if (e || sc === undefined || !s?.anyScope) return e;
      let made: ScopeEntry | undefined;
      try { made = s.anyScope(sc); } catch { made = undefined; }
      if (made) scopes.set(sc, made);
      return made;
    };
    const entry = (sc: string | undefined): ScopeEntry => {
      const e = find(sc);
      if (!e) throw new Error(`@gnldev/durable: no registry for scope '${sc ?? ''}' in this process`);
      return e;
    };
    const runs = (async () => {
      // The store's liveness in this process (one per store, process-liveness.ts).
      const liveness = await storeLiveness(root, reg.liveness);
      return new DetachedRuns({
        journal: root,
        journalFor: (sc) => entry(sc).journal,
        resume: (rec) => entry(rec.scope).resume(rec),
        handles: (sc) => find(sc) !== undefined,
        ...(liveness ? { liveness } : {}),
        ...(reg.options ?? {}),
      });
    })();
    s = { scopes, runs };
    shared.set(key, s);
    all.add(runs);
    // A failed construction (no liveness on a shared store) is not cached: the next call says it again.
    runs.catch(() => { if (shared.get(key) === s) shared.delete(key); all.delete(runs); });
  }
  s.scopes.set(scope, { journal, resume: reg.resume });
  if (reg.anyScope && scope === '') s.anyScope = reg.anyScope;
  return s.runs;
}
