// One way to bring a store written by an earlier version up to this one: `storage.upgrade()`.
//
// Before this, each upgrade had its own name on its own adapter — `migrateSchema()` on Sqlite and
// Postgres, `upgradeThreadRecords(journal)` everywhere — and the developer had to know each, and
// which applied. Now a store lists the steps it has, says which
// are pending, and runs them — all of them, or the ones named in `only`.

import type { Storage } from './storage.js';
import type { Journal } from './journal.js';
import { toJournal, threadRecordOwner } from './storage.js';
import { withOrg, withRootScope, registeredOrganizations } from './organization.js';
import { withOrgStorage } from './org-storage.js';
import { threadRecordsComplete, writeThreadRecords } from './thread-owner.js';
import type { Memory } from './memory.js';
import type { MemoryStore } from './storage.js';

/** Every upgrade step a first-party store can have, in the order `upgrade()` runs them. */
export const UPGRADE_STEPS = ['run-status', 'schema', 'thread-records', 'relations', 'verify-relations'] as const;
export type UpgradeStepName = (typeof UPGRADE_STEPS)[number];

export interface UpgradeOptions {
  /** Run only these steps (default: every pending step). A step this store does not have is refused. */
  only?: readonly UpgradeStepName[];
  /** Report what is pending and what each step would do; write nothing. */
  dryRun?: boolean;
}

export interface UpgradeStepReport {
  name: UpgradeStepName;
  /** What the step does, in one line — what `gnl upgrade --list` prints. */
  description: string;
  /**
   * Whether the store still needs it, before this call. `undefined` when it was not asked: a step left
   * out of `only` that no chosen step needs.
   */
  pending?: boolean;
  /** Whether this call ran it. */
  ran: boolean;
  /** What it did, or under `dryRun` what it would do. */
  detail?: Record<string, unknown>;
}

export interface UpgradeReport {
  dryRun: boolean;
  steps: UpgradeStepReport[];
}

/**
 * One step of a store's upgrade. Each is idempotent: run again, it finds nothing pending and does
 * nothing.
 * @internal — the adapters build these; a host calls `storage.upgrade()`.
 */
export interface UpgradeStep {
  name: UpgradeStepName;
  description: string;
  /** Steps that must be done before this one can run. */
  requires?: readonly UpgradeStepName[];
  pending(): Promise<boolean>;
  /**
   * Never pending on its own: it runs only when named in `only`, and `upgrade()` with no `only` leaves
   * it out. For a step an operator asks for after an event the store cannot see (`verify-relations`).
   */
  explicit?: true;
  /** What it would do, without writing — for `dryRun`. */
  plan?(): Promise<Record<string, unknown>>;
  run(): Promise<Record<string, unknown>>;
}

/**
 * Runs a store's steps: every pending one, or those in `only`, in the store's order (the adapter's
 * `upgrade` has already refused a misspelled option). Refuses before
 * running anything when `only` names a step this store does not have, or leaves out a step another
 * needs that is still pending — a step is never run behind the caller's back. The refusal names every
 * such step, the prerequisites of prerequisites too, so the command it suggests is one that runs.
 *
 * `exists` (an adapter with tables): whether the store has been created at all. One that has not has
 * nothing to upgrade — its first boot creates it as this version's — so every step reads not pending
 * and none is asked: asking would create it (Postgres creates its tables on first use).
 * @internal — what each adapter's `upgrade()` calls.
 */
