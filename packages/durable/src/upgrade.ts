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
  /**
   * Run only these steps (default: every pending step). A step this store does not have is refused. A
   * store step is one of `UPGRADE_STEPS`; a step a package registered is `<package>/<step>`.
   */
  only?: readonly string[];
  /** Report what is pending and what each step would do; write nothing. */
  dryRun?: boolean;
}

export interface UpgradeStepReport {
  /** A store step (`UPGRADE_STEPS`), or `<package>/<step>` for one a package registered. */
  name: string;
  /** What the step does, in one line — what `gnl upgrade --list` prints. */
  description: string;
  /**
   * Whether the store still needs it, before this call. `undefined` when it was not asked: a step left
   * out of `only` that no chosen step needs.
   */
  pending?: boolean;
  /** Whether this call ran it. */
  ran: boolean;
  /**
   * What it did, or under `dryRun` what it would do. A step that waits for the earlier version's
   * processes to be gone carries `waits`; a debt no registered step answers carries `notRegistered` and
   * the line that registers it (`register`).
   */
  detail?: Record<string, unknown>;
  /** The step waits for the earlier version's processes to be gone (`UpgradeStep.afterOlderGone`). */
  afterOlderGone?: true;
  /** The step threw: its message. The steps after it were not attempted. */
  failed?: { message: string };
  /** An earlier step failed, so this one was not tried. */
  notAttempted?: true;
}

export interface UpgradeReport {
  dryRun: boolean;
  steps: UpgradeStepReport[];
}

/**
 * Thrown by `storage.upgrade()` when it stops: a step threw (the first one to, the rest are not tried),
 * or a package left a debt no registered step answers. The report the call built is not lost with it:
 * `report` says what ran, what failed, what was not attempted. Each step is idempotent, so running
 * `upgrade()` again after the cause is fixed completes the rest.
 */
export class UpgradeFailedError extends Error {
  constructor(message: string, readonly report: UpgradeReport, readonly step: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'UpgradeFailedError';
  }
}

/**
 * One step of a store's upgrade. Each is idempotent: run again, it finds nothing pending and does
 * nothing. A package contributes steps through `registerUpgradeSteps`.
 */
export interface UpgradeStep {
  /** A store step (`UPGRADE_STEPS`). A package step is `'<package>/<step>'`, e.g. `'queue/lanes'`. */
  name: string;
  description: string;
  /** Steps that must be done before this one can run — only ones that come BEFORE it in the order. */
  requires?: readonly string[];
  pending(): Promise<boolean>;
  /**
   * Never pending on its own: it runs only when named in `only`, and `upgrade()` with no `only` leaves
   * it out. For a step an operator asks for after an event the store cannot see (`verify-relations`).
   */
  explicit?: true;
  /**
   * The step cannot run while a process of the earlier version still runs. `upgrade()` with no `only`
   * asks it, reports it as waiting, and does not run it; `only` names the moment the operator says the
   * earlier processes are gone. Unlike `explicit`, a pending one never reads as done.
   */
  afterOlderGone?: true;
  /**
   * What it would do, without writing — for `dryRun`. Required of a package step. By convention the
   * answer may carry `dataVersion` (what the store's data is at) and `packageVersion` (what the package
   * expects): `gnl upgrade --dry-run` prints them as "data vX → package vY".
   */
  plan?(): Promise<Record<string, unknown>>;
  run(): Promise<Record<string, unknown>>;
}

/** Builds the step or steps a package contributes to one store. Called once, at registration. */
export type UpgradeStepFactory = (storage: Storage) => UpgradeStep | readonly UpgradeStep[];

/**
 * The steps that put a store into this version's format; until they have run, reading the store is refused or
 * creates tables. They decide no run. The one list: `gnl upgrade` runs these first, before it reads the store.
 */
export const FORMAT_STEPS: readonly UpgradeStepName[] = ['run-status', 'schema'];

const REGISTRY = Symbol.for('gnl.upgradeSteps');
interface UpgradeRegistry { factories: Set<UpgradeStepFactory>; steps: UpgradeStep[] }
const registryOf = (storage: object): UpgradeRegistry | undefined => (storage as Record<symbol, UpgradeRegistry | undefined>)[REGISTRY];
/** Whether a step name is a package's (`<package>/<step>`) rather than one of the store's own. */
export const isPackageStep = (name: string): boolean => PACKAGE_STEP.test(name);
const PACKAGE_STEP = /^[A-Za-z][A-Za-z0-9-]*\/[A-Za-z][A-Za-z0-9-]*$/;

