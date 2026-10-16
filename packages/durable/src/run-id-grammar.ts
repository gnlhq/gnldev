/**
 * THE RUN-ID GRAMMAR — the one place that says what a run id may be and what is written under one.
 *
 * A run id is not only a name. It is the PREFIX of every record the run owns (`<runId>:<family>…`), and
 * the engine composes new run ids from it (`task:<runId>:<call>`, `agent:<runId>:<call>`, …). Two runs
 * whose spellings overlap therefore share key space, and every rule about that overlap used to be written
 * where it was needed: a regex in the entry gate (`:model`, `:tool`, `:ev`), a `startsWith('task:')` on
 * the agent door only, a hand-typed `'<id>:ev-delivered'` prefix in the executor's cleanup, a family list
 * in the bookkeeping probe, another in the parser. Each new family or door had to be remembered in each
 * place, and the audits kept finding the place that was not (A1/A2, B1, R2-1, R2-2).
 *
 * Here they are declared once, and everything else is DERIVED:
 *  - `RUN_RECORD_FAMILIES` — every family written under a run id, with its shape (one key, or a tree of
 *    keys) and whether anything reads or deletes it as a PREFIX (`listed`);
 *  - `runRecordKey` / `runRecordPrefix` — the only spellings of those keys; a prefix exists only for a
 *    listed tree family (the type refuses the others), so a prefix operation is never ad hoc;
 *  - `assertRunIdSafe` — refuses an id whose keys would fall inside another run's listed family, which is
 *    exactly what makes those prefixes exact;
 *  - `RUN_ID_FAMILIES` — every family of id the engine composes, and which of them only the engine may
 *    BEGIN (`admitRunId`, the one admission gate, asked at the run's birth — `claimRunOwner`);
 *  - the parse side (`RECORD_KEY_RE`, `isBookkeepingRest`, the versioned-key rule) reads the same table.
 *
 * A leaf family (one key, `<runId>:outcome`) is safe without any refusal: it is read and deleted by its
 * exact key (`deleteExactKey`), so a neighbour called `<runId>:outcome-2` is never reached. A listed tree
 * family (`<runId>:tool:<id>`) is safe only because the gate refuses an id with that segment — so the two
 * halves stay in step by construction: `runRecordPrefix` accepts exactly the families the gate protects.
 */
import { RunOwnerMismatchError } from './errors.js';
import { refuseUnknownNames } from '@gnldev/options';
import { ADMIT_RUN_ID_NAMES } from './option-names.js';

/** How a family's keys hang off a run id. */
type FamilyShape =
  /** One key: `<runId>:<family>`. Read, written and deleted by that exact key. */
  | 'leaf'
  /** Many keys: `<runId>:<family>:<rest>`. */
  | 'tree';

interface RecordFamily {
  readonly shape: FamilyShape;
  /**
   * Something reads or deletes `<runId>:<family>:` as a PREFIX (a listing, a range, a cleanup). The gate
   * refuses a run id with this segment, so that prefix holds this run's records only. Only a listed family
   * has a `runRecordPrefix`.
   */
  readonly listed?: true;
  /** The journal replays it (`parseJournalKey`): a record of the run's timeline. */
  readonly replayed?: true;
  /** Carries the `_v` format stamp (format.ts `isVersionedKey`). */
  readonly versioned?: true;
  /**
   * Says nothing about the run having STARTED (run-identity.ts `rowsPresent`): `true` for the whole
   * family, or the sub-key prefixes that are bookkeeping.
   */
  readonly bookkeeping?: true | readonly string[];
  /** Who writes it, for a reader of this table (and the guard test that every literal is declared). */
  readonly writer: string;
}

/**
 * EVERY family written under a run id. Adding a record under `<runId>:` means adding a row here; the
 * guard tests (run-id-grammar.test.ts) fail on a `runKeys` builder or a `${runId}:<family>` literal in
 * any package's source whose family is not declared.
 */
