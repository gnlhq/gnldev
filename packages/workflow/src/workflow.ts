// Durable deterministic workflow: each step's output is journaled with (runId, stepId).
// On crash→resume, COMPLETED steps do NOT run again (exactly-once); resumes from where it left off.
// Structurally compatible with @gnldev/durable's Journal (JournalLike) — zero dependency for the package.

export interface JournalLike {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  /**
   * Optional (CAS): writes and returns `true` when the key is ABSENT, returns `false` without
   * touching anything if it exists. Prevents the same step from running twice in multi-worker
   * setups (structurally compatible with @gnldev/durable Journal.putIfAbsent). If undefined, falls
   * back to get+put (single-process safe, behavior unchanged).
   */
  putIfAbsent?(key: string, value: unknown): Promise<boolean>;
  /**
   * Optional: field-based ATOMIC counter increment (structurally compatible with @gnldev/durable
   * Journal.incrBy). Saves the retry counter from get→put's lost-update race. If undefined,
   * falls back to the existing path.
   */
  incrBy?(key: string, fields: Record<string, number>): Promise<void>;
  /** Optional: read counter fields written via incrBy (undefined if absent). */
  getCounters?(key: string): Promise<Record<string, number> | undefined>;
  /**
   * P0.4 (optional): keys starting with a prefix — structurally compatible with @gnldev/durable
   * Journal.listKeys. Only `listWorkflowRuns` (the suspended-run registry query) needs it; every
   * engine path works without it.
   */
  listKeys?(prefix: string): Promise<string[]>;
  /**
   * Optional (CAS): conditional replace — writes `value` and returns `true` ONLY if the current
   * record equals `expected` (serialized equality); `false` without touching anything otherwise.
   * Structurally compatible with @gnldev/durable Journal.putIfMatch. Used by the side-effect claim
   * takeover (a stale claim is adopted atomically — two resuming workers can't both run the step).
   * If undefined, falls back to best-effort get→put (single-process safe, documented risk).
   */
  putIfMatch?(key: string, expected: unknown, value: unknown): Promise<boolean>;
  /**
   * Optional: the STORAGE's own clock (ms epoch) — structurally compatible with @gnldev/durable
   * Journal.now. Claim-staleness decisions use it when present, so wall-clock skew between workers
   * cannot disrupt takeover timing (same posture as run-lock's H2).
   */
  now?(): Promise<number>;
}

/**
 * Who a workflow run acts for — structurally the same value as @gnldev/durable's `RunIdentity`
 * (this package does not depend on durable). The engine fills it for every step: a run started
 * without one is `unknown`, which durable-aware tools treat as closed.
 */
export type WorkflowRunIdentity =
  | ({ kind: 'user'; id: string; orgId?: string } & WorkflowRunPlace)
  | ({ kind: 'staff'; orgId?: string } & WorkflowRunPlace)
  | ({ kind: 'unknown' } & WorkflowRunPlace);
type WorkflowRunPlace = { runId: string; threadId?: string; parentRunId?: string };

/** What a caller hands `run`/`runResumable`: a step context whose identity the engine may fill. */
export type WorkflowEntryCtx = Omit<StepCtx, 'identity'> & { identity?: WorkflowRunIdentity };

export interface StepCtx {
  runId: string;
  /**
   * The run's identity, ALWAYS present inside a step. Pass it on explicitly: to a tool as
   * `{ gnl: toolContextFor(ctx.identity) }`, to a child agent as `runDurable({ caller: ctx.identity })`.
   */
  identity: WorkflowRunIdentity;
  journal: JournalLike;
  /** Journal-key prefix for nested workflows (propagated via asStep; prevents collisions). */
  keyPrefix?: string;
  /**
   * P0.4: in-process cancellation signal (from `runResumable`'s opts.signal). Long-running steps
   * SHOULD observe it (pass to fetch/model calls); the ENGINE checks it between steps either way.
   */
  signal?: AbortSignal;
  /**
   * P0.4 typed resume: reads the resume payload delivered for `waitId` (journaled under
   * `<runId>:wf:_resume:<waitId>` by `runResumable({ resume })`), or `undefined` if none arrived yet.
   * The payload lives in the JOURNAL → reading it is replay-deterministic: once the consuming step
   * completes, its output is journaled and the payload is never re-read on replay.
   * NOTE: `waitId`s share ONE per-run namespace (deliberately NOT keyPrefix-scoped — the operator
   * resuming a run addresses a waitId without knowing which nested workflow hosts it). A workflow that
   * uses one `waitForResume` gate twice — the same nested workflow under two `asStep`s — is refused
   * where it is built: give the second gate its own waitId.
   */
  resumeData?<T = unknown>(waitId: string): Promise<T | undefined>;
  /**
   * This step's own journal key (`<runId>:wf:<keyPrefix><stepId>`) — ENGINE-INJECTED by `runStep`
   * before every step run, so inside a step's `run()` it is always present (optional only because
   * the ctx object callers construct doesn't carry it). Single source of truth with the record key.
   * Carry it to external APIs (e.g. as a Stripe-style Idempotency-Key header) and the journal's
   * exactly-once extends into the downstream system: a crash-window duplicate then dedupes THERE too.
   */
  idempotencyKey?: string;
  /** FAZ-8 (critical preset'in runtime ağı): true iken, `sideEffect: true` beyan edip `recover`
   *  Taşımayan bir adım claim'inden ÖNCE reddedilir — build()'in göremediği kombinatör kolları ve
   *  Nested çocuklar dahil her yolda. Registry critical'de kurar; elle kullanılabilir. */
  strictSideEffects?: boolean;
}

// ── P0.4 key builders (single source of truth for the new key shapes) ──────────
/** A run started without an identity is `unknown` — never staff by omission. */
function withIdentity(entry: WorkflowEntryCtx): StepCtx {
  return entry.identity ? (entry as StepCtx) : { ...entry, identity: { kind: 'unknown', runId: entry.runId } };
}

/** Resume payload for a waitId (per-run namespace, NOT keyPrefix-scoped — see StepCtx.resumeData). */
const resumeKey = (runId: string, waitId: string) => `${runId}:wf:_resume:${waitId}`;
/** Durable cancel flag — once written, NO worker will run further steps of this run (cross-process). */
const canceledKey = (runId: string) => `${runId}:wf:_canceled`;

/**
 * Where a retry records that a step's output came from its fallback rather than from the step.
 *
 * The `_` is the reserved-control-key convention (`_suspend`, `_resume:*`, `_canceled`) and it is
 * load-bearing here rather than cosmetic. A nested workflow's steps live at
 * `<runId>:wf:<outerId>:<innerId>`, so a plain `:fallback` suffix is ALSO the key of an inner step
 * literally named `fallback` — measured, its output was then read back as a substitution marker, and
 * A step that never failed reported that it had. That is worse than the ambiguity this marker exists
 * to remove: it does not fail to say, it says the wrong thing.
 *
 * The prefix also puts the key inside `forkWorkflowRun`'s existing `:_` skip, which is what a fork
 * needs: the marker describes a specific output and must not outlive it (see the explicit copy there).
 */
const FALLBACK_MARKER_BRAND = '__gnlFallback' as const;
const fallbackMarkerKey = (runId: string, keyPrefix: string | undefined, stepId: string) =>
  `${runId}:wf:${keyPrefix ?? ''}${stepId}:_fallback`;
/**
 * Top-level status registry key. Deliberately NOT under `<runId>:` — a `wfrun:` prefix scan
 * (`listKeys('wfrun:')`) enumerates every workflow run in ONE query, which a runId-prefixed key
 * cannot offer (no suffix scans). Same pattern precedent as @gnldev/durable's `xrun:` cross-run keys:
 * invisible to parseJournalKey (not part of any single run's timeline) and org-prefixed automatically
 * by `withOrg` (it prefixes ALL keys unconditionally) → organization isolation is preserved.
 * Cleanup note (same as xrun:): a `<runId>:*` prefix delete does NOT touch this key — @gnldev/durable's
 * `purgeRun` deletes it for the run it purges (and for the nested workflow children it cascades into),
 * neighbor-safely; anything sweeping the journal itself must handle it.
 * purge explicitly via `deletePrefix('wfrun:')` (all) — but BEWARE the per-run form:
 * `deletePrefix('wfrun:<runId>')` is PREFIX-matched, so runId 'r1' would also sweep 'r10'/'r1x'
 * (there is no trailing terminator in this key shape). Safe only when runIds cannot share prefixes
 * (UUIDs). Org deployments don't need it at all: the key is org-prefixed, so a GDPR
 * `purgeOrganization`/`deletePrefix('org:<id>:')` sweeps the org's wfrun records exactly.
 */
const statusKey = (runId: string) => `wfrun:${runId}`;
const WFRUN_PRE = 'wfrun:';

export interface Step<I = any, O = any> {
  id: string;
  run(input: I, ctx: StepCtx): Promise<O>;
  /** FAZ-1 (optional): side-effect durability contract — see `StepDurability` and `step()`'s 3rd arg. */
  durability?: StepDurability<I, O>;
}

/**
 * FAZ-1 — durability contract for a step whose body fires a NON-IDEMPOTENT external effect (an HTTP
 * POST, a charge, an email). Without it, the engine journals the step AFTER it runs — a crash between
 * the effect and the journal write leaves no record, and the resume re-fires the effect (the classic
 * crash-window duplicate). With `sideEffect: true` the engine writes a WRITE-AHEAD CLAIM
 * (`<stepKey>:_claim`) before executing, so a resume can TELL "never started" from "died mid-flight":
 *   Claim absent            → never started, run normally.
 *   Output present          → completed, replay (unchanged).
 *   Claim live (< ttl)      → another worker / a very recent attempt is in flight → StepRetryBlockedError.
 *   Claim stale or `failed` → THE CRASH WINDOW: the effect may or may not have fired. `recover` is
 *     Asked first ("check the external system — did it land?"); without `recover`, the engine refuses
 *     To guess (StepRetryBlockedError with state 'unresolved') instead of silently double-firing.
 * A step WITHOUT `sideEffect` keeps today's path byte-for-byte (no claim key is ever written).
 */