/**
 * Lets packages add their upgrade steps to a store, so `storage.upgrade()`, `gnl upgrade` and `gnl doctor`
 * — whoever holds this store — see the same list. Called once, where the store is built:
 *
 *   export const storage = registerUpgradeSteps(new PostgresStorage({ connectionString }), [queueUpgrade]);
 *
 * Registration is an explicit call, never a side effect of importing a package. Steps run after the
 * store's own, in registration order. Everything wrong with a step is refused here, before it can fail
 * mid-upgrade, and nothing is registered then: a name that is not `<package>/<step>`, a name already
 * taken, a `requires` that is not a step of the store or one registered before it, a step with no `plan`,
 * a step that is not `afterOlderGone` requiring one that is. The same factory given twice is registered
 * once.
 */
export function registerUpgradeSteps<S extends Storage>(storage: S, factories: readonly UpgradeStepFactory[]): S {
  if (typeof storage.upgrade !== 'function') {
    throw new TypeError(`@gnldev/durable: registerUpgradeSteps: ${storage.name} has no upgrade(), so it has nowhere to run package steps.`);
  }
  const reg = registryOf(storage) ?? { factories: new Set<UpgradeStepFactory>(), steps: [] };
  const known = new Map<string, UpgradeStep | undefined>(UPGRADE_STEPS.map((n) => [n, undefined]));
  for (const s of reg.steps) known.set(s.name, s);
  const added: UpgradeStep[] = [];
  const addedFactories: UpgradeStepFactory[] = [];
  for (const f of factories) {
    if (reg.factories.has(f) || addedFactories.includes(f)) continue;
    addedFactories.push(f);
    const made = f(storage);
    for (const s of Array.isArray(made) ? made : [made as UpgradeStep]) {
      const bad = (why: string): never => { throw new TypeError(`@gnldev/durable: registerUpgradeSteps: step '${s.name}' ${why}. Nothing was registered.`); };
      if (!PACKAGE_STEP.test(s.name)) bad("is not named '<package>/<step>' (letters, digits and '-', one '/')");
      if (known.has(s.name)) bad('is already registered');
      if (typeof s.plan !== 'function') bad('has no plan(): a dry run must be able to say what the step would do without writing');
      for (const r of s.requires ?? []) {
        if (!known.has(r)) bad(`requires '${r}', which is not a step of this store or one registered before it`);
        if (known.get(r)?.afterOlderGone && !s.afterOlderGone) bad(`requires '${r}', which waits for the earlier version's processes to be gone, while this one does not`);
      }
      known.set(s.name, s);
      added.push(s);
    }
  }
  for (const f of addedFactories) reg.factories.add(f);
  reg.steps.push(...added);
  Object.defineProperty(storage, REGISTRY, { value: reg, enumerable: false, configurable: true });
  return storage;
}

/** What a package that finds data in an earlier version's shape leaves, so an upgrade nobody registered is not silent. */
export interface UpgradeDue {
  /** The package that wrote it, e.g. `'@gnldev/queue'`. */
  by: string;
  /** The line that registers the step, e.g. `registerUpgradeSteps(storage, [queueUpgrade])`. Shown verbatim. */
  register: string;
  /** What the data is at, and what the package expects — shown as "data vX → package vY". */
  dataVersion?: string | number;
  packageVersion?: string | number;
}

const DUE_PREFIX = '__upgrade_due__:';
/**
 * Where the notes are kept: the store's run journal, given as the storage or as a journal on it (a
 * scheduler holds only its journal). Always the unscoped root's — `storage.upgrade()` reads them there.
 */
export type UpgradeDueTarget = Pick<Storage, 'runs'> | Pick<Journal, 'putIfAbsent' | 'deletePrefix'>;
const dueJournal = (target: UpgradeDueTarget): Pick<Journal, 'putIfAbsent' | 'deletePrefix'> =>
  'runs' in target ? toJournal(target.runs) : target;

/**
 * A package's note that this store holds data its step has not moved yet. Written the first time the
 * package sees such data; the step clears it (`clearUpgradeDue`) as its last act. While it stands,
 * `storage.upgrade()` on a store where no step of that name is registered reports it and fails with the
 * line to add — the package, not durable, says what to register.
 */
export async function markUpgradeDue(target: UpgradeDueTarget, step: string, due: UpgradeDue): Promise<void> {
  await dueJournal(target).putIfAbsent(`${DUE_PREFIX}${step}`, due);
}

