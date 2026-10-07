// One way to bring a store written by an earlier version up to this one: `storage.upgrade()`.
//
// Before this, each upgrade had its own name on its own adapter — `migrateSchema()` on Sqlite and
// Postgres, `rebuildKeyIndex()` on Redis, `upgradeThreadRecords(journal)` everywhere — and the
// developer had to know all three, and which applied. Now a store lists the steps it has, says which
// are pending, and runs them — all of them, or the ones named in `only`.

import type { Storage } from './storage.js';
import type { Journal } from './journal.js';
import { toJournal, threadRecordOwner } from './storage.js';
import { withOrg, withRootScope, ORG_RECORD_PRE } from './organization.js';
import { withOrgStorage } from './org-storage.js';
import { threadRecordsComplete, writeThreadRecords } from './thread-owner.js';
import { subjectIndexComplete, writeSubjectIndex } from './subject-index.js';
import type { Memory } from './memory.js';
import type { MemoryStore } from './storage.js';

/** Every upgrade step a first-party store can have, in the order `upgrade()` runs them. */
export const UPGRADE_STEPS = ['schema', 'key-index', 'thread-records', 'subject-index'] as const;
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
  /** What it would do, without writing — for `dryRun`. */
  plan?(): Promise<Record<string, unknown>>;
  run(): Promise<Record<string, unknown>>;
}

/**
 * Runs a store's steps: every pending one, or those in `only`, in the store's order (the adapter's
 * `upgrade` has already refused a misspelled option). Refuses before
 * running anything when `only` names a step this store does not have, or leaves out a step another
 * needs that is still pending — a step is never run behind the caller's back.
 * @internal — what each adapter's `upgrade()` calls.
 */
export async function runUpgrade(who: string, steps: readonly UpgradeStep[], opts: UpgradeOptions = {}): Promise<UpgradeReport> {
  const has = new Set(steps.map((s) => s.name));
  for (const name of opts.only ?? []) {
    if (!has.has(name)) {
      throw new TypeError(
        `${who}.upgrade: '${name}' is not a step of this store. Its steps: ${steps.map((s) => s.name).join(', ') || '(none)'}.`,
      );
    }
  }
  const selected = new Set(opts.only ?? steps.map((s) => s.name));
  const needed = new Set<UpgradeStepName>(selected);
  for (const s of [...steps].reverse()) if (needed.has(s.name)) for (const r of s.requires ?? []) if (has.has(r)) needed.add(r);
  // Asked in order. A step whose prerequisite is still pending is pending too, and is NOT asked: asking
  // can touch what the prerequisite would create (Postgres creates its tables on first use), which a
  // dry run must not do and which would leave the prerequisite nothing to report.
  const pending = new Map<UpgradeStepName, boolean>();
  const blockedBy = (s: UpgradeStep) => (s.requires ?? []).filter((r) => pending.get(r) === true);
  for (const s of steps) {
    if (!needed.has(s.name)) continue;
    pending.set(s.name, blockedBy(s).length > 0 ? true : await s.pending());
  }
  for (const s of steps) {
    if (!selected.has(s.name) || !pending.get(s.name)) continue;
    const missing = blockedBy(s).filter((r) => !selected.has(r));
    if (missing.length) {
      throw new Error(
        `${who}.upgrade: '${s.name}' needs ${missing.map((m) => `'${m}'`).join(' and ')} first, which is still pending. ` +
          `Run them together — upgrade({ only: [${[...missing, s.name].map((m) => `'${m}'`).join(', ')}] }) — or run upgrade() for every pending step.`,
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
        // Assumed pending behind its prerequisite: asked now that the prerequisite ran.
        const still = waiting.length === 0 || (waiting.every((w) => ran.has(w)) && (await s.pending()));
        if (still) { row.detail = await s.run(); row.ran = true; ran.add(s.name); } else row.pending = false;
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
  const orgs: string[] = [];
  if (typeof j.listKeys === 'function') {
    for (const key of await j.listKeys(ORG_RECORD_PRE)) {
      if ((await j.get(key)) != null) orgs.push(key.slice(ORG_RECORD_PRE.length));
    }
  }
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
 * The `subject-index` step every store with runs has: indexes each person's runs and owned threads, in
 * the root scope and every registered organization, then marks each scope complete — from then on an
 * erasure lists one person's prefix instead of walking the store (subject-index.ts). Until a scope is
 * complete erasure keeps the walk, so it never waits for this step.
 * @internal
 */
export function subjectIndexStep(storage: Storage, requires?: readonly UpgradeStepName[]): UpgradeStep {
  const scopes = () => upgradeScopes(storage);
  return {
    name: 'subject-index',
    description: "indexes each person's runs and threads, so erasing a person stops reading the whole store",
    ...(requires ? { requires } : {}),
    async pending() {
      for (const s of await scopes()) if (!(await subjectIndexComplete(s.journal))) return true;
      return false;
    },
    async plan() {
      const left: string[] = [];
      for (const s of await scopes()) if (!(await subjectIndexComplete(s.journal))) left.push(s.name);
      return { scopes: left, reads: 'every run and every thread owner record of each scope once, a page at a time' };
    },
    async run() {
      const done: Record<string, { runs: number; threads: number }> = {};
      for (const s of await scopes()) {
        if (await subjectIndexComplete(s.journal)) continue;
        done[s.name] = await writeSubjectIndex(s.journal);
      }
      return { scopes: done };
    },
  };
}