export interface StepDurability<I = any, O = any> {
  /** Declare the step's body non-idempotent → the write-ahead claim protocol above activates. */
  sideEffect?: boolean;
  /**
   * Crash-window resolver: consult the EXTERNAL system ("does a payment with this idempotencyKey
   * exist?") and report. `{done: true, output}` → the effect landed; `output` is journaled as the
   * step's record and the body is NOT re-run. `{done: false}` → the effect never landed; the claim is
   * taken over (CAS) and the body runs for real. Any other shape is rejected loudly (same shape
   * discipline as @gnldev/durable's recover — a malformed recovery must not masquerade as an output).
   */
  recover?(input: I, opts: { idempotencyKey: string }): Promise<{ done: true; output: O } | { done: false }>;
  /**
   * How long a claim with no output record is presumed IN-FLIGHT before a resume treats it as a
   * crash (default 60s). Calibrate ABOVE the step's real worst-case duration: a too-short TTL lets a
   * resume adopt a step that is still running on another worker (double side effect — the exact thing
   * this exists to prevent); a too-long one only delays recovery after a genuine crash.
   */
  claimTtlMs?: number;
}

const DEFAULT_CLAIM_TTL_MS = 60_000;

/** The write-ahead claim record (at `<stepKey>:_claim` — inside the `:_` control-key namespace). */
interface StepClaimRecord {
  startedAt: number;
  /** The attempt ended in a CLEAN suspend (WorkflowSuspended) — re-running on resume is the step's documented contract. */
  released?: true;
  /** The attempt THREW — the effect is uncertain, but we know it's not in flight → resume skips the TTL wait and goes straight to recover/blocked. */
  failed?: true;
}

/**
 * FAZ-1 — a side-effect step's resume was refused. Two states:
 * 'in-flight': a live claim exists (another worker, or an attempt younger than claimTtlMs) — retry
 *   After the TTL; the block clears on its own.
 * 'unresolved': the previous attempt died inside the crash window (stale claim / stamped `failed`)
 *   And the step has no `recover` — the engine will not guess whether the effect fired. Provide
 *   `recover()` on the step, or resolve manually after checking the external system:
 *   · effect LANDED   → `journal.put(detail.key, <the real output>)` — the resume replays it.
 *   · effect NOT fired → `journal.put(`${detail.key}:_claim`, { startedAt: Date.now(), released: true })`
 *     — the resume adopts the claim and re-runs the step.
 */
export class StepRetryBlockedError extends Error {
  constructor(
    stepId: string,
    public readonly detail: { key: string; state: 'in-flight' | 'unresolved'; ageMs?: number; claimTtlMs?: number },
  ) {
    super(
      detail.state === 'in-flight'
        ? `@gnldev/workflow: step '${stepId}' has a live side-effect claim (age ${detail.ageMs ?? '?'}ms < ttl ${detail.claimTtlMs ?? '?'}ms) — another worker may be running it; retry after the TTL.`
        : `@gnldev/workflow: step '${stepId}' died inside the side-effect crash window — the effect may have fired. Provide 'recover()' on the step, or verify the external system and write '${detail.key}' manually.`,
    );
    this.name = 'StepRetryBlockedError';
  }
}

export function step<I = any, O = any>(
  id: string,
  run: (input: I, ctx: StepCtx) => Promise<O>,
  opts?: StepDurability<I, O>,
): Step<I, O> {
  return opts ? { id, run, durability: opts } : { id, run };
}

// Atomic claim — identical contract to `claim` in @gnldev/durable (packages/durable/src/journal.ts;
// kept as a local copy since the package stays zero-dependency): CAS if putIfAbsent exists, else
// get+put fallback (single-process safe). Returns `true` if this call created the key.
async function claim(journal: JournalLike, key: string, value: unknown): Promise<boolean> {
  if (journal.putIfAbsent) return journal.putIfAbsent(key, value);
  if ((await journal.get(key)) !== undefined) return false;
  await journal.put(key, value);
  return true;
}

// ── The step record ────────────────────────────────────────────────────────────
// A step's record is its output, stored as-is — with two exceptions, both under ONE reserved key:
//
//   • `undefined`. Every backend reads a key holding `undefined` back as `undefined`, which is also what
//     `get` answers for "no key", so a `void` step (send an email, write a row) was journaled but looked
//     unrun: it re-ran on every resume, and a `sideEffect` one blocked on its own finished claim. It is
//     written as `{ __gnlStepRecord: 'void' }`.
//   • an output that itself carries the reserved key. It is written wrapped,
//     `{ __gnlStepRecord: 'value', value: <output> }`, so no output a step can return reads back as
//     anything but itself. (The first cut branded void as `{ __gnlVoid: true }` and read EVERY value of
//     that shape as `undefined` — a step that returned that object replayed as `undefined`.)
//
// Every other output keeps the plain shape it has always had, so records written by 0.9.0 replay
// unchanged, and a reader that `get`s a step key sees what the step returned.
//
// The same pair lives in @gnldev/durable (`encodeStepRecord` / `decodeStepRecord`), which is what
// Studio and the durable registry read step records with. This package stays dependency-free, so it
// keeps this copy; durable's test suite runs a table of outputs through THIS writer and THAT reader
// (step-record-parity.test.ts), so the two cannot drift apart unnoticed.
const STEP_RECORD_KEY = '__gnlStepRecord' as const;
const VOID_RECORD = { [STEP_RECORD_KEY]: 'void' } as const;

function hasOwn(v: unknown, k: string): boolean {
  return !!v && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, k);
}

/** The value written for a step output: `undefined` → the void record; a value carrying the key → wrapped. */
function toStepRecord(out: unknown): unknown {
  if (out === undefined) return VOID_RECORD;
  return hasOwn(out, STEP_RECORD_KEY) ? { [STEP_RECORD_KEY]: 'value', value: out } : out;
}

/** The output a stored record stands for (the inverse of `toStepRecord`; a plain 0.9.0 value is itself). */
function fromStepRecord(v: unknown): unknown {
  if (!hasOwn(v, STEP_RECORD_KEY)) return v;
  const r = v as Record<string, unknown>;
  const keys = Object.keys(r);
  if (r[STEP_RECORD_KEY] === 'void' && keys.length === 1) return undefined;
  if (r[STEP_RECORD_KEY] === 'value' && keys.length === 2 && 'value' in r) return r.value;
  return v;
}

/**
 * True for the record that stands for a step that completed with `undefined`. Exported so a reader
 * outside the engine (an inspector, a UI) can show it as `undefined` rather than as the record. No
 * output a step returns is ever stored in this shape (see `toStepRecord`).
 */
export function isVoidStepRecord(v: unknown): boolean {
  return hasOwn(v, STEP_RECORD_KEY) && (v as Record<string, unknown>)[STEP_RECORD_KEY] === 'void' && Object.keys(v as object).length === 1;
}

/** A step's completion, told apart from its value: `undefined` = no record; `{ output }` = completed. */
async function readStepRecord(journal: JournalLike, key: string): Promise<{ output: unknown } | undefined> {
  const v = await journal.get(key);
  if (v === undefined) return undefined;
  return { output: fromStepRecord(v) };
}

/**
 * A void output journaled by 0.9.0 or earlier: the key EXISTS but holds a raw `undefined`, which `get`
 * cannot tell from absence. Only `listKeys` can see it, so it is asked only where a record was
 * expected and none was readable — never on the fresh-step path.
 */
async function isLegacyVoidRecord(journal: JournalLike, key: string): Promise<boolean> {
  if (!journal.listKeys) return false;
  return (await journal.listKeys(key)).includes(key);
}

/**
 * Journals `out` first-writer-wins and returns the output that won. The loser of a race DISCARDS its
 * own result and returns the winner's (single source of truth across workers). A winner that is a
 * 0.9.0 void record is rewritten in the new shape, so the next resume replays it.
 */
async function recordStepOutput(journal: JournalLike, key: string, out: unknown): Promise<unknown> {
  if (await claim(journal, key, toStepRecord(out))) return out;
  const winner = await readStepRecord(journal, key);
  if (winner) return winner.output;
  if (await isLegacyVoidRecord(journal, key)) {
    await journal.put(key, VOID_RECORD);
    return undefined;
  }
  return out;
}

// Runs a step exactly-once: if a record exists, returns it (replay); otherwise runs it and records it
// via CAS. This is @gnldev/durable's `frozenGet` adapted to workflow; the difference is the record
// shape — workflow records stay plain values (no `{ v }` wrapper) so existing records remain readable,
// with the one exception of `undefined` described above.
async function runStep(s: Step, input: any, ctx: StepCtx): Promise<any> {
  const key = `${ctx.runId}:wf:${ctx.keyPrefix ?? ''}${s.id}`;
  const cached = await readStepRecord(ctx.journal, key);
  if (cached) return cached.output;
  // FAZ-1: the step's journal key doubles as its idempotencyKey — single source of truth, injected
  // into ctx so the step body can hand it to external APIs (see StepCtx.idempotencyKey).
  const ctx2: StepCtx = { ...ctx, idempotencyKey: key };
  if (s.durability?.sideEffect) return runSideEffectStep(s, s.durability, input, ctx2, key);
  return recordStepOutput(ctx.journal, key, await s.run(input, ctx2));
}