export const RUN_RECORD_FAMILIES = {
  input: { shape: 'leaf', versioned: true, writer: 'journal.ts runKeys.input — the frozen input; registers the run' },
  model: { shape: 'tree', listed: true, replayed: true, versioned: true, writer: 'journal.ts runKeys.model — a model step' },
  tool: { shape: 'tree', listed: true, replayed: true, versioned: true, writer: 'journal.ts runKeys.tool/toolByArgs — a tool call' },
  'task-spec': { shape: 'tree', writer: 'journal.ts runKeys.taskSpec — a background call\'s spec' },
  proc: { shape: 'tree', listed: true, bookkeeping: ['__gnl_taint'], writer: 'journal.ts runKeys.proc — processor steps, claims, evals, taint' },
  procreport: { shape: 'tree', listed: true, writer: 'processor.ts — processor reports' },
  memctx: { shape: 'leaf', writer: 'journal.ts runKeys.memoryContext' },
  cfg: { shape: 'tree', bookkeeping: true, writer: 'journal.ts runKeys.cfgModel/cfgLimits, suggestions.ts lessons' },
  approval: { shape: 'tree', listed: true, writer: 'journal.ts runKeys.approval — a human decision' },
  outcome: { shape: 'leaf', writer: 'journal.ts runKeys.outcome — how the run ended' },
  output: { shape: 'leaf', writer: 'journal.ts runKeys.output — what the caller got' },
  ev: { shape: 'tree', listed: true, writer: 'run-events.ts — the run\'s event log' },
  'ev-delivered': { shape: 'leaf', writer: 'detached.ts — the completion notice was delivered' },
  rollover: { shape: 'leaf', writer: 'rollover.ts — the period handoff' },
  'usage-counted': { shape: 'leaf', writer: 'budget.ts — the run\'s usage was counted' },
  swept: { shape: 'leaf', bookkeeping: true, writer: 'retention.ts — the retention tombstone' },
  lock: { shape: 'leaf', bookkeeping: true, writer: 'run-lock.ts — the run lock' },
  net: { shape: 'tree', listed: true, writer: 'network.ts netKeys — a network\'s routes and steps' },
  incident: { shape: 'tree', listed: true, writer: 'incidents.ts — guard and limit incidents' },
  comp: { shape: 'tree', writer: 'compensation.ts — compensation records' },
  sugg: { shape: 'tree', writer: 'suggestions.ts — the suggestion memo' },
  wf: { shape: 'tree', listed: true, writer: '@gnldev/workflow (spells it itself: no dependency on this package) — workflow steps' },
  lease: { shape: 'tree', bookkeeping: true, writer: '@gnldev/queue — a worker\'s lease (`lease:lock`)' },
  fire: { shape: 'tree', bookkeeping: true, writer: '@gnldev/scheduler — a schedule fire (`fire:lock`)' },
} as const satisfies Record<string, RecordFamily>;

export type RunRecordFamily = keyof typeof RUN_RECORD_FAMILIES;
type FamiliesWhere<P> = { [K in RunRecordFamily]: (typeof RUN_RECORD_FAMILIES)[K] extends P ? K : never }[RunRecordFamily];
/** The families that have a prefix: listed trees — exactly the ones the gate keeps exact. */
export type ListedRunRecordFamily = FamiliesWhere<{ listed: true }>;
export type LeafRunRecordFamily = FamiliesWhere<{ shape: 'leaf' }>;
export type TreeRunRecordFamily = FamiliesWhere<{ shape: 'tree' }>;

const familyNames = Object.keys(RUN_RECORD_FAMILIES) as RunRecordFamily[];
const where = (p: (f: RecordFamily) => boolean): RunRecordFamily[] => familyNames.filter((n) => p(RUN_RECORD_FAMILIES[n] as RecordFamily));

/** The listed families (the gate refuses these segments). */
export const LISTED_RUN_RECORD_FAMILIES: readonly RunRecordFamily[] = where((f) => f.listed === true);
/** The replayed families (`parseJournalKey`). */
export const REPLAYED_RUN_RECORD_FAMILIES: readonly RunRecordFamily[] = where((f) => f.replayed === true);