/** Removes the note `markUpgradeDue` left for `step`. */
export async function clearUpgradeDue(target: UpgradeDueTarget, step: string): Promise<void> {
  await dueJournal(target).deletePrefix(`${DUE_PREFIX}${step}`);
}

async function dueNotes(storage: Pick<Storage, 'runs'>): Promise<Array<{ step: string; due: UpgradeDue }>> {
  const j = toJournal(storage.runs);
  const out: Array<{ step: string; due: UpgradeDue }> = [];
  for (const k of await j.listKeys(DUE_PREFIX)) {
    const due = (await j.get(k)) as UpgradeDue | undefined;
    if (due) out.push({ step: k.slice(DUE_PREFIX.length), due });
  }
  return out;
}

/**
 * Runs a store's steps — its own, then those registered on it (`host`): every pending one, or those in
 * `only`, in that order (the adapter's `upgrade` has already refused a misspelled option). Refuses before
 * running anything when `only` names a step this store does not have, or leaves out a step another
 * needs that is still pending — a step is never run behind the caller's back. The refusal names every
 * such step, the prerequisites of prerequisites too, so the command it suggests is one that runs.
 *
 * The first step to throw stops the run: the steps after it are not tried (one may build on it), and the
 * call throws `UpgradeFailedError` carrying the report so far. A step waiting for the earlier version's
 * processes to be gone (`afterOlderGone`) is asked but left unrun unless named. A package's note of data
 * no registered step answers (`markUpgradeDue`) is reported when no `only` was given, and fails a real run
 * once the steps have run.
 *
 * `exists` (an adapter with tables): whether the store has been created at all. One that has not has
 * nothing to upgrade — its first boot creates it as this version's — so every step reads not pending
 * and none is asked: asking would create it (Postgres creates its tables on first use).
 * @internal — what each adapter's `upgrade()` calls.
 */