/** The storage's clock when it has one (multi-worker skew safety — run-lock's H2 posture), else local. */
async function clockOf(journal: JournalLike): Promise<number> {
  return journal.now ? journal.now() : Date.now();
}

/** Adopt an existing claim atomically. CAS operand is the RAW record we read (durable-tool's war
 * story: hashing/reshaping the operand makes the CAS compare a record that was never stored). A lost
 * CAS means another resume adopted it first → blocked, the winner runs. Fallback without putIfMatch
 * is best-effort put (single-process safe — same posture as `claim` above). */
async function adoptClaim(
  journal: JournalLike,
  claimKey: string,
  cur: StepClaimRecord,
  next: StepClaimRecord,
  stepId: string,
  key: string,
  info?: { ageMs?: number; claimTtlMs?: number },
): Promise<void> {
  if (journal.putIfMatch) {
    if (!(await journal.putIfMatch(claimKey, cur, next))) {
      throw new StepRetryBlockedError(stepId, { key, state: 'in-flight', ...info });
    }
    return;
  }
  await journal.put(claimKey, next);
}

function assertRecoverShape(r: unknown, stepId: string): asserts r is { done: true; output: unknown } | { done: false } {
  const v = r as { done?: unknown } | null | undefined;
  const ok = !!v && typeof v === 'object' && (v.done === true ? 'output' in v : v.done === false);
  if (!ok) {
    throw new Error(
      `@gnldev/workflow: recover('${stepId}') must return {done:true, output} or {done:false} — got ${JSON.stringify(r)?.slice(0, 120)}. A malformed recovery must not masquerade as a step output.`,
    );
  }
}

// FAZ-1 — the side-effect path: write-ahead claim BEFORE execute, so the effect can never fire
// without a trace. Protocol details on StepDurability's JSDoc. Ordering is the whole point: the old
// get→run→claim sequence journaled the step only AFTER its body ran, so the CAS chose which OUTPUT
// survived but never prevented a duplicate EFFECT.
async function runSideEffectStep(
  s: Step,
  d: StepDurability,
  input: any,
  ctx: StepCtx,
  key: string,
): Promise<any> {
  const journal = ctx.journal;
  if (ctx.strictSideEffects && typeof d.recover !== 'function') {
    // The critical preset's runtime net (K6): build()-time scanning cannot see a parallel leg's or a
    // nested child's declaration — this point CAN, because every path funnels through runStep.
    throw new Error(
      `@gnldev/workflow: strictSideEffects — step '${s.id}' declares sideEffect without recover(); the crash window must be answered (give recover(), or run without the critical policy).`,
    );
  }
  const claimKey = `${key}:_claim`; // `:_` control-key namespace → skipped by fork's sweep (a fork gets a fresh claim budget)
  const ttl = d.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;

  let mine: StepClaimRecord = { startedAt: await clockOf(journal) };
  if (!(await claim(journal, claimKey, mine))) {
    // A claim already exists: crash-resume, a clean suspend, or a concurrent worker.
    const done = await readStepRecord(journal, key);
    if (done) return done.output; // completed between the cache check and here
    if (await isLegacyVoidRecord(journal, key)) {
      // Completed under 0.9.0 with `undefined`: its claim is a finished attempt's, not a live one.
      await journal.put(key, VOID_RECORD);
      return undefined;
    }
    const cur = await journal.get<StepClaimRecord>(claimKey); // RAW record — the CAS operand
    const at = await clockOf(journal);
    if (!cur) {
      // The claim was lost but the record can't be read either (raced with a purge) → one more atomic try.
      mine = { startedAt: at };
      if (!(await claim(journal, claimKey, mine))) {
        throw new StepRetryBlockedError(s.id, { key, state: 'in-flight' });
      }
    } else if (cur.released) {
      // A clean suspend: re-running on resume is the step's documented contract (suspendWorkflow) — adopt and run.
      mine = { startedAt: at };
      await adoptClaim(journal, claimKey, cur, mine, s.id, key, { ageMs: at - cur.startedAt, claimTtlMs: ttl });
      const landed = await readStepRecord(journal, key);
      if (landed) return landed.output; // a sibling completed between our reads — replay, don't re-fire
    } else if (!cur.failed && at - cur.startedAt < ttl) {
      throw new StepRetryBlockedError(s.id, { key, state: 'in-flight', ageMs: at - cur.startedAt, claimTtlMs: ttl });
    } else {
      // THE CRASH WINDOW: a stale claim (process death) or a stamped `failed` attempt — the effect
      // May or may not have fired. Ask the external system first; never guess.
      if (!d.recover) {
        throw new StepRetryBlockedError(s.id, { key, state: 'unresolved', ageMs: at - cur.startedAt, claimTtlMs: ttl });
      }
      const r = await d.recover(input, { idempotencyKey: key });
      assertRecoverShape(r, s.id);
      if (r.done) return recordStepOutput(journal, key, r.output);
      // The effect never landed → adopt the claim (atomically — two resumes must not both re-run) and execute.
      mine = { startedAt: at };
      await adoptClaim(journal, claimKey, cur, mine, s.id, key, { ageMs: at - cur.startedAt, claimTtlMs: ttl });
      // A sibling resume's recover({done:true}) writes the OUTPUT without touching the claim — one
      // last point-read closes that window before re-firing (heyet: Deniz'in çift-recover senaryosu).
      const landed = await readStepRecord(journal, key);
      if (landed) return landed.output;
    }
  }
  try {
    return await recordStepOutput(journal, key, await s.run(input, ctx));
  } catch (e) {
    // Stamp what we KNOW onto the claim so the resume needn't wait out the TTL: a clean suspend is
    // safe to re-run; a throw means "not in flight, effect uncertain". Best-effort CAS against OUR
    // record — a takeover in between wins, and a stamp failure must never mask the step's own error.
    const stamp: StepClaimRecord =
      e instanceof WorkflowSuspended ? { ...mine, released: true } : { ...mine, failed: true };
    try {
      if (journal.putIfMatch) {
        await journal.putIfMatch(claimKey, mine, stamp);
      } else {
        // No CAS: narrow the window with a read-compare — never stamp over a claim that is no
        // longer ours (a takeover adopted it while our attempt was still failing).
        const cur = await journal.get<StepClaimRecord>(claimKey);
        if (cur && cur.startedAt === mine.startedAt && !cur.released && !cur.failed) {
          await journal.put(claimKey, stamp);
        }
      }
    } catch {
      /* the step's own error wins */
    }
    throw e;
  }
}

// ── Which journal keys a step use writes ──────────────────────────────────────────
// A step's journal key is its id — but not only its id. A nested workflow's steps live at
// `<outer>:<inner>`, a retry keeps `<id>:attempts` and `<id>:_fallback`, its fallback runs under its
// own id in the SAME namespace, a sideEffect step writes `<id>:_claim`, a parallel leg runs as
// `<pid>/<leg>`, loop rounds as `<id>#<n>`, foreach items as `<id>[<n>]`, a `waitForResume` gate reads
// `_resume:<waitId>`, and the engine keeps `_suspend`, `_canceled` and `_input` beside them. Two uses
// that reach one key make the second replay the first one's output — on a FRESH run, with no error.
// Checking ids alone missed every case where the key is built from more than the id (a top-level
// `pay:check` and a `check` inside `asStep('pay')`), so the check is on the keys themselves, where the
// workflow is built.
//
// What a step's BODY writes beyond the key it runs under is recorded against its run function, not
// the step object: a renamed copy — `step('sub-2', sub.run)` — runs the same body, and an asStep body
// keeps writing under the id it was created with, whatever it is renamed to.
interface KeyClaim {
  key: string;
  /** `exact`: that key. `loop`: every `<key>#<n>`. `foreach`: every `<key>[<n>]`. */
  kind: 'exact' | 'loop' | 'foreach';
  /** Who writes it, for the error (absent: `step '<key>'` — built only if an error needs it, see `fromOf`). */
  from?: string;
  /** The one line that separates it, for the error (absent: `give step '<key>' another id`). */
  fix?: string;
  /** The id the developer chose for whatever writes this key — what to rename when the key is reserved. */
  owner: string;
  /** The engine writes this key for its own bookkeeping (a counter, a marker, a claim, a resume payload). */
  engine?: true;
  /** One key per RUN, not namespaced by an enclosing `asStep` (resume payloads — see StepCtx.resumeData). */
  runWide?: true;
  /** What two uses of the same kind sharing the key would do, for the error (default: the second replays the first one's output). */
  effect?: string;
}
interface BodyInfo {
  kind: 'asStep' | 'retry' | 'composite' | 'wait';
  id: string;
  /** `usedAs`: the id of the step object carrying this body — a renamed copy's, when it is one. */
  claims: (usedAs: string) => KeyClaim[];
}
const BODIES = new WeakMap<Function, BodyInfo>();

/** Every key one use of `s` writes when it runs under `runAs` (a parallel leg or branch arm runs under a scoped id). */
function claimsOf(s: Step, runAs: string = s.id): KeyClaim[] {
  // The step's own key carries no text: it is the claim every step has, so its words are built only
  // when an error needs them (`fromOf` / `fixOf`), not on every `.then`.
  const own: KeyClaim[] = [{ key: runAs, kind: 'exact', owner: s.id }];
  if (s.durability?.sideEffect) own.push({ key: `${runAs}:_claim`, kind: 'exact', from: `the side-effect claim of step '${runAs}'`, fix: `give step '${runAs}' another id`, owner: s.id, engine: true });
  const body = BODIES.get(s.run);
  if (body) for (const c of body.claims(s.id)) own.push(c);
  return own;
}