export async function runUpgrade(
  who: string,
  steps: readonly UpgradeStep[],
  opts: UpgradeOptions = {},
  exists?: () => Promise<boolean>,
): Promise<UpgradeReport> {
  const has = new Set(steps.map((s) => s.name));
  for (const name of opts.only ?? []) {
    if (!has.has(name)) {
      throw new TypeError(
        `${who}.upgrade: '${name}' is not a step of this store. Its steps: ${steps.map((s) => s.name).join(', ') || '(none)'}.`,
      );
    }
  }
  if (exists && !(await exists())) {
    return { dryRun: !!opts.dryRun, steps: steps.map((s) => ({ name: s.name, description: s.description, pending: false, ran: false })) };
  }
  const selected = new Set(opts.only ?? steps.filter((s) => !s.explicit).map((s) => s.name));
  const needed = new Set<UpgradeStepName>(selected);
  for (const s of [...steps].reverse()) if (needed.has(s.name)) for (const r of s.requires ?? []) if (has.has(r)) needed.add(r);
  // Asked in order. A step whose prerequisite is still pending is pending too, and is NOT asked: asking
  // can touch what the prerequisite would create (Postgres creates its tables on first use), which a
  // dry run must not do and which would leave the prerequisite nothing to report.
  const pending = new Map<UpgradeStepName, boolean>();
  /** Taken as pending, unasked, because a prerequisite was: asked once that prerequisite is done. */
  const assumed = new Set<UpgradeStepName>();
  const blockedBy = (s: UpgradeStep) => (s.requires ?? []).filter((r) => pending.get(r) === true);
  for (const s of steps) {
    // An explicit step not named has nothing to do: reported as not pending rather than as not asked.
    if (s.explicit && !needed.has(s.name)) { pending.set(s.name, false); continue; }
    if (!needed.has(s.name)) continue;
    if (!s.explicit && blockedBy(s).length > 0) assumed.add(s.name);
    pending.set(s.name, s.explicit ? selected.has(s.name) : assumed.has(s.name) ? true : await s.pending());
  }
  // Every pending step a step waits on, through the prerequisites of its prerequisites: `thread-records`
  // waits on `schema`, which waits on `run-status`. Naming only the direct one suggested a command that was
  // refused in turn. Not run on the caller's behalf: `run-status` is the moment every process of the
  // earlier version must be gone, and an operator who asked for `schema` has not chosen that moment.
  const waitsOn = (s: UpgradeStep, out = new Set<UpgradeStepName>()): Set<UpgradeStepName> => {
    for (const r of blockedBy(s)) if (!out.has(r)) { out.add(r); waitsOn(steps.find((x) => x.name === r)!, out); }
    return out;
  };
  for (const s of steps) {
    if (!selected.has(s.name) || !pending.get(s.name)) continue;
    const all = waitsOn(s);
    const missing = steps.map((x) => x.name).filter((n) => all.has(n) && !selected.has(n));
    if (missing.length) {
      const together = steps.map((x) => x.name).filter((n) => missing.includes(n) || selected.has(n));
      throw new Error(
        `${who}.upgrade: '${s.name}' needs ${missing.map((m) => `'${m}'`).join(' and ')} first, which ${missing.length > 1 ? 'are' : 'is'} still pending. ` +
          `Run them together — upgrade({ only: [${together.map((m) => `'${m}'`).join(', ')}] }), \`gnl upgrade --only ${together.join(',')}\` — or run upgrade() for every pending step.`,
      );
    }
  }
  const report: UpgradeStepReport[] = [];
  const ran = new Set<UpgradeStepName>();
  for (const s of steps) {
    const isPending = pending.get(s.name);
    const row: UpgradeStepReport = { name: s.name, description: s.description, ...(isPending !== undefined ? { pending: isPending } : {}), ran: false };
    if (isPending && selected.has(s.name)) {
      const waiting = blockedBy(s);
      if (opts.dryRun) {
        if (waiting.length) row.detail = { after: waiting };
        else if (s.plan) row.detail = await s.plan();
      } else {
        // Assumed pending behind its prerequisite: asked now that the prerequisite ran — or turned out to
        // have nothing to do, which a chain of steps meets (`schema` behind `run-status`, `thread-records`
        // behind `schema`): a step found done no longer holds back the ones after it.
        const still = waiting.every((w) => ran.has(w)) && (s.explicit || !assumed.has(s.name) || await s.pending());
        if (still) { row.detail = await s.run(); row.ran = true; ran.add(s.name); } else { row.pending = false; pending.set(s.name, false); }
      }
    }
    report.push(row);
  }
  return { dryRun: !!opts.dryRun, steps: report };
}

/** Asks a memory store who owns a thread — the shape `threadOwnerOf` reads. */
const ownerAsker = (store: MemoryStore): Memory =>
  ({ getThreadResource: async (id: string) => threadRecordOwner(await store.getThread(id)) }) as unknown as Memory;

/** The scopes a step goes through: the root, and every registered organization. */
async function upgradeScopes(storage: Storage): Promise<Array<{ name: string; journal: Journal; memory?: Memory }>> {
  const j = toJournal(storage.runs);
  const out: Array<{ name: string; journal: Journal; memory?: Memory }> = [];
  const orgs = await registeredOrganizations(j);
  out.push({ name: '(root)', journal: orgs.length ? withRootScope(j) : j, ...(storage.memory ? { memory: ownerAsker(storage.memory) } : {}) });
  for (const org of orgs) {
    const view = withOrgStorage(storage, org);
    out.push({ name: org, journal: withOrg(j, org), ...(view.memory ? { memory: ownerAsker(view.memory) } : {}) });
  }
  return out;
}