/** The one key of a leaf family: `<runId>:<family>`. */
export function runRecordKey(runId: string, family: LeafRunRecordFamily): string;
/** A key of a tree family: `<runId>:<family>:<rest>`. */
export function runRecordKey(runId: string, family: TreeRunRecordFamily, rest: string): string;
export function runRecordKey(runId: string, family: RunRecordFamily, rest?: string): string {
  const shape = (RUN_RECORD_FAMILIES[family] as RecordFamily).shape;
  if (shape === 'leaf') {
    if (rest !== undefined) throw new Error(`@gnldev/durable: '${family}' is one key per run; it has no sub-key '${rest}'`);
    return `${runId}:${family}`;
  }
  if (rest === undefined) throw new Error(`@gnldev/durable: '${family}' is a family of keys; name the key under it`);
  return `${runId}:${family}:${rest}`;
}

/**
 * The prefix of a listed family's keys, `<runId>:<family>:` — the ONLY per-run prefix that may be listed
 * or deleted (besides the run's whole namespace, which `purgeOwnNamespace` reads by owner). Exact because
 * `assertRunIdSafe` refuses any run id carrying the segment.
 */
export function runRecordPrefix(runId: string, family: ListedRunRecordFamily): string {
  if ((RUN_RECORD_FAMILIES[family] as RecordFamily).listed !== true) throw new Error(`@gnldev/durable: '${family}' is not a listed family`);
  return `${runId}:${family}:`;
}

/** A replayed record's run and kind: `<runId>:(model|tool):<rest>` (greedy — a run id may hold ':'). */
export const RECORD_KEY_RE = new RegExp(`^(.*):(${REPLAYED_RUN_RECORD_FAMILIES.join('|')}):.+$`);
/**
 * A replayed family's name as a whole SEGMENT anywhere in an id: what an id that lands in the MIDDLE of a
 * key (a thread id in `mem:<id>:…`, an observation run) may not contain, since `RECORD_KEY_RE` would read
 * the key from that segment on as a run record.
 */
export const REPLAYED_SEGMENT_RE = new RegExp(`(^|:)(${REPLAYED_RUN_RECORD_FAMILIES.join('|')})(:|$)`);
/** The leaf key of a family, matched at the end of a key: what `runIdOfKey`/`outcomeStatusOf` strip. */
export const leafSuffix = (family: LeafRunRecordFamily): string => `:${family}`;

/** Whether a key is of a versioned family (format.ts): `:input`, `:model:<n>`, `:tool:<id>`. */
export function isVersionedRecordKey(key: string): boolean {
  return key.endsWith(leafSuffix('input')) || /:model:\d+$/.test(key) || /:tool:[^:]*$/.test(key);
}

/** Whether what follows `<runId>:` is one of the run's records (its first segment a declared family). */
export function isRunRecordRest(rest: string): boolean {
  const family = rest.split(':', 1)[0]!;
  return Object.prototype.hasOwnProperty.call(RUN_RECORD_FAMILIES, family);
}

/** What follows `<runId>:` says nothing about the run having started (run-identity.ts `rowsPresent`). */
export function isBookkeepingRest(rest: string): boolean {
  for (const name of familyNames) {
    const b = (RUN_RECORD_FAMILIES[name] as RecordFamily).bookkeeping;
    if (b === undefined) continue;
    if (rest === name) return b === true;
    if (!rest.startsWith(`${name}:`)) continue;
    if (b === true) return true;
    const sub = rest.slice(name.length + 1);
    if (b.some((p) => sub.startsWith(p))) return true;
  }
  return false;
}

// ── run-keyed families OUTSIDE the run's namespace ──────────────────────────────────────────────────

/**
 * Families keyed by a run id that do not live under `<runId>:` (the run id sits inside the key). Their
 * prefix is NOT exact — `xreq:x:args-` also starts every key of a run named `x:args-…` — so a listing or
 * deletion keeps the keys whose `ownerOf` is the run (`ownKeysOf`), never the prefix as such.
 */