/**
 * Is this key — the part of a journal key after `<runId>:wf:` — one of the engine's own records rather
 * than a step's output?
 *
 * The ONE place that decides it. The engine writes its bookkeeping under a path segment that starts
 * with `_` (`_suspend`, `_canceled`, `_input`, `_resume:<waitId>`, `<id>:_claim`, `<id>:_fallback`) and
 * a retry's counter at `<id>:attempts`; a workflow refuses, where it is built, every step whose key
 * this answers `true` for, so a reader that lists `<runId>:wf:*` can use it to tell steps from
 * bookkeeping — `forkWorkflowRun` does, and so does Studio's run view.
 */
export function isEngineRecordKey(rest: string): boolean {
  return rest.startsWith('_') || rest.includes(':_') || rest.endsWith(':attempts');
}

const fromOf = (c: KeyClaim) => c.from ?? `step '${c.key}'`;
const fixOf = (c: KeyClaim) => c.fix ?? `give step '${c.key}' another id`;

/** One key a pattern claim stands for — enough to ask `isEngineRecordKey` about all of them. */
const sampleKey = (c: KeyClaim) => (c.kind === 'loop' ? `${c.key}#0` : c.kind === 'foreach' ? `${c.key}[0]` : c.key);
const shownKey = (c: KeyClaim) => (c.kind === 'loop' ? `${c.key}#<n>` : c.kind === 'foreach' ? `${c.key}[<n>]` : c.key);

/** The nearest id to `id` whose keys the engine does not reserve, for the error. */
function unreservedId(id: string): string {
  const segs = id.split(':').map((seg) => seg.replace(/^_+/, '')).filter(Boolean);
  if (segs.length && segs[segs.length - 1] === 'attempts') segs[segs.length - 1] = 'attempt-count';
  return segs.join(':') || 'step';
}

/** The pattern an exact key would be one member of: `x#3` is a round of loop `x`, `f[0]` an item of foreach `f`. */
function patternOf(key: string): { kind: 'loop' | 'foreach'; base: string } | undefined {
  const last = key.charCodeAt(key.length - 1);
  if (last >= 48 && last <= 57) {
    const h = key.lastIndexOf('#');
    if (h >= 0 && /^\d+$/.test(key.slice(h + 1))) return { kind: 'loop', base: key.slice(0, h) };
  } else if (last === 93 /* ] */) {
    const b = key.lastIndexOf('[');
    if (b >= 0 && /^\d+$/.test(key.slice(b + 1, -1))) return { kind: 'foreach', base: key.slice(0, b) };
  }
  return undefined;
}

/**
 * The keys the step uses so far claim, so that adding one use checks only that use's keys: an exact
 * key is one lookup, a loop or foreach pattern is one lookup by its base, and an exact key that LOOKS
 * like a pattern member (`x#3`, `f[0]`) is also filed under the base it would belong to.
 *
 * It used to compare every pair of uses again on every `.then`, which made building a workflow cubic in
 * its length — measured, 1000 steps took over two seconds against 1 ms in 0.9.0.
 */
class KeyIndex {
  // A use's claims are all checked before any is filed, so whatever these hold belongs to an EARLIER use.
  private readonly exact = new Map<string, KeyClaim>();
  private readonly patterns = { loop: new Map<string, KeyClaim>(), foreach: new Map<string, KeyClaim>() };
  private readonly members = { loop: new Map<string, KeyClaim>(), foreach: new Map<string, KeyClaim>() };
  private readonly ids = new Set<string>();
  /** How many step uses this index holds. */
  uses = 0;

  static of(steps: Step[]): KeyIndex {
    const idx = new KeyIndex();
    for (const s of steps) idx.addStep(s);
    return idx;
  }

  /** One step of the workflow: its id must be new, its keys unclaimed and not reserved. */
  addStep(s: Step): void {
    if (this.ids.has(s.id)) throw duplicateIdError(s);
    const claims = claimsOf(s);
    this.assertFree(claims);
    for (const c of claims) {
      if (c.engine || !isEngineRecordKey(sampleKey(c))) continue;
      throw new Error(
        `@gnldev/workflow: ${fromOf(c)} would be journaled at '${shownKey(c)}', a key reserved for the engine's own records — any path segment starting with '_' (as in '_suspend', '_resume:<waitId>', '<id>:_fallback') and any key ending ':attempts' (a retry's counter). Studio and forkWorkflowRun skip those keys as bookkeeping, so the step would run but never be shown or forked. To keep it: rename '${c.owner}', e.g. '${unreservedId(c.owner)}'.`,
      );
    }
    this.ids.add(s.id);
    this.insert(claims);
  }

  /** Several uses that run in one run with no ids to compare (parallel legs): keys only. */
  addUse(claims: KeyClaim[]): void {
    this.assertFree(claims);
    this.insert(claims);
  }

  private assertFree(claims: KeyClaim[]): void {
    for (const b of claims) {
      const a = this.holderOf(b);
      if (!a) continue;
      const key = a.kind === 'exact' ? a.key : shownKey(b.kind === 'exact' ? b : a);
      throw new Error(
        `@gnldev/workflow: ${fromOf(a)} and ${fromOf(b)} are both journaled at '${key}', ${a.effect !== undefined && a.effect === b.effect ? a.effect : "so the second would replay the first one's output instead of running"}. To keep both: ${fixOf(b)}.`,
      );
    }
  }

  /** The claim an earlier use holds on any key `c` reaches. */
  private holderOf(c: KeyClaim): KeyClaim | undefined {
    if (c.kind === 'exact') {
      const hit = this.exact.get(c.key);
      if (hit) return hit;
      const p = patternOf(c.key);
      return p ? this.patterns[p.kind].get(p.base) : undefined;
    }
    return this.patterns[c.kind].get(c.key) ?? this.members[c.kind].get(c.key);
  }

  private insert(claims: KeyClaim[]): void {
    this.uses++;
    for (const c of claims) {
      if (c.kind !== 'exact') {
        if (!this.patterns[c.kind].has(c.key)) this.patterns[c.kind].set(c.key, c);
        continue;
      }
      if (this.exact.has(c.key)) continue; // the same use reaching one key twice (both arms of a branch)
      this.exact.set(c.key, c);
      const p = patternOf(c.key);
      if (p && !this.members[p.kind].has(p.base)) this.members[p.kind].set(p.base, c);
    }
  }
}

/** Refuses two step uses (one group each) that reach one journal key. */
function assertDistinctKeys(groups: KeyClaim[][]): void {
  const idx = new KeyIndex();
  for (const g of groups) idx.addUse(g);
}

/**
 * One step id used twice in one workflow — the commonest form of the collision above, kept as its own
 * message because its way through depends on what the step is: a renamed copy of an asStep, a retry
 * or a resume gate would still write the original's nested keys, counter or waitId.
 */
function duplicateIdError(s: Step): Error {
  const id = s.id;
  const body = BODIES.get(s.run);
  const fix =
    body?.kind === 'asStep'
      ? `asStep('${id}-2', <the same workflow>) — not step('${id}-2', ${safeIdent(id)}.run), whose nested steps would still be journaled under '${body.id}:'`
      : body?.kind === 'retry'
        ? `retry(step('${id}-2', <the retried step>.run), <the same policy>) — a renamed copy of the retry itself keeps its attempt counter at '${body.id}:attempts'`
        : body?.kind === 'wait'
          ? `waitForResume('${id}-2') — a renamed copy, step('${id}-2', ${safeIdent(id)}.run), still waits on '${body.id}'`
          : `step('${id}-2', ${safeIdent(id)}.run) (pass ${safeIdent(id)}.durability as the third argument if it has one)`;
  return new Error(
    `@gnldev/workflow: step id '${id}' is used twice in one workflow. Every step is journaled under its id, so the second use would replay the first one's output instead of running. Give each use its own id: ${fix}.`,
  );
}

function assertUniqueStepIds(steps: Step[]): void {
  const seen = new Set<string>();
  for (const s of steps) {
    if (seen.has(s.id)) throw duplicateIdError(s);
    seen.add(s.id);
  }
}

/** The step id as it most likely appears as a variable name in the caller's code, for the error text. */
function safeIdent(id: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(id) ? id : 'yourStep';
}

/** Hands a builder's key index to the workflow `extend` is constructing (synchronous, so one slot does). */
let seed: { steps: Step[]; keys: KeyIndex } | undefined;

export class Workflow<I = any, O = any> {
  private readonly keys: KeyIndex;

  constructor(private readonly steps: Step[]) {
    const handed = seed?.steps === steps ? seed.keys : undefined;
    seed = undefined;
    this.keys = handed ?? KeyIndex.of(steps);
  }

  /**
   * This workflow plus one step, checking only that step's keys. The index is shared with the new
   * workflow while this one is the last to have extended it; a second extension of the same builder
   * (`base.then(a)`, then `base.then(b)`) finds it already holding another step and starts its own.
   */
  private extend<NO>(s: Step): Workflow<I, NO> {
    const keys = this.keys.uses === this.steps.length ? this.keys : KeyIndex.of(this.steps);
    keys.addStep(s); // throws before touching the index
    const steps = [...this.steps, s];
    seed = { steps, keys };
    return new Workflow<I, NO>(steps);
  }

  /** Add a sequential step (previous output becomes this step's input). */
  then<NO>(s: Step<O, NO>): Workflow<I, NO> {
    return this.extend<NO>(s);
  }