export async function runUpgrade(
  who: string,
  own: readonly UpgradeStep[],
  opts: UpgradeOptions = {},
  exists?: () => Promise<boolean>,
  host?: Storage,
): Promise<UpgradeReport> {
  const steps = [...own, ...(host ? registryOf(host)?.steps ?? [] : [])];
  const has = new Set(steps.map((s) => s.name));
  for (const name of opts.only ?? []) {
    if (!has.has(name)) {
      const note = host && (!exists || await exists()) ? (await dueNotes(host)).find((d) => d.step === name) : undefined;
      throw new TypeError(
        `${who}.upgrade: '${name}' is not a step of this store. Its steps: ${steps.map((s) => s.name).join(', ') || '(none)'}.` +
          (note ? ` ${note.due.by} left it due; register it where the store is built: ${note.due.register}` : ''),
      );
    }
  }
  if (exists && !(await exists())) {
    return { dryRun: !!opts.dryRun, steps: steps.map((s) => ({ name: s.name, description: s.description, pending: false, ran: false })) };
  }
  const selected = new Set(opts.only ?? steps.filter((s) => !s.explicit && !s.afterOlderGone).map((s) => s.name));
  const needed = new Set<string>(selected);
  for (const s of [...steps].reverse()) if (needed.has(s.name)) for (const r of s.requires ?? []) if (has.has(r)) needed.add(r);
  // A step waiting for the earlier version is asked when nothing was named, so it can say it waits.
  const asked = new Set(needed);
  if (!opts.only) for (const s of steps) if (s.afterOlderGone) asked.add(s.name);
  // Asked in order. A step whose prerequisite is still pending is pending too, and is NOT asked: asking
  // can touch what the prerequisite would create (Postgres creates its tables on first use), which a
  // dry run must not do and which would leave the prerequisite nothing to report.
  const pending = new Map<string, boolean>();
  /** Taken as pending, unasked, because a prerequisite was: asked once that prerequisite is done. */
  const assumed = new Set<string>();
  const blockedBy = (s: UpgradeStep) => (s.requires ?? []).filter((r) => pending.get(r) === true);
  for (const s of steps) {
    // An explicit step not named has nothing to do: reported as not pending rather than as not asked.
    if (s.explicit && !needed.has(s.name)) { pending.set(s.name, false); continue; }
    if (!asked.has(s.name)) continue;
    if (!s.explicit && blockedBy(s).length > 0) assumed.add(s.name);
    pending.set(s.name, s.explicit ? selected.has(s.name) : assumed.has(s.name) ? true : await s.pending());
  }
  // Every pending step a step waits on, through the prerequisites of its prerequisites: `thread-records`
  // waits on `schema`, which waits on `run-status`. Naming only the direct one suggested a command that was
  // refused in turn. Not run on the caller's behalf: `run-status` is the moment every process of the
  // earlier version must be gone, and an operator who asked for `schema` has not chosen that moment.
  const waitsOn = (s: UpgradeStep, out = new Set<string>()): Set<string> => {
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
  const ran = new Set<string>();
  const WAITS = "every process of the earlier version is gone — then `gnl upgrade --only <step>`";
  let failure: { step: string; error: unknown } | undefined;
  for (const s of steps) {
    const isPending = pending.get(s.name);
    const row: UpgradeStepReport = { name: s.name, description: s.description, ...(isPending !== undefined ? { pending: isPending } : {}), ...(s.afterOlderGone ? { afterOlderGone: true as const } : {}), ran: false };
    report.push(row);
    if (failure) { if (isPending) row.notAttempted = true; continue; }
    if (isPending && selected.has(s.name)) {
      const waiting = blockedBy(s);
      if (opts.dryRun) {
        if (waiting.length) row.detail = { after: waiting };
        else if (s.plan) row.detail = await s.plan();
      } else {
        try {
          // Assumed pending behind its prerequisite: asked now that the prerequisite ran — or turned out to
          // have nothing to do, which a chain of steps meets (`schema` behind `run-status`, `thread-records`
          // behind `schema`): a step found done no longer holds back the ones after it.
          const still = waiting.every((w) => ran.has(w)) && (s.explicit || !assumed.has(s.name) || await s.pending());
          if (still) { row.detail = await s.run(); row.ran = true; ran.add(s.name); } else { row.pending = false; pending.set(s.name, false); }
        } catch (error) {
          row.failed = { message: error instanceof Error ? error.message : String(error) };
          failure = { step: s.name, error };
        }
      }
    } else if (isPending && s.afterOlderGone) {
      row.detail = { waits: WAITS, ...(opts.dryRun && s.plan && blockedBy(s).length === 0 ? await s.plan() : {}) };
    }
  }
  const result: UpgradeReport = { dryRun: !!opts.dryRun, steps: report };
  if (failure) {
    const row = report.find((r) => r.name === failure!.step)!;
    throw new UpgradeFailedError(
      `${who}.upgrade: step '${failure.step}' failed: ${row.failed!.message}. ` +
        `${ran.size} step(s) ran before it; the ones after it were not tried. Each step is idempotent: fix the cause and run upgrade() again.`,
      result, failure.step, { cause: failure.error },
    );
  }
  // Debts no registered step answers: a package found older data and left a note, and nothing here runs its step.
  // Read when the caller asked for every pending step — a call naming steps (`only`) is about those, and
  // reading the notes boots the store, which the out-of-band `only: ['schema']` has chosen not to. Not read
  // while the store is still in an earlier version's format either: its adapter refuses the read
  // (`run-status`) or creates what is missing (`schema`), and no package has written a note there.
  const readable = !opts.only && !FORMAT_STEPS.some((n) => pending.get(n) === true && !ran.has(n));
  const unregistered = host && readable ? (await dueNotes(host)).filter((d) => !has.has(d.step)) : [];
  for (const { step, due } of unregistered) {
    report.push({
      name: step, description: `${due.by} found data an earlier version wrote, and no step for it is registered`, pending: true, ran: false,
      detail: { notRegistered: true, register: due.register, by: due.by, ...(due.dataVersion !== undefined ? { dataVersion: due.dataVersion } : {}), ...(due.packageVersion !== undefined ? { packageVersion: due.packageVersion } : {}) },
    });
  }
  if (unregistered.length && !opts.dryRun) {
    throw new UpgradeFailedError(
      `${who}.upgrade: ${unregistered.map((u) => `'${u.step}'`).join(', ')} ${unregistered.length > 1 ? 'are' : 'is'} due, and no step for ${unregistered.length > 1 ? 'them' : 'it'} is registered. ` +
        `Register where the store is built: ${[...new Set(unregistered.map((u) => u.due.register))].join('; ')}`,
      result, unregistered[0]!.step,
    );
  }
  return result;
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
export function threadRecordsStep(storage: Storage, requires?: readonly string[]): UpgradeStep {
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
export function relationsStep(store: RelationPlacer, requires?: readonly string[]): UpgradeStep {
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
export function verifyRelationsStep(store: RelationPlacer, requires?: readonly string[]): UpgradeStep {
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