/**
 * The `thread-records` step every store with runs has: gives each thread from an earlier version its
 * owner record or `seen` mark, in the root scope and in every registered organization, then marks each
 * scope complete (ADR-0006). Until a scope is complete its gate still reads runs for a thread it has
 * no record or mark for, so correctness never waits for this step.
 * @internal
 */
export function threadRecordsStep(storage: Storage, requires?: readonly UpgradeStepName[]): UpgradeStep {
  const scopes = () => upgradeScopes(storage);
  return {
    name: 'thread-records',
    description: "writes the mark older threads lack, so a new thread's first run stops reading the store's runs",
    ...(requires ? { requires } : {}),
    async pending() {
      for (const s of await scopes()) if (!(await threadRecordsComplete(s.journal))) return true;
      return false;
    },
    async plan() {
      const left: string[] = [];
      for (const s of await scopes()) if (!(await threadRecordsComplete(s.journal))) left.push(s.name);
      return { scopes: left, reads: 'every run of each scope once, one page at a time' };
    },
    async run() {
      const done: Record<string, { threads: number; recorded: number; marked: number }> = {};
      for (const s of await scopes()) {
        if (await threadRecordsComplete(s.journal)) continue;
        done[s.name] = await writeThreadRecords(s.journal, s.memory);
      }
      return { scopes: done };
    },
  };
}

/**
 * What a store that keeps a run's person and thread in columns hands its `relations` step (Sqlite,
 * Postgres): whether any row written before the columns can be placed now, and the pass that places them.
 * @internal
 */
export interface RelationPlacer {
  relationsPending(): Promise<boolean>;
  placeRelations(): Promise<{ runs: number; owners: number }>;
  /** Marks every placement for verification (RELATIONS_VERIFY_KEY): no column is trusted until `placeRelations` has placed every row again. */
  requestRelationsVerify(): Promise<void>;
}

/**
 * What a Sqlite or Postgres process prints once at boot while runs written before the relation columns
 * are still unplaced: every lookup by person or thread reads all of them, so those queries are slow
 * until the `relations` step has run — the answers stay complete, only the speed waits. Measured, 1 000
 * 000 unplaced runs on Postgres: erasing a person 31 s (5 s placed), a person's run list 30 s (1 ms).
 * During a rolling deploy the older processes keep writing unplaced runs, so run the step once they
 * are gone; a process that boots before then says this again.
 */
export const RELATIONS_PENDING_ADVICE =
  '@gnldev/durable: this store has runs written before the person/thread columns (an older version), ' +
  'not placed in them yet. Answers stay complete, but every lookup by person or thread reads all of ' +
  'those runs until they are placed: erasing a person, a person\'s run list ("my runs"), deleting a ' +
  "thread with its runs — slow queries (1 000 000 runs on Postgres: ~30 s instead of milliseconds). " +
  "Place them once no older process writes here: `gnl upgrade --only relations` " +
  "(or `await storage.upgrade({ only: ['relations'] })`).";

/**
 * The `relations` step of a store with relation columns: fills `gnl_runs.resource_id`/`thread_id` and
 * `gnl_run_journal.owner` for the rows written before them (an earlier version, or a process of one
 * still running), from their own records, one page at a time. For SPEED only: every lookup by person
 * or thread already reads the rows not placed yet and decides them from the record, so an erasure or a
 * run list is complete before this step, during it, and if it never runs. Rows go store-wide, every
 * organization's with the root's: a column is a property of the row, not of a scope.
 * @internal
 */
export function relationsStep(store: RelationPlacer, requires?: readonly UpgradeStepName[]): UpgradeStep {
  return {
    name: 'relations',
    description: "places each older run's person and thread, and each older thread owner record, in their columns, so lookups by person or thread read an index",
    ...(requires ? { requires } : {}),
    pending: () => store.relationsPending(),
    async plan() {
      return { reads: "every run with no person placed yet (with its `:input`) and every owner record with none, a page at a time" };
    },
    run: () => store.placeRelations(),
  };
}

/**
 * The `verify-relations` step: every placement cleared and placed again from its record. For after a
 * write the triggers never saw — `pg_restore --disable-triggers`, a logical-replication apply worker
 * (`session_replication_role = replica`), triggers disabled or dropped and re-created by hand between two
 * boots. The store cannot tell such a write from any other afterwards, so it is never pending on its
 * own: an operator names it (`gnl upgrade --only verify-relations`). Until it finishes no relation column
 * is trusted, so answers stay exact while it runs; it takes as long as the `relations` step on a store
 * whose rows were never placed (1 000 000 runs on Postgres: ~6 min).
 * @internal
 */