  /** Transform the previous output with a pure function (journaled → replay-safe). If no id is given, one is derived uniquely. */
  map<NO>(fn: (input: O) => NO | Promise<NO>, id?: string): Workflow<I, NO> {
    const mid = id ?? `map#${this.steps.length}`;
    const mapStep: Step<O, NO> = { id: mid, run: async (input) => fn(input) };
    return this.extend<NO>(mapStep);
  }

  /** Parallel steps (all receive the same input; output is `{ [stepId]: output }`). Each sub-step is journaled separately. */
  parallel(steps: Step<O, any>[], id?: string): Workflow<I, Record<string, any>> {
    // Legs share one journal namespace AND one output record keyed by leg id — a repeated id would
    // collide in both.
    assertUniqueStepIds(steps);
    // Position-unique, like `.map` above. A default derived only from CONTENT collides with itself:
    // two `.parallel` over the same sub-steps produced one journal key, so the second never ran and
    // the workflow returned the first one's output — silently.
    const pid = id ?? `parallel#${this.steps.length}(${steps.map((s) => s.id).join('+')})`;
    // The legs run in the same run, concurrently — no two of them may reach one key either.
    const legClaims = () => steps.map((s) => claimsOf(s, `${pid}/${s.id}`));
    assertDistinctKeys(legClaims());
    const composite: Step<O, Record<string, any>> = {
      id: pid,
      run: async (input, ctx) => {
        const entries = await Promise.all(
          // Journal each leg under THIS parallel, for the same reason as branch above: the legs are
          // the caller's steps and may appear in more than one parallel. The returned record is still
          // keyed by the leg's own id, so the output shape does not change.
          // FAZ-1: carry the leg's durability — rebuilding the step as a bare {id, run} silently
          // dropped the claim protocol for a leg the user EXPLICITLY marked sideEffect (heyet blokeri).
          steps.map(async (s) => [s.id, await runStep({ id: `${pid}/${s.id}`, run: s.run, ...(s.durability ? { durability: s.durability } : {}) }, input, ctx)] as const),
        );
        return Object.fromEntries(entries);
      },
    };
    BODIES.set(composite.run, { kind: 'composite', id: pid, claims: () => legClaims().flat() });
    return this.extend<Record<string, any>>(composite);
  }

  /** Conditional branch: cond(input) ? ifStep : elseStep. */
  branch<NO>(cond: (input: O) => boolean, ifStep: Step<O, NO>, elseStep: Step<O, NO>, id?: string): Workflow<I, NO> {
    const bid = id ?? `branch#${this.steps.length}(${ifStep.id}|${elseStep.id})`;
    const composite: Step<O, NO> = {
      id: bid,
      run: async (input, ctx) => {
        // Scope the chosen arm under this branch. The arms are the caller's own steps, so reusing one
        // step object in two branches would otherwise put both under its own id and replay the first.
        const arm = cond(input) ? ifStep : elseStep;
        // FAZ-1: same durability carry as parallel above — an arm marked sideEffect keeps its claim.
        return runStep({ id: `${bid}/${arm.id}`, run: arm.run, ...(arm.durability ? { durability: arm.durability } : {}) }, input, ctx);
      },
    };
    // Only one arm runs per input, so the arms are not checked against each other — only against the
    // rest of the workflow.
    BODIES.set(composite.run, { kind: 'composite', id: bid, claims: () => [...claimsOf(ifStep, `${bid}/${ifStep.id}`), ...claimsOf(elseStep, `${bid}/${elseStep.id}`)] });
    return this.extend<NO>(composite);
  }

  /** Run `run` for each item (journaled separately per item → completed ones are skipped on resume).
   * FAZ-1 note: the iteration body is a bare function — it has NO StepDurability surface, so a
   * side-effecting body is NOT claim-protected here (a crash after the effect re-runs that index on
   * resume). Need the claim protocol per item? Put the effect in a `step(..., {sideEffect:true})`
   * inside a nested workflow via `asStep`, or make the body idempotent (carry ctx.idempotencyKey +
   * the index to the external call). Same applies to loop/dowhile/dountil below. */
  foreach<IT, OT>(
    itemsOf: IT[] | ((input: O) => IT[]),
    run: (item: IT, index: number, ctx: StepCtx) => Promise<OT>,
    id?: string,
  ): Workflow<I, OT[]> {
    const fid = id ?? `foreach#${this.steps.length}`;
    const composite: Step<O, OT[]> = {
      id: fid,
      run: async (input, ctx) => {
        const list = typeof itemsOf === 'function' ? (itemsOf as (i: O) => IT[])(input) : itemsOf;
        const out: OT[] = [];
        for (let i = 0; i < list.length; i++) {
          out.push(await runStep({ id: `${fid}[${i}]`, run: (it, c) => run(it, i, c) }, list[i], ctx));
        }
        return out;
      },
    };
    BODIES.set(composite.run, { kind: 'composite', id: fid, claims: () => [{ key: fid, kind: 'foreach', from: `the items of foreach '${fid}'`, fix: `give foreach '${fid}' another id`, owner: fid }] });
    return this.extend<OT[]>(composite);
  }

  /** Repeat `run` while `cond` is true (each round journaled separately). */
  loop(
    run: (input: O, iter: number, ctx: StepCtx) => Promise<O>,
    cond: (output: O, iter: number) => boolean,
    opts: { id?: string; maxIters?: number } = {},
  ): Workflow<I, O> {
    const id = opts.id ?? `loop#${this.steps.length}`;
    const max = opts.maxIters ?? 100;
    const composite: Step<O, O> = {
      id,
      run: async (input, ctx) => {
        let cur = input;
        for (let iter = 0; iter < max; iter++) {
          cur = await runStep({ id: `${id}#${iter}`, run: (inp, c) => run(inp, iter, c) }, cur, ctx);
          if (!cond(cur, iter)) break;
        }
        return cur;
      },
    };
    BODIES.set(composite.run, { kind: 'composite', id, claims: () => [{ key: id, kind: 'loop', from: `the rounds of loop '${id}'`, fix: `give loop '${id}' another id`, owner: id }] });
    return this.extend<O>(composite);
  }

  /** Common workflow-DSL `.dowhile` semantics: run `run` at least once, repeat while `cond` stays TRUE.
   * Each round journaled separately (`dowhile#<iter>`) → completed rounds don't re-run on crash/resume. */
  dowhile(
    run: (input: O, iter: number, ctx: StepCtx) => Promise<O>,
    cond: (output: O, iter: number) => boolean,
    opts: { id?: string; maxIters?: number } = {},
  ): Workflow<I, O> {
    return this.loop(run, cond, { id: opts.id ?? `dowhile#${this.steps.length}`, maxIters: opts.maxIters });
  }

  /** Common workflow-DSL `.dountil` semantics: run `run` at least once, repeat UNTIL `cond` becomes TRUE. */
  dountil(
    run: (input: O, iter: number, ctx: StepCtx) => Promise<O>,
    cond: (output: O, iter: number) => boolean,
    opts: { id?: string; maxIters?: number } = {},
  ): Workflow<I, O> {
    return this.loop(run, (o, i) => !cond(o, i), { id: opts.id ?? `dountil#${this.steps.length}`, maxIters: opts.maxIters });
  }

  build(): Step[] {
    return this.steps;
  }

  /** Run the workflow durably. Calling again with the same runId = resume (completed steps don't re-run).
   * Note: if it contains a suspending step (sleep/waitFor), use `runResumable` (run() throws the suspend). */
  async run(input: I, entry: WorkflowEntryCtx): Promise<O> {
    const ctx = withIdentity(entry);
    let cur: any = input;
    for (const s of this.steps) cur = await runStep(s, cur, ctx);
    return cur as O;
  }