export const RUN_KEYED_FAMILIES = {
  /** A request's idempotency window (journal.ts `runKeys.toolRequest`): `xreq:<request run>:args-<tool>-<hash>`. */
  'request-window': { prefix: (runId: string) => `xreq:${runId}:args-`, ownerOf: (key: string) => ownerBefore(key, 'xreq:', ':args-') },
  /** Their late reports (`runKeys.lateOf`): `xreq:<request run>:late-<tool>-<hash>`. */
  'request-window-late': { prefix: (runId: string) => `xreq:${runId}:late-`, ownerOf: (key: string) => ownerBefore(key, 'xreq:', ':late-') },
  /** The idempotency refusal ledger (idem-ledger.ts): `idem:conflict:<run>:<at>-<seq>-<uuid>`. */
  'idem-conflict': { prefix: (runId: string) => `idem:conflict:${runId}:`, ownerOf: (key: string) => ownerBefore(key, 'idem:conflict:', ':') },
} as const;
export type RunKeyedFamily = keyof typeof RUN_KEYED_FAMILIES;

/** The run id between `head` and the LAST `sep` — the tail after it holds no ':' (a tool name, a hash, a counter). */
function ownerBefore(key: string, head: string, sep: string): string | undefined {
  if (!key.startsWith(head)) return undefined;
  const i = key.lastIndexOf(sep);
  return i >= head.length ? key.slice(head.length, i) : undefined;
}

/** The keys of `family` that are `runId`'s (a listing of its prefix, minus every run whose id extends it). */
export async function ownKeysOf(journal: { listKeys(prefix: string): Promise<string[]> }, family: RunKeyedFamily, runId: string): Promise<{ own: string[]; all: number }> {
  const f = RUN_KEYED_FAMILIES[family];
  const keys = await journal.listKeys(f.prefix(runId));
  return { own: keys.filter((k) => f.ownerOf(k) === runId), all: keys.length };
}

// ── the derived family: ids minted from a workKey (hash.ts mints them) ─────────────────────────────

/** The engine's namespace on the raw runId surface. Generation 1 of the formula above. */
export const DERIVED_RUN_ID_PREFIX = 'run1_';

/**
 * The complete spelling of an engine-derived id: the prefix, 32 lowercase hex, and — optionally —
 * ONE execution-axis suffix.
 *
 * `#<n>` starts at 2 and carries no leading zero (`[2-9]\d*` covers 2..9 and anything opening with
 * 2-9; `[1-9]\d+` covers 10..19 and the rest), because execution #1 IS the bare id — a `#1` spelling
 * would be a second name for a run that already has one, and two names for one journal prefix is the
 * bug class this whole file exists to close. `#replay-<seq>` is the regression path's counter, a
 * DETERMINISTIC integer rather than the wall clock the old `:replay:${Date.now()}` buried in an id
 * (§4) — timestamps in an identity kill replay, and replay is what durability means here.
 * `#fork-<n>` is the third and last suffix: `forkRun`'s "re-run from here" copy, counted from 1
 * because — unlike an execution number — a fork is never the base run, so there is no fork #0 to
 * clash with the bare id.
 *
 * NO LEADING ZEROS anywhere, and that applies to `replay-` too (`0|[1-9]\d*`, not `\d+`). A suffix
 * is read back with `Number()`, so `#replay-01` and `#replay-1` would be two spellings of one
 * identity — the same "two names for one journal prefix" hazard as `#1`, arriving through a
 * different door. The engine never mints a padded number; refusing the padded spelling is what keeps
 * that a property instead of a habit.
 *
 * Note this is a full-string match: `run1_<32hex>#2#3` and `run1_<32hex>:child` do not pass. Inside
 * this namespace the engine owns the shape completely, so anything it did not mint is refused rather
 * than tolerated.
 */