export function verifyRelationsStep(store: RelationPlacer, requires?: readonly UpgradeStepName[]): UpgradeStep {
  return {
    name: 'verify-relations',
    description: 'clears every person/thread placement and places it again from its record — after a restore or replication that bypassed the triggers',
    explicit: true,
    ...(requires ? { requires } : {}),
    pending: async () => false,
    async plan() {
      return { reads: 'every run and owner record: clears their placements, then places each again from its record' };
    },
    async run() {
      await store.requestRelationsVerify();
      return store.placeRelations();
    },
  };
}

/**
 * The four status flags `gnl_runs` had up to 0.10 (and on the C+ step-B code): `suspended`, `failed`,
 * `running`, `canceled`. Replaced by `status` and `outcome`, which this version's adapter writes in the
 * same statement as the run's counter (`runStatusOf`) — see the `run-status` step.
 * @internal — the Sqlite and Postgres adapters.
 */
export const RUN_STATUS_FLAGS = ['suspended', 'failed', 'running', 'canceled'] as const;

/**
 * Whether a `gnl_runs` with these columns still needs the `run-status` step: it has any of the flags,
 * or lacks `status`/`outcome`. No table at all needs nothing: the schema creates it as this version's.
 * @internal — the Sqlite and Postgres adapters.
 */
export function runStatusPending(columns: ReadonlySet<string>): boolean {
  if (columns.size === 0) return false;
  return RUN_STATUS_FLAGS.some((f) => columns.has(f)) || !columns.has('status') || !columns.has('outcome');
}

/**
 * Why a store whose `run-status` step is pending refuses to run, and the one way through. Refused
 * rather than migrated on open: the step drops the columns every process of the earlier version writes
 * on each journal write, so it is the moment those processes must be gone — an open that migrated by
 * itself would make the first new process that boots during a rolling deploy break every old one. And
 * not served from the flags either: a version that reads the flags and writes `status` would read
 * runs the old processes keep writing with a status column they never update.
 */
export const RUN_STATUS_PENDING_MESSAGE =
  '@gnldev/durable: this store\'s run table (gnl_runs) is in the format of an earlier version (0.10 or before): ' +
  'run status is kept in four flag columns this version no longer reads or writes. Nothing was read or written. ' +
  'Stop every process of the earlier version, run `gnl upgrade --only run-status,schema` ' +
  "(or `await storage.upgrade({ only: ['run-status', 'schema'] })`), start this version, then run `gnl upgrade` " +
  'for the remaining steps while it serves. The stop lasts as long as `run-status`, which grows with the runs ' +
  'a flag marks (suspended, failed, running or canceled) — on Postgres, 1 000 000 runs: 0.6 s with 167 of them ' +
  'flagged, 20 s with 500 167. `gnl upgrade --list` shows what each step will do.';

/**
 * What a store with a `gnl_runs` table hands its `run-status` step (Sqlite, Postgres): whether the flags
 * are still there, what migrating them would run, and the migration itself.
 * @internal
 */
export interface RunStatusMigrator {
  runStatusPending(): Promise<boolean>;
  runStatusPlan(): Promise<string[]>;
  migrateRunStatus(): Promise<Record<string, unknown>>;
}

/**
 * The `run-status` step (breaking, 0.11): fills `gnl_runs.status` and `gnl_runs.outcome` from the four
 * flags an earlier version wrote, rebuilds the open-runs index on `status`, and drops the flags. Until it
 * has run this version refuses the store (RUN_STATUS_PENDING_MESSAGE); once it has, a process of the
 * earlier version fails on its first journal write with Postgres's or Sqlite's own "column does not
 * exist" error — loudly, nothing written — instead of writing flags nobody reads. First of the steps:
 * every other one reads runs through the adapter, which refuses the store until this has run.
 * @internal
 */
export function runStatusStep(store: RunStatusMigrator): UpgradeStep {
  return {
    name: 'run-status',
    description: "replaces gnl_runs' four status flags (0.10 and before) with the status and outcome columns this version writes — stop every older process first",
    pending: () => store.runStatusPending(),
    async plan() {
      return { statements: await store.runStatusPlan() };
    },
    run: () => store.migrateRunStatus(),
  };
}