  /**
   * Suspend-aware execution: if a step suspends via `suspendWorkflow` (sleep/waitFor/waitForResume),
   * it writes to the journal and returns `{status:'suspended'}`. Calling again with the same runId =
   * resume → completed steps replay, the suspended step is re-evaluated (continues if the event
   * arrived / time elapsed / a resume payload was delivered). Evented + scheduled.
   *
   * Step-through debug: if `opts.maxSteps` is given, only the FIRST maxSteps steps (position-based)
   * run; if a step remains, it returns `{status:'paused', stepId}`. To continue, call again with the
   * same runId and maxSteps+1: earlier steps REPLAY from the journal (don't re-run), only the next
   * step actually runs.
   *
   * P0.4 additions:
   * `opts.resume` — typed resume payloads: `{ [waitId]: payload }` is journaled BEFORE any step
   *   runs, then read by the suspended step via `ctx.resumeData(waitId)` / `waitForResume`. This is
   *   the "resume step X with THIS approver decision" HITL primitive: the payload travels through the
   *   journal, so a crash between delivery and consumption loses nothing, and replay is deterministic.
   * `opts.signal` — in-process cancellation: checked between steps (and exposed as `ctx.signal` for
   *   steps to observe); an abort marks the run canceled DURABLY (see below).
   * Durable cancel: `cancelWorkflowRun()` writes a `_canceled` journal flag — checked here BEFORE
   * EVERY step, so cancellation reaches runs on OTHER workers at their next step boundary, and a
   *   canceled run REFUSES to resume forever after (same terminal-refusal principle as
   *   @gnldev/durable's compensated runs). Cancel never deletes journal state — completed steps stay
   *   replayable/inspectable; the run just stops producing new work.
   * Status registry: every terminal/suspend transition is mirrored to a top-level `wfrun:<runId>`
   *   record → `listWorkflowRuns` answers "which runs are suspended right now, on which step,
   *   waiting for which waitId" in ONE prefix scan.
   */
  async runResumable(
    input: I,
    entry: WorkflowEntryCtx,
    opts: {
      maxSteps?: number;
      resume?: Record<string, unknown>;
      signal?: AbortSignal;
      /**
       * FLOW-08: the workflow's registered name, mirrored into the `wfrun:` status record (see
       * `putStatus`) so `listWorkflowRuns`/the studio run list can display it without the caller
       * re-deriving it from the runId. Purely additive — the `Workflow` class itself still doesn't
       * carry a name (its constructor stays name-less); callers that know the name (e.g.
       * @gnldev/durable's `runWorkflow`, which registers workflows by name) pass it here. Omitted =
       * today's behavior exactly (no field written to the record).
       */
      workflowName?: string;
    } = {},
  ): Promise<WorkflowResult<O>> {
    const ctx = withIdentity(entry);
    const limit = opts.maxSteps ?? Infinity;
    const journal = ctx.journal;
    // Deliver typed resume payloads FIRST (plain put — before consumption an operator may overwrite a
    // wrong payload with a corrected one; after consumption the step's journaled output wins anyway).
    for (const [waitId, payload] of Object.entries(opts.resume ?? {})) {
      await journal.put(resumeKey(ctx.runId, waitId), payload);
    }
    // Engine-injected ctx capabilities (spread-safe: asStep's `{...ctx, keyPrefix}` propagates them).
    const ctx2: StepCtx = {
      ...ctx,
      ...(opts.signal ? { signal: opts.signal } : {}),
      resumeData: <T,>(waitId: string) => journal.get<T>(resumeKey(ctx.runId, waitId)),
    };
    let cur: any = input;
    for (let i = 0; i < this.steps.length; i++) {
      // P0.4 cancel — checked at EVERY step boundary: the durable flag (cross-process; one cheap point
      // read per step) and the in-process signal. Order matters: the flag wins even if the signal is
      // quiet (another worker/operator canceled), and an in-process abort is made durable immediately.
      const flag = await journal.get<{ reason?: unknown }>(canceledKey(ctx.runId));
      if (flag !== undefined || opts.signal?.aborted) {
        if (flag === undefined) await journal.put(canceledKey(ctx.runId), { at: Date.now(), reason: 'signal' });
        const reason = flag?.reason ?? 'signal';
        await this.putStatus(journal, ctx.runId, { status: 'canceled', stepId: this.steps[i]!.id, reason }, opts.workflowName);
        return { status: 'canceled', stepId: this.steps[i]!.id, reason };
      }
      if (i >= limit) return { status: 'paused', stepId: this.steps[i]!.id, partial: cur };
      const s = this.steps[i]!;
      try {
        cur = await runStep(s, cur, ctx2);
      } catch (e) {
        if (e instanceof WorkflowSuspended) {
          await journal.put(`${ctx.runId}:wf:_suspend`, { stepId: s.id, waitId: e.waitId, reason: e.reason });
          await this.putStatus(journal, ctx.runId, { status: 'suspended', stepId: s.id, waitId: e.waitId, reason: e.reason }, opts.workflowName);
          return { status: 'suspended', stepId: s.id, waitId: e.waitId, reason: e.reason };
        }
        throw e;
      }
    }
    await this.putStatus(journal, ctx.runId, { status: 'completed' }, opts.workflowName);
    return { status: 'completed', output: cur as O };
  }

  /** Status-registry mirror — best-effort (a registry write failure must not fail the run itself).
   * FLOW-08: `workflowName` (from `runResumable`'s opts) is mirrored in ONLY when the caller passed
   *  one — omitted entirely otherwise, so a `wfrun:` record written without a name is byte-for-byte
   *  identical to pre-FLOW-08 records (backward compatible with readers of the old shape). */
  private async putStatus(
    journal: JournalLike,
    runId: string,
    s: Omit<WorkflowRunStatus, 'runId' | 'updatedAt' | 'workflowName'>,
    workflowName?: string,
  ): Promise<void> {
    try {
      await journal.put(statusKey(runId), {
        ...s,
        runId,
        ...(workflowName !== undefined ? { workflowName } : {}),
        updatedAt: Date.now(),
      } satisfies WorkflowRunStatus);
    } catch { /* advisory registry — the WorkflowResult return value is the source of truth */ }
  }
}

export type WorkflowResult<O = any> =
  | { status: 'completed'; output: O }
  | { status: 'suspended'; stepId: string; waitId?: string; reason?: unknown }
  /** Step-through: the maxSteps limit was reached — `stepId` is the NEXT (not yet run) step; `partial` is the output up to that point. */
  | { status: 'paused'; stepId: string; partial: unknown }
  /** P0.4: the run was canceled (durable `_canceled` flag or opts.signal) — `stepId` is the step that would have run next. Terminal: resuming returns `canceled` again. */
  | { status: 'canceled'; stepId?: string; reason?: unknown };

/** Signal that lets a step suspend the workflow (thrown by sleep/waitFor). */
export class WorkflowSuspended extends Error {
  constructor(public readonly waitId: string, public readonly reason?: unknown) {
    super(`workflow suspended: ${waitId}`);
    this.name = 'WorkflowSuspended';
  }
}

/** Suspend the workflow from a running step. Caught by `runResumable`; the step is retried on resume. */
export function suspendWorkflow(waitId: string, reason?: unknown): never {
  throw new WorkflowSuspended(waitId, reason);
}

/** Durable step that waits until a specific time (scheduled). Suspends if the time hasn't elapsed yet. */
export function sleep(id: string, untilMs: number): Step {
  return {
    id,
    run: async () => {
      if (Date.now() < untilMs) suspendWorkflow(id, { kind: 'time', untilMs });
      return { sleptUntil: untilMs };
    },
  };
}

/**
 * P0.4 — typed HITL resume: a durable step that suspends until a resume payload for `id` (its waitId)
 * is delivered via `runResumable(input, ctx, { resume: { [id]: payload } })`, then returns that
 * payload as the step's output. THE "resume step X with THIS approver decision" primitive.
 *
 * `validate` (optional): parses/narrows the raw payload — pass e.g. a zod schema's `.parse` (the
 * package stays zero-dependency; any `(v: unknown) => T` works). A validation THROW fails the run
 * WITHOUT consuming anything: the payload stays in the journal, the step has no journaled output, so
 * the operator can overwrite it with a corrected payload (`resume` again) and re-resume.
 *
 * Determinism: the payload is read from the journal, and once this step completes its OUTPUT is
 * journaled — replay never re-reads (or re-validates) the payload.
 */
export function waitForResume<T = unknown>(
  id: string,
  opts: { validate?: (v: unknown) => T; reason?: unknown } = {},
): Step<any, T> {
  const gate: Step<any, T> = {
    id,
    run: async (_input, ctx) => {
      const v = ctx.resumeData ? await ctx.resumeData(id) : undefined;
      if (v === undefined) suspendWorkflow(id, opts.reason ?? { kind: 'resume' });
      return opts.validate ? opts.validate(v) : (v as T);
    },
  };
  // The payload key is one per run, whatever nests the gate: two uses of it — the same nested workflow
  // under two asSteps, a renamed copy — would both open on one resume.
  BODIES.set(gate.run, {
    kind: 'wait',
    id,
    claims: () => [{
      key: `_resume:${id}`,
      kind: 'exact',
      from: `the resume payload of waitForResume('${id}')`,
      fix: `give the second gate its own waitId, waitForResume('${id}-2') — waitIds are one namespace per run, not scoped by asStep, so an operator can resume a gate without knowing where it is nested`,
      owner: id,
      engine: true,
      runWide: true,
      effect: 'so one resume would open both gates',
    }],
  });
  return gate;
}

// ── P0.4 — durable cancel + suspended-run registry ─────────────────────────────

/** One workflow run's registry record (the top-level `wfrun:<runId>` key — see `statusKey`'s JSDoc). */
export interface WorkflowRunStatus {
  runId: string;
  status: 'suspended' | 'completed' | 'canceled';
  /** Suspended: the step waiting. Canceled: the step that would have run next. */
  stepId?: string;
  /** Suspended: the waitId to address in `runResumable({ resume: { [waitId]: … } })`. */
  waitId?: string;
  reason?: unknown;
  /** FLOW-08: the workflow's registered name (from `runResumable`'s opts), when the caller provided
   *  one. Absent on records written before FLOW-08 or when the caller didn't pass a name. */
  workflowName?: string;
  updatedAt: number;
}

/**
 * Durably cancels a workflow run: writes the `_canceled` flag (checked by `runResumable` before EVERY
 * step — reaches runs in-flight on OTHER workers at their next step boundary) and mirrors the registry
 * record. Terminal: a canceled run refuses to resume forever after (same principle as @gnldev/durable's
 * compensated-run refusal). Never deletes journal state — completed steps stay replayable/inspectable.
 * Returns `false` (no-op) if the run had already COMPLETED (nothing left to cancel); `true` otherwise
 * (idempotent — canceling an already-canceled run is `true` again).
 */
/**
 * Forks a workflow run at a step — the workflow twin of @gnldev/durable's `forkRun`.
 *
 * The substrate has carried this all along: every step's output already sits in the journal under
 * `<runId>:wf:<stepId>`, exactly-once. What was missing was only the wiring:
 * copy the recorded outputs of every step BEFORE the fork point to a new runId, run the workflow
 * under that id, and `runStep`'s cache check replays the prefix while everything from `fromStepId`
 * on executes for real.
 *
 * Honest bounds, stated rather than discovered:
 *  · order comes from `build()`, so the copied prefix is exact for sequential flows; the keys a
 *    kept step writes besides its own output (an `asStep`'s nested steps, parallel legs, branch
 *    arms, loop rounds, foreach items — see `stepOwnerOf`) are swept in when the journal has
 *    `listKeys`, best-effort without it. `forkedStepKeys` decides what travels.
 *  · the ORIGINAL INPUT is not recorded by the engine, so the caller passes it again when running
 *    the fork. For a fork past step 0 it only feeds already-cached steps and is inert.
 *  · retry counters are deliberately NOT copied — a forked step deserves its full retry budget.
 *  · FAZ-1: `:_claim` records are NOT copied either (the `:_` sweep skip) — the fork gets a fresh
 *    Claim budget. Corollary the operator must own: forking AT a step whose source run is blocked
 *    'unresolved' (crash-window) side-steps that protection — the fork re-runs the step under a NEW
 *    IdempotencyKey, so the effect can fire a second time. Verify the external system first.
 */