const DERIVED_RUN_ID_RE =
  /^run1_([0-9a-f]{32})(?:#(?:([2-9]\d*|[1-9]\d+)|replay-(0|[1-9]\d*)|fork-([1-9]\d*)))?$/;

/** True for an id the engine could have minted — prefix, digest and at most one axis suffix. */
export function isDerivedRunId(runId: string): boolean {
  return DERIVED_RUN_ID_RE.test(runId);
}


/** What an engine-derived id says about itself, once it is read back apart. */
export interface DerivedRunIdParts {
  /** The 32 hex characters of `workDigest`. Not reversible to the workKey — that mapping is stored. */
  digest: string;
  /** Present from the second deliberate execution onwards; absent means execution #1. */
  execution?: number;
  /** Present on a regression replay: the deterministic counter behind `#replay-<seq>`. */
  replaySeq?: number;
  /** Present on a `forkRun` copy: the deterministic counter behind `#fork-<n>`, from 1. */
  fork?: number;
}

/**
 * The id WITHOUT its execution-axis suffix — `run1_<digest>` for every spelling in the namespace.
 *
 * The three minting sites (fork, rollover, replay) all need the same first move: given an id that may
 * already carry a suffix, find the base the suffix counts against. Doing it by hand is doing
 * `slice(0, indexOf('#'))` in three files, and the fourth site is where it gets done wrong.
 *
 * Returns `undefined` for anything outside the namespace — a raw runId has no base because it has no
 * axis, and the callers branch on exactly that.
 */
export function derivedRunIdBase(runId: string): string | undefined {
  const parts = parseDerivedRunId(runId);
  return parts ? DERIVED_RUN_ID_PREFIX + parts.digest : undefined;
}

/**
 * Reads an id the engine minted; returns `undefined` for everything else — including ids that merely
 * look derived (`run1_deadbeef`) and the spellings the axis forbids (`#1`, `#0`, `#x`).
 *
 * `undefined` rather than a throw because every caller of this is asking a QUESTION ("is this one of
 * ours?") about an id that legitimately might not be. The refusal of a lookalike belongs on the write
 * path, and lives there: `assertRunIdSafe`.
 */
export function parseDerivedRunId(runId: string): DerivedRunIdParts | undefined {
  if (typeof runId !== 'string') return undefined;
  const m = DERIVED_RUN_ID_RE.exec(runId);
  if (!m) return undefined;
  const parts: DerivedRunIdParts = { digest: m[1]! };
  if (m[2] !== undefined) parts.execution = Number(m[2]);
  if (m[3] !== undefined) parts.replaySeq = Number(m[3]);
  if (m[4] !== undefined) parts.fork = Number(m[4]);
  return parts;
}

// ── run ids the engine composes ────────────────────────────────────────────────────────────────────

interface IdFamily {
  /** Who may BEGIN a run with an id of this family: only the engine, or anyone (then the owner gate judges). */
  readonly begin: 'engine' | 'anyone';
  readonly shape: string;
  /** Why `begin` is what it is. */
  readonly why: string;
  /** The root nests: `<root>:<parent run id>:…` — so a listed family segment right after it is the parent's root, not a record. */
  readonly nests?: true;
}

/**
 * Every family of run id the engine (or a package on it) composes, by its first segment. `begin:
 * 'engine'` is enforced by `admitRunId` at the run's birth: a caller may continue such a run (the
 * owner gate judges it), never begin one — the id names someone else's call, and taking it first took
 * the call (audit B1, R2-2): the owner's sub-agent, workflow tool or whole network failed, and the
 * owner's erasure, which re-derives these ids from its own records, deleted the taker's run. Every
 * family the engine composes from a parent run is engine-begun; the others are begun by a package
 * under its caller, whom the owner gate judges.
 */
export const RUN_ID_FAMILIES = {
  task: { begin: 'engine', nests: true, shape: 'task:<parent run>:<tool call>', why: "a background call's task, begun from the parent's recorded call only" },
  cont: { begin: 'engine', nests: true, shape: 'cont:<parent run>:<tool call>', why: "the continuation that answers a background call, begun when its task ended" },
  agent: { begin: 'engine', nests: true, shape: 'agent:<parent run>:<tool call> (legacy agent:<tool call>)', why: "a sub-agent's run, begun from the parent's call by its delegation tool — a registered agent's sub-agent or createAgentTool" },
  wf: { begin: 'engine', nests: true, shape: 'wf:<parent run>:<tool call> (legacy wf:<tool call>)', why: "a workflow run as a tool, begun from the parent's call by the workflow tool" },
  net: { begin: 'engine', nests: true, shape: 'net:<parent run>:<step>', why: "a network step's run, begun by the network for its member — a host's NetworkTarget begins it with the run arguments the network hands it" },
  batch: { begin: 'anyone', shape: 'batch:<batch>:<item>', why: 'a batch item: begun by the batch, under its caller' },
  sched: { begin: 'anyone', shape: 'sched:<schedule>:<fire>', why: '@gnldev/scheduler: begun by a fire, under the schedule\'s owner' },
  eval: { begin: 'anyone', shape: 'eval:<scope>:<case>', why: '@gnldev/evals: begun by the dataset runner' },
  job: { begin: 'anyone', shape: 'job:<job id>', why: '@gnldev/queue: a job without a run id names itself' },
} as const satisfies Record<string, IdFamily>;

export type RunIdFamily = keyof typeof RUN_ID_FAMILIES;

/** The family of a run id, by its first segment (`undefined` for a caller's own spelling). */
export function runIdFamilyOf(runId: string): RunIdFamily | undefined {
  const root = runId.split(':', 1)[0]!;
  return Object.prototype.hasOwnProperty.call(RUN_ID_FAMILIES, root) && runId.length > root.length ? (root as RunIdFamily) : undefined;
}

/** The nesting families: an id composed from a parent run and the call (or step) that made it. */
export type NestingRunIdFamily = { [K in RunIdFamily]: (typeof RUN_ID_FAMILIES)[K] extends { nests: true } ? K : never }[RunIdFamily];

/**
 * The id of the run a parent's call (or a network's step) makes: `<family>:<parent>:<call>`. A pure
 * function of its arguments — erasure, limits and the purge cascade RE-DERIVE children from the parent's
 * records rather than observing them being made. Without a parent (a bare AI SDK loop, a journal from
 * before ids were parent-scoped) it is the legacy `<family>:<call>`.
 */
export function composeRunId(family: NestingRunIdFamily, parentRunId: string | undefined, call: string | number): string {
  return parentRunId ? `${family}:${parentRunId}:${call}` : `${family}:${call}`;
}

/**
 * The run id of a batch item, `batch:<batch>:<item>`. The caller spells two of its segments, so the
 * composed id is held to the spelling rule here, where it is composed — before the batch writes its
 * plan, which names the items: a segment that is a record family (`batch:<b>:tool`) would put an
 * item's keys inside run `batch:<b>`'s records.
 */
export function batchItemRunId(batchId: string, itemKey: string): string {
  const runId = `batch:${batchId}:${itemKey}`;
  assertRunIdSafe(runId);
  return runId;
}

/** The call a composed id was made for, its parent known (`composeRunId`'s inverse); `undefined` when it is not one. */
export function callOfRunId(runId: string, family: NestingRunIdFamily, parentRunId: string): string | undefined {
  const head = `${family}:${parentRunId}:`;
  return runId.startsWith(head) && runId.length > head.length ? runId.slice(head.length) : undefined;
}

/**
 * The run ids a rerun of a RAW run id is given: `<src>:fork:<n>` (time-travel, Studio's fork) and
 * `<src>:replay:<seq>` (a regression replay). A derived source (`run1_…`) uses the execution axis instead
 * (`#fork-<n>`, `#replay-<seq>`, hash.ts). Neither word is a record family, so the gate passes them.
 */
export function rerunRunId(src: string, kind: 'fork' | 'replay', n: number): string {
  return `${src}:${kind}:${n}`;
}

/** Whether only the engine may begin a run with this id. */
export function isEngineBegunRunId(runId: unknown): boolean {
  if (typeof runId !== 'string') return false;
  const f = runIdFamilyOf(runId);
  return f !== undefined && RUN_ID_FAMILIES[f].begin === 'engine';
}

/**
 * The engine's mark on run arguments it built itself, for an id only it may begin. A symbol no request
 * body can carry, not exported from the package: `{ [ENGINE_MINT]: runId }` on the args object (object
 * spread keeps it). Bound to the id, so the args of one run cannot begin another.
 * @internal
 */
export const ENGINE_MINT: unique symbol = Symbol('gnl.engineMint');

/** Marks run arguments the engine built for `args.runId`. @internal */
export function minted<T extends { runId?: unknown }>(args: T): T {
  return Object.assign(args, { [ENGINE_MINT]: args.runId });
}

/** `target` carrying the mark `from` carries (an executor request made from marked run args). @internal */
export function withMintOf<T extends object>(target: T, from: unknown): T {
  const mark = mintOf(from);
  return mark === undefined ? target : Object.assign(target, { [ENGINE_MINT]: mark });
}

/** The engine's mark on these arguments, if any. @internal */
export const mintOf = (args: unknown): unknown => (typeof args === 'object' && args !== null ? (args as Record<symbol, unknown>)[ENGINE_MINT] : undefined);

// ── the gate ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Key roots that are not runs' (memory, windows, organizations, an eval dataset's memo `evalds:`…). A run id starting with one would make
 * the run's purge delete that namespace.
 */
export const RESERVED_KEY_ROOTS: readonly string[] = ['mem', 'xthr', 'xid', 'xrun', 'xreq', 'om', 'thread', 'lesson', 'sugg', 'suggstats', 'org', 'res', 'evalds'];

/** Every `#` in this id sits inside a valid embedded derived id (`agent:run1_<hex>#2:tc`) — the engine put it there. */
function onlyEmbeddedDerivedHashes(runId: string): boolean {
  for (const segment of runId.split(':')) {
    if (segment.includes('#') && !isDerivedRunId(segment)) return false;
  }
  return true;
}

/**
 * The first segment of `runId` (past position 0) that names a listed record family — the spelling that
 * would put this run's keys inside another run's listed family (`x:tool:…` under `x`'s tool records,
 * `x:ev:…` in `x`'s event log). Segments that only spell the nesting of engine-composed ids are not
 * records: in `agent:wf:<p>:<c>` the `wf` is the root of the embedded parent id `wf:<p>:<c>`, which is
 * why every segment before it must itself be a nesting root, and why an id made of nesting roots alone
 * (`agent`, `agent:wf`) — the one run whose listed family such an id would land in — is refused below.
 */
function listedSegmentOf(runId: string): string | undefined {
  const segments = runId.split(':');
  let nesting = isNestingRoot(segments[0]!);
  for (let i = 1; i < segments.length; i++) {
    const s = segments[i]!;
    if (nesting && isNestingRoot(s)) continue;
    nesting = false;
    if ((LISTED_RUN_RECORD_FAMILIES as readonly string[]).includes(s)) return s;
  }
  return undefined;
}

function isNestingRoot(segment: string): boolean {
  return Object.prototype.hasOwnProperty.call(RUN_ID_FAMILIES, segment) && (RUN_ID_FAMILIES as Record<string, IdFamily>)[segment]!.nests === true;
}

/**
 * Throws when a run id's SPELLING would claim (or corrupt) key space that is not its own. Synchronous and
 * store-free; `admitRunId` is the full gate (this plus who may begin an engine id).
 */
export function assertRunIdSafe(runId: unknown): asserts runId is string {
  if (typeof runId !== 'string' || runId.length === 0) {
    throw new Error("@gnldev/durable: runId must be a non-empty string — it becomes the prefix of this run's journal keys.");
  }
  if (runId.length > 512) {
    throw new Error(`@gnldev/durable: runId is too long (${runId.length} > 512).`);
  }
  // Control characters and whitespace do not survive key round-trips intact across the adapters.
  if (/[\u0000-\u001f\u007f\s]/.test(runId)) {
    throw new Error("@gnldev/durable: runId must not contain whitespace or control characters — it becomes a journal key.");
  }
  // `run1_` is the engine's derived namespace: an id that wears it must have its exact shape, and '#' is
  // the engine's execution axis everywhere else (see hash.ts §4/§7).
  if (runId.startsWith(DERIVED_RUN_ID_PREFIX)) {
    if (!isDerivedRunId(runId)) {
      throw new Error(
        `@gnldev/durable: runId '${runId.slice(0, 60)}' uses '${DERIVED_RUN_ID_PREFIX}', which is reserved for ` +
          'engine-derived ids — the engine mints them from a workKey as ' +
          `'${DERIVED_RUN_ID_PREFIX}<32 lowercase hex>' with an optional '#<n≥2>', '#replay-<seq>' or ` +
          "'#fork-<n>' suffix, and an id that only looks derived would be trusted like one. " +
          'Choose an id outside this prefix.',
      );
    }
  } else if (runId.includes('#') && !onlyEmbeddedDerivedHashes(runId)) {
    throw new Error(
      `@gnldev/durable: runId '${runId.slice(0, 60)}' contains '#', which the engine reserves for its ` +
        "execution axis ('<derived id>#2' is the second deliberate run of the same work). Pick another separator.",
    );
  }
  const root = runId.split(':', 1)[0]!;
  if (RESERVED_KEY_ROOTS.includes(root) || root.startsWith('__')) {
    throw new Error(
      `@gnldev/durable: runId '${runId.slice(0, 60)}' starts with the reserved key family '${root}:' — ` +
      "runIds are journal key PREFIXES, and a retention sweep of this run would delete that family. Choose another id.",
    );
  }
  if (runId.split(':').every(isNestingRoot)) {
    throw new Error(
      `@gnldev/durable: runId '${runId.slice(0, 60)}' is only the root of ids the engine composes ('${runId}:<parent>:<call>') — ` +
      'a run with it would read those runs\' records as its own. Choose another id.',
    );
  }
  const segment = listedSegmentOf(runId);
  if (segment !== undefined) {
    throw new Error(
      `@gnldev/durable: runId '${runId.slice(0, 60)}' contains the journal's record separator ':${segment}' — ` +
      `that is where a run's '${segment}' records start, so this run's keys would be read back (and deleted) ` +
      'as records of a DIFFERENT run. Colons are fine; record segments are not. ' +
      'If a run with this id is ALREADY in your journal (it was accepted before this version), it can ' +
      'no longer be resumed or re-run, but `purgeRun(journal, id)` still deletes it — that call is not ' +
      'gated by this check. Give the work a new id.',
    );
  }
}

/** What `admitRunId` reads: the run's frozen input, the proof it was begun. */
interface AdmitStore { get(key: string): Promise<unknown> }

/**
 * THE admission gate for a run id, asked at the one place a run is born: `claimRunOwner`
 * (run-identity.ts), the owner record every run kind writes first. No entry point calls it — an entry
 * reaches the birth, and a writer that could put a row under an unborn id births it there or refuses
 * (the primitives at their first write, `@gnldev/workflow` through `JournalLike.beginRun`). That no
 * record is written under a run id before its birth is held by the birth witness every test file runs
 * under (test/birth-witness.setup.ts), not by a list of entry points.
 *
 *  1. The spelling (`assertRunIdSafe`).
 *  2. Who may begin it: an id of an engine-begun family (`task:`, `cont:`, `agent:`, `wf:`, `net:`) is
 *     begun only with the engine's mark (`minted`) for that id. Without it, the run must already exist — continuing a run is
 *     judged by its owner record, like any other; beginning one is taking an id the engine owes someone.
 */
export async function admitRunId(runId: unknown, ctx: { journal: AdmitStore; mint?: unknown }): Promise<void> {
  refuseUnknownNames('admitRunId', ctx, ADMIT_RUN_ID_NAMES);
  assertRunIdSafe(runId);
  if (!isEngineBegunRunId(runId) || ctx.mint === runId) return;
  if ((await ctx.journal.get(runRecordKey(runId, 'input'))) !== undefined) return;
  const family = runIdFamilyOf(runId)!;
  throw new RunOwnerMismatchError(
    `@gnldev/durable: run '${runId.slice(0, 80)}' is made by the engine (${RUN_ID_FAMILIES[family].why}); ` +
      'there is no such run for this caller, and a caller cannot begin one',
    { runId, owner: '', requested: '' },
  );
}