export async function forkWorkflowRun(
  journal: JournalLike,
  wf: { build(): { id: string }[] },
  srcRunId: string,
  fromStepId: string,
  dstRunId: string,
): Promise<{ dstRunId: string; copiedSteps: string[] }> {
  const order = wf.build().map((s) => s.id);
  const at = order.indexOf(fromStepId);
  if (at < 0) {
    throw new Error(`forkWorkflowRun: step '${fromStepId}' is not in this workflow. Steps: ${order.join(' → ')}`);
  }
  // A destination that already has records would silently MERGE two histories — the reader of the
  // forked run could no longer tell which parts came from where. Refused instead. Probed at the
  // STEP keys, not only the registry record: a plain `run()` journals its steps without writing a
  // `wfrun:` record, and the registry-only check sailed straight past exactly that case in test.
  if ((await journal.get(statusKey(dstRunId))) !== undefined) {
    throw new Error(`forkWorkflowRun: '${dstRunId}' already has a workflow run recorded — pick a fresh id`);
  }
  for (const id of order) {
    if ((await journal.get(`${dstRunId}:wf:${id}`)) !== undefined) {
      throw new Error(`forkWorkflowRun: '${dstRunId}' already has step records — a fork must start from a fresh id, not merge into an existing run`);
    }
  }

  const kept = order.slice(0, at);
  // Which keys travel is decided by `forkedStepKeys`, the one rule every fork path uses (Studio's
  // fork door keeps a pinned copy, held to this one by a parity test). Without `listKeys` the only
  // keys this can know are each kept step's own output and its fallback marker — best-effort, as
  // documented above.
  const rests = journal.listKeys
    ? (await journal.listKeys(`${srcRunId}:wf:`)).map((k) => k.slice(`${srcRunId}:wf:`.length))
    : kept.flatMap((id) => [id, `${id}:_fallback`]);
  // A listed key that holds nothing is not a record (a store may list a key it holds `undefined`
  // under), so the rule is asked twice: once to know what to read, once over what was actually there —
  // which is how a fallback marker whose output is gone stays behind.
  const held = new Map<string, unknown>();
  for (const rest of forkedStepKeys(rests, order, kept)) {
    const v = await journal.get(`${srcRunId}:wf:${rest}`);
    if (v !== undefined) held.set(rest, v);
  }
  const copied = new Set<string>();
  for (const rest of forkedStepKeys(held.keys(), order, kept)) {
    await journal.put(`${dstRunId}:wf:${rest}`, held.get(rest));
    copied.add(rest);
  }
  const copiedSteps = kept.filter((id) => copied.has(id));
  // The registry record, so the fork is FINDABLE and says where it came from.
  await journal.put(statusKey(dstRunId), {
    runId: dstRunId, status: 'forked', forkedFrom: { runId: srcRunId, fromStepId }, at: Date.now(),
  });
  return { dstRunId, copiedSteps };
}

/**
 * The top-level step a `<runId>:wf:<rest>` key belongs to, or `undefined` when it belongs to none
 * (the engine's run-wide records: `_suspend`, `_resume:<waitId>`, …).
 *
 * The ONE rule for "whose key is this". A top-level step `s` writes `s` itself and keys that continue
 * `s` with a separator the engine scopes under it: `s:<inner>` (an asStep's nested steps, a retry's
 * counter and marker, a side-effect claim), `s/<leg>` (a parallel leg, a branch arm), `s#<n>` (a loop
 * round), `s[<n>]` (a foreach item). An id may itself contain those separators (`a:x` beside `a`),
 * so the LONGEST id that the key is or continues wins — a fork that keeps `a` must not take `a:x`.
 * The builder refuses two uses that reach one key, so the answer is unique for a built workflow.
 *
 * Bound: a retry's fallback step is journaled under its OWN id, not under the retried step's, so its
 * key belongs to no top-level step here unless the fallback's id is one.
 */
export function stepOwnerOf(rest: string, stepIds: ReadonlySet<string>): string | undefined {
  if (stepIds.has(rest)) return rest;
  for (let i = rest.length - 1; i > 0; i--) {
    const ch = rest.charCodeAt(i);
    // ':' '/' '#' '['
    if (ch !== 58 && ch !== 47 && ch !== 35 && ch !== 91) continue;
    const head = rest.slice(0, i);
    if (stepIds.has(head)) return head;
  }
  return undefined;
}

/**
 * The keys a fork copies: given every key a source run holds under `<runId>:wf:` (the part after it),
 * the workflow's top-level step ids in order, and the steps the fork keeps, the keys that travel.
 *
 * The ONE decision for every fork path — `forkWorkflowRun`, and Studio's fork door through a pinned
 * copy. A key travels when it is not an engine record (`isEngineRecordKey`) and its owner
 * (`stepOwnerOf`) is kept. A fallback marker `<k>:_fallback` travels with the output it describes,
 * `<k>`, and only with it: a provenance record must not outlive its subject. Retry counters and
 * side-effect claims never travel — a forked step gets its full retry budget and a fresh claim.
 */
export function forkedStepKeys(rests: Iterable<string>, stepIds: readonly string[], kept: Iterable<string>): string[] {
  const ids = new Set(stepIds);
  const keep = new Set(kept);
  const all = new Set(rests);
  const travels = (rest: string) => !isEngineRecordKey(rest) && keep.has(stepOwnerOf(rest, ids) as string);
  const out: string[] = [];
  for (const rest of all) {
    if (rest.endsWith(':_fallback')) {
      const subject = rest.slice(0, -':_fallback'.length);
      if (all.has(subject) && travels(subject)) out.push(rest);
    } else if (travels(rest)) out.push(rest);
  }
  return out;
}

export async function cancelWorkflowRun(
  journal: JournalLike,
  runId: string,
  opts: { reason?: unknown } = {},
): Promise<boolean> {
  const st = await journal.get<WorkflowRunStatus>(statusKey(runId));
  if (st?.status === 'completed') return false;
  await journal.put(canceledKey(runId), { at: Date.now(), ...(opts.reason !== undefined ? { reason: opts.reason } : {}) });
  await journal.put(statusKey(runId), {
    runId,
    status: 'canceled',
    ...(st?.stepId ? { stepId: st.stepId } : {}),
    // FLOW-08: carry the name forward from the existing record (same pattern as stepId above) —
    // an external cancelWorkflowRun() call doesn't know the name itself, only runResumable does.
    ...(st?.workflowName ? { workflowName: st.workflowName } : {}),
    ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
    updatedAt: Date.now(),
  } satisfies WorkflowRunStatus);
  return true;
}

/** Reads one run's registry record (undefined: the run never wrote one — pre-P0.4, or still mid-flight without a suspend). */
export async function getWorkflowRunStatus(journal: JournalLike, runId: string): Promise<WorkflowRunStatus | undefined> {
  return journal.get<WorkflowRunStatus>(statusKey(runId));
}

/**
 * The suspended-run registry query: every workflow run's registry record in ONE `wfrun:` prefix scan,
 * optionally filtered by status — answers "which runs are suspended right now, on which step, waiting
 * for which waitId" without touching any run's journal. Requires `listKeys` (throws a clear error
 * otherwise — no silent empty answer that would read as "nothing suspended").
 */
export async function listWorkflowRuns(
  journal: JournalLike,
  opts: { status?: WorkflowRunStatus['status'] } = {},
): Promise<WorkflowRunStatus[]> {
  if (typeof journal.listKeys !== 'function') {
    throw new Error("@gnldev/workflow: listWorkflowRuns requires the journal to implement `listKeys` (see JournalLike) — without it the registry cannot be enumerated.");
  }
  const keys = await journal.listKeys(WFRUN_PRE);
  const out: WorkflowRunStatus[] = [];
  for (const k of keys) {
    const st = await journal.get<WorkflowRunStatus>(k);
    if (st && (!opts.status || st.status === opts.status)) out.push(st);
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

/**
 * Durable step that waits until a condition (event) is satisfied. If `check` returns a value, that
 * becomes the step's output; if null/undefined, it suspends. `check` typically hooks into @gnldev/events
 * (e.g. searching for an event via listLog).
 */
export function waitFor<O = any>(
  id: string,
  check: (input: any, ctx: StepCtx) => Promise<O | null | undefined> | O | null | undefined,
): Step<any, O> {
  return {
    id,
    run: async (input, ctx) => {
      const v = await check(input, ctx);
      if (v == null) suspendWorkflow(id, { kind: 'event' });
      return v as O;
    },
  };
}

// ── Declarative retry-policy ("try N times → fallback") — common workflow retry-config semantics ──────────────

export interface RetryPolicy<I = any, O = any> {
  /** Total attempt count (including the first run, >=1). */
  attempts: number;
  /** Wait between attempts: a fixed ms value or a function computed from the attempt index (1-based). */
  backoffMs?: number | ((attempt: number) => number);
  /** Step to run when all attempts are exhausted (journaled under its own key). If omitted, throws RetryExhaustedError. */
  fallback?: Step<I, O>;
}

/** All attempts exhausted with no fallback — the last error is in `cause`. */
export class RetryExhaustedError extends Error {
  constructor(
    readonly stepId: string,
    readonly attempts: number,
    readonly cause?: unknown,
  ) {
    super(`@gnldev/workflow: '${stepId}' failed after ${attempts} attempts.`);
    this.name = 'RetryExhaustedError';
  }
}

// ── Retry counter read/write ──
// If the journal supports an atomic counter (incrBy + getCounters), use it: closes get→put's
// lost-update race (two workers can't read the same value and overwrite each other; increments
// accumulate). If not supported, falls back to the existing plain-value get→put path (single-process
// safe, behavior unchanged). Backward compatibility: older runs may have a counter written via plain
// `put` → the LARGER of the two sources is taken (the attempt count never rewinds).
const ATTEMPTS_FIELD = 'n';

async function readAttempts(journal: JournalLike, key: string): Promise<number> {
  const legacy = (await journal.get<number>(key)) ?? 0;
  if (journal.incrBy && journal.getCounters) {
    const c = await journal.getCounters(key);
    return Math.max(c?.[ATTEMPTS_FIELD] ?? 0, legacy);
  }
  return legacy;
}

async function bumpAttempts(journal: JournalLike, key: string, used: number): Promise<void> {
  if (journal.incrBy && journal.getCounters) {
    const counters = await journal.getCounters(key);
    if (counters?.[ATTEMPTS_FIELD] === undefined) {
      // First incrBy transition: the counter has never been initialized. At this point `used`
      // already includes legacy (if any) — readAttempts read Math.max(counter=0, legacy) at the
      // start of the call, and used has only grown by +1's since then — so seed the counter
      // DIRECTLY to `used` (one-time). That way subsequent resumes' Math.max(counter, legacy)
      // always yields the true total (counter now sits above legacy, even if legacy stays frozen).
      // The legacy FIELD itself is never written to — the "plain field untouched on the incrBy
      // path" contract (cas.test.ts) is preserved.
      await journal.incrBy(key, { [ATTEMPTS_FIELD]: used });
    } else {
      await journal.incrBy(key, { [ATTEMPTS_FIELD]: 1 });
    }
  } else {
    await journal.put(key, used);
  }
}

/**
 * Wraps a step with a retry-policy — drop-in: carries the same `id`, used everywhere in
 * `then/branch/parallel` just like an unwrapped step; a SUCCESSFUL output is still journaled
 * under the step's own key.
 *
 * Determinism/durable notes:
 * **The attempt counter lives in the journal** (`<runId>:wf:<id>:attempts`) → doesn't start over
 *   on crash-resume; the "total N attempts" guarantee is kept independent of process deaths. A step
 *   that was already exhausted in a previous run goes straight to the fallback (if any) on resume —
 *   it does NOT retry N more times.
 * **Suspension (WorkflowSuspended) is not an error** — it propagates outward as-is without consuming
 *   an attempt (sleep/waitFor work correctly inside retry too).
 * **The fallback is journaled separately** (`runStep(policy.fallback)`): if the fallback runs and
 *   then crashes, it does NOT re-run on resume. The step being retried must be idempotent if it has
 *   side effects, or use a durable tool internally (the INSIDE of an attempt is not journaled — only
 *   the counter and the final output are).
 */
export function retry<I = any, O = any>(s: Step<I, O>, policy: RetryPolicy<I, O>): Step<I, O> {
  if (!(policy.attempts >= 1)) throw new Error(`@gnldev/workflow: retry('${s.id}') requires attempts >= 1`);
  const retried: Step<I, O> = {
    id: s.id,
    // FAZ-1: the wrapper carries the wrapped step's durability — a sideEffect step keeps its
    // write-ahead claim under retry (the claim then covers the whole attempt sequence: one claim,
    // N in-process attempts, and a crash mid-sequence still resolves through recover/blocked).
    ...(s.durability ? { durability: s.durability as StepDurability } : {}),
    run: async (input, ctx) => {
      const attemptsKey = `${ctx.runId}:wf:${ctx.keyPrefix ?? ''}${s.id}:attempts`;
      let used = await readAttempts(ctx.journal, attemptsKey); // resume: consumed attempts are counted
      let lastErr: unknown;
      while (used < policy.attempts) {
        try {
          return await s.run(input, ctx);
        } catch (e) {
          if (e instanceof WorkflowSuspended) throw e; // suspension does NOT consume an attempt
          lastErr = e;
          used += 1;
          await bumpAttempts(ctx.journal, attemptsKey, used);
          // FAZ-1: a sideEffect step's throw leaves the effect UNCERTAIN — the exact ambiguity the
          // crash-window state machine refuses to guess about. An in-process re-fire must clear the
          // SAME bar: consult recover between attempts ({done:true} → that IS the step's output,
          // journaled by the caller; {done:false} → certified not-landed, the next attempt may fire).
          // Without recover there is no honest way to re-run a non-idempotent body — the error
          // propagates (the claim's `failed` stamp then routes the cross-process resume through the
          // same recover/blocked discipline).
          if (s.durability?.sideEffect) {
            if (!s.durability.recover) throw e;
            const idempotencyKey = ctx.idempotencyKey ?? `${ctx.runId}:wf:${ctx.keyPrefix ?? ''}${s.id}`;
            const r = await s.durability.recover(input, { idempotencyKey });
            assertRecoverShape(r, s.id);
            if (r.done) return r.output as O;
          }
          if (used < policy.attempts && policy.backoffMs != null) {
            const ms = typeof policy.backoffMs === 'function' ? policy.backoffMs(used) : policy.backoffMs;
            if (ms > 0) await new Promise((r) => setTimeout(r, ms));
          }
        }
      }
      if (policy.fallback) {
        const out = (await runStep(policy.fallback, input, ctx)) as O;
        // The fallback's output is written under the RETRIED step's id (this wrapper carries `s.id`),
        // so the record cannot say which of the two produced it: a "charged via provider A" step reads
        // identically whether it worked first time or failed twice and landed on provider B. The
        // `:attempts` counter next to it does not close the gap — it may live in a counter map rather
        // than a field, and the introspection in @gnldev/durable cannot import the reader that knows
        // the difference without a circular dependency.
        //
        // A plain `put` for that reason: whatever reads this only needs `journal.get`. Written after
        // the fallback, so a crash in between leaves no claim of a substitution that never ran; the
        // repeat on resume is a same-value overwrite.
        await ctx.journal.put(fallbackMarkerKey(ctx.runId, ctx.keyPrefix, s.id), {
          [FALLBACK_MARKER_BRAND]: true,
          attempts: used,
          stepId: policy.fallback.id,
        });
        return out;
      }
      throw new RetryExhaustedError(s.id, policy.attempts, lastErr);
    },
  };
  // The counter, the marker and the fallback's own record are written by the body, under `s.id` — the
  // id this retry was created with, whatever a renamed copy is later called. So the way to a second
  // use is a second retry around a renamed step, never a renamed copy of this one.
  const fix = `retry(step('${s.id}-2', <the retried step>.run), <the same policy>) — a renamed copy of the retry itself keeps its attempt counter at '${s.id}:attempts'`;
  const via = (usedAs: string) => (usedAs === s.id ? '' : ` (written by '${usedAs}', a renamed copy of the retry)`);
  BODIES.set(retried.run, {
    kind: 'retry',
    id: s.id,
    claims: (usedAs) => [
      ...(BODIES.get(s.run)?.claims(s.id) ?? []),
      { key: `${s.id}:attempts`, kind: 'exact', from: `retry('${s.id}')'s attempt counter${via(usedAs)}`, fix, owner: s.id, engine: true, effect: "so the second would spend the first one's attempts (and, once they are used up, never run)" },
      { key: `${s.id}:_fallback`, kind: 'exact', from: `retry('${s.id}')'s fallback marker${via(usedAs)}`, fix, owner: s.id, engine: true, effect: "so one use's record of a fallback would be read as the other's" },
      ...(policy.fallback
        ? claimsOf(policy.fallback).map((c) => ({ ...c, from: `${fromOf(c)} (the fallback of retry('${s.id}'))`, fix: `give the fallback '${policy.fallback!.id}' another id` }))
        : []),
    ],
  });
  return retried;
}

/** Start an empty workflow builder. */
export function workflow<I = any>(): Workflow<I, I> {
  return new Workflow<I, I>([]);
}

/**
 * Use a workflow as a NESTED step inside another workflow. Inner steps are namespaced via `keyPrefix`
 * (`${id}:`) → outer/inner steps with the same id don't collide. An inner suspend (sleep/waitFor)
 * propagates outward: the outer `runResumable` catches it, and on resume inner steps replay from
 * their prefixed keys.
 *   outer.then(asStep('payment', paymentWf))   // inner: ${runId}:wf:payment:checkFunds ...
 */
export function asStep<I = any, O = any>(id: string, wf: Workflow<I, O>): Step<I, O> {
  const nested: Step<I, O> = {
    id,
    run: (input, ctx) => wf.run(input as I, { ...ctx, keyPrefix: `${ctx.keyPrefix ?? ''}${id}:` }),
  };
  BODIES.set(nested.run, {
    kind: 'asStep',
    id,
    claims: () =>
      wf.build().flatMap((inner) => claimsOf(inner)).map((c) =>
        c.runWide
          ? { ...c, from: `${fromOf(c)} inside asStep('${id}')` }
          : {
              ...c,
              key: `${id}:${c.key}`,
              from: `${fromOf(c)} inside asStep('${id}')`,
              fix: `give the nested workflow its own id: asStep('${id}-2', <the same workflow>)`,
            },
      ),
  });
  return nested;
}
