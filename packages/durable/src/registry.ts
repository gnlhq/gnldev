import { nestedAgentRunId } from './journal.js';
import { seedLimits } from './limits.js';
import { randomUUID } from 'node:crypto';

let wfAnonCounter = 0; // runWorkflow's anon-fallback uniqueness within a process — see the warn below
import type { ToolSchemaRuleLike } from './types.js';
import { decodeStepRecord } from './step-record.js';
import { stepCountIs, tool as aiTool, jsonSchema } from 'ai';
import { runDurable, streamDurable } from './run.js';
import type { StreamBreach } from './run.js';
import { resolveModel, withModelFallback, type FallbackCandidate } from './model-router.js';
import { delegationTool, runDelegated, type ChildFrame, childOutcome } from './agent-tool.js';
import { assertNoCallerSystemMessage } from './request-body.js';
import { runNetworkAdmitted as runNetworkCore, type NetworkResult, type NetworkTarget } from './network.js';
import { acquireRunLock } from './run-lock.js';
import { claim as journalClaim, runKeys } from './journal.js';
import { argsHash, derivedRunId, DEPLOYMENT_SCOPE, type WorkScope, type WorkScopeKind } from './hash.js';
import { RunBusyError, runBusyMessage, RunSweptError, RunInputMismatchError, RunOwnerMismatchError, ThreadOwnerMismatchError } from './errors.js';
import { admitThreadRun } from './thread-owner.js';
import { user, staff, callerOf, callerFromResourceId, userIdOf, resolveCaller, identityOf, runIdentity, admitRun, childIdentity, requestOf, type Caller, type RunIdentity } from './run-identity.js';
import { recordIdemConflict } from './idem-ledger.js';
import { runScoreSample, assertDistinctScorerNames, scoreRunMemoized } from './scoring.js';
import { recordRunScores } from './metrics.js';
import { assertSuiteConsistent } from './suite-consistency.js';
import { createSuggestions, validateSuggestionsConfig } from './suggestions.js';
import { PRESET_MATRIX, PRESET_DEFAULT } from './policy-matrix.js';
import type { SuggestionsApi, SuggestionsConfig } from './suggestions.js';

import type { Journal } from './journal.js';
import type { Storage } from './storage.js';
import type { Guard } from './guard.js';
import type { Memory } from './memory.js';
import type { ModelInput, ToolSet } from './types.js';
import type { Processor } from './processor.js';
import type { RunLimits } from './limits.js';
import { refuseUnknownNames } from '@gnldev/options';
import type { DetachedRuns, DetachedRunsOptions, ExecRecord, Launch, LaunchEnd } from './detached.js';
import { executorFor } from './executors.js';
import { followedRun } from './followed-run.js';
import { lastRunEvent, readCursor } from './run-events.js';
import { streamable } from './generate-as-stream.js';
import { errorOf } from './event-codec.js';
import { admitAgentRun } from './run.js';
import { RunCanceledError } from './cancel.js';
import { runOwnerOf } from './run-identity.js';
import { orgScopeOf } from './organization.js';
import type { ProcessLiveness } from './process-liveness.js';
import { refuseCreateGnlNames, refuseRunNames, WORKFLOW_RUN_NAMES, TOOL_DURABILITY_NAMES, CANCEL_RUN_NAMES } from './option-names.js';
import { deferredTaskRunId, deferredContinuationRunId } from './journal.js';
import { minted, withMintOf, runIdFamilyOf, isDerivedRunId, runRecordKey } from './run-id-grammar.js';
import { erasureBaseline, assertNotErased } from './erasure-fence.js';
import { encodeTaskSpec, decodeTaskSpec, taskModel, taskOutcome, continuationPrompt, takeThreadTurn, toolCallIdOf, type TaskSpec } from './deferred.js';
import type { AnyTool } from './types.js';
import type { GnlToolContext } from './identity-types.js';

// Registry/DI: a single top-level `createGnl({...})` factory. Register agents/tools, run durably by name.

/** Request context (the common "requestContext" pattern): per-call values like organization/role/user. */
export type RequestContext = Record<string, unknown>;

/**
 * P1.7 reserved request-context keys that only SERVER-SIDE code is allowed to
 * fill in (see sealRequestContext below) — mirror of the common "reserved resource-id key" convention,
 * where a reserved requestContext key carries the AUTHENTICATED resourceId so a client-supplied value
 * in the request body can never impersonate another organization/user.
 */
export const GNL_RESOURCE_ID_KEY = '__gnl_resourceId';
export const GNL_ORG_ID_KEY = '__gnl_orgId';
export const GNL_THREAD_ID_KEY = '__gnl_threadId';
/** The server's seal for an operator/system call: an EXPLICIT staff caller (run-identity.ts). */
export const GNL_STAFF_KEY = '__gnl_staff';
/**
 * Set by sealRequestContext (non-enumerable): this call came through a door — a request — not from the
 * host's own code. The engine refuses a system message on such a call (request-body.ts).
 */
export const GNL_DOOR_KEY = '__gnl_door';

/**
 * Plain keys the SERVER also derives, and which a client therefore must not be able to supply.
 *
 * The seal covered the three `__gnl_*` keys and stopped there, but `@gnldev/server` documents and
 * injects a plain `org` alongside them ("the resolved organization is injected into requestContext as
 * `org`, visible to dynamic agents"), and dynamic `system`/`model`/`tools` functions read it. When no
 * organization resolves for a request — the shared-scope path, which is every request on a deployment
 * that has not configured `org` — a body carrying `context: { org: 'victim' }` reached those functions
 * verbatim. The seal existed to close exactly that class and missed the one key it had published.
 */
const RESERVED_CONTEXT_KEYS = [GNL_RESOURCE_ID_KEY, GNL_ORG_ID_KEY, GNL_THREAD_ID_KEY, GNL_STAFF_KEY, GNL_DOOR_KEY, 'org'] as const;

/**
 * Writes an OWN property, ignoring the prototype chain.
 *
 * Plain assignment does not: `[[Set]]` walks the prototype before it will create an own property, so
 * a polluted `Object.prototype` decides what happens. Measured against the four shapes an attacker
 * can install, with the server having ALREADY resolved a real identity (`resourceId: 'real-user'`):
 *
 *   data property   ->  "real-user"    the own write lands; only this shape was ever handled
 *   accessor pair   ->  "victim-user"  inherited setter swallows the write, getter answers instead
 *   getter-only     ->  TypeError      "Cannot set property ... which has only a getter"
 *   non-writable    ->  TypeError      "Cannot assign to read only property"
 *
 * The accessor-pair row is the whole point: the server's authenticated identity is silently discarded
 * and `serverIdentityOf` then reports the attacker's value — the exact P1.7 hijack the seal exists to
 * prevent, reachable again through a route the seal never considered. The two TypeError rows land
 * inside `try` blocks in `@gnldev/server`, so they degrade to a 400 on every request.
 *
 * `defineProperty` defines on the object itself and never consults the prototype, so all four shapes
 * behave identically to the unpolluted case. The descriptor matches what assignment would have
 * produced (enumerable/writable/configurable) so nothing downstream — spread, `Object.keys`,
 * `JSON.stringify` — can tell the difference.
 */
function define(target: RequestContext, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/** Whether a request context was sealed by a door (see GNL_DOOR_KEY). */
function cameThroughDoor(context: RequestContext | undefined): boolean {
  return context !== undefined && (context as Record<string, unknown>)[GNL_DOOR_KEY] === true;
}

/**
 * P1.7 seals a request context against the cross-organization hijack class where a
 * client-supplied `context.__gnl_resourceId`/`__gnl_orgId`/`__gnl_threadId` in the request body would
 * otherwise be indistinguishable from a value the SERVER derived from the authenticated identity — a
 * client could smuggle `{ context: { __gnl_resourceId: 'victim-user' } }` and have it silently win
 * downstream (memory lookup, dynamic model/system resolution), reading/writing another organization's data.
 * Mirrors the common "reserved resource-id key" design: a reserved requestContext key that only server code
 * writes, so a client can never override its own identity through the request body.
 *
 * ALWAYS overwrites the three reserved keys — even a key `server` has NO value for is stripped from the
 * client-supplied context (deleted, never left as `undefined` either): a spoofed key must not survive by
 * omission just because the server didn't happen to supply that particular field this call.
 * @internal — door plumbing shared by the GNL doors; gnl builds its argument, no host writes it.
 */
export function sealRequestContext(
  ctx: RequestContext,
  server: { resourceId?: string; orgId?: string; threadId?: string; staff?: boolean },
): RequestContext {
  const sealed: RequestContext = { ...ctx };
  // A JSON body cannot pollute `Object.prototype` through this function — spread copies `__proto__`
  // as an inert own DATA property — but it does not follow that the key is harmless to pass on. This
  // context is handed to user-written dynamic `system`/`model`/`tools` functions and to tool code, and
  // an ordinary merge there re-arms it, because `Object.assign` writes with `[[Set]]`:
  //
  //   body    {"context": {"a": 1, "__proto__": {"isAdmin": true}}}
  //   sealed  own keys ["a","__proto__","__gnl_orgId","org"]   sealed.isAdmin -> undefined
  //   Object.assign({}, sealed)                                 .isAdmin      -> true   (prototype set)
  //
  // So the seal was handing a live payload to every consumer and relying on none of them using the
  // one-line merge. Dropped here: no legitimate request context carries `__proto__` as data, and this
  // is the function whose whole job is making the context safe to pass onward.
  //
  // SHALLOW, and deliberately so — `context: { profile: { __proto__: {...} } }` still arms
  // `Object.assign({}, ctx.profile)` one level down, and neither `structuredClone` nor a JSON round
  // trip strips it (measured). Closing that means recursively rewriting arbitrary caller data on every
  // request, which is a larger behavioural change than the residual warrants. `__proto__` is the ONLY
  // accessor on `Object.prototype` (surveyed, and pinned by a test that fails if a runtime adds a
  // second), so `constructor`/`toString`/`valueOf` merge into plain own properties and escalate
  // nothing — a surviving `toString` key does make `String(merged)` throw, which is a crash, not a
  // privilege. Consumers must not `Object.assign` untrusted SUB-objects of a request context.
  delete sealed['__proto__'];
  // Stripped from the LIST, not one `delete` per key. The three `__gnl_*` keys were deleted here by
  // hand while a fourth reserved key — the plain `org` that @gnldev/server publishes to dynamic agents
  // — went on arriving from the request body. A rule written out per key is a rule that grows a hole
  // the moment a fifth key is published.
  for (const k of RESERVED_CONTEXT_KEYS) {
    delete sealed[k];
    // `delete` removes the OWN property only, so a reserved key inherited from a polluted
    // `Object.prototype` survives it and reads back exactly like a value the server set. Shadowed with
    // an own `undefined` — and only when the key is still reachable, so an ordinary context gains
    // nothing.
    //
    // gnl's own callers cannot reach this: a JSON body gives `__proto__` as an own data property and
    // object spread copies it as data, leaving `Object.prototype` untouched (measured). But this
    // function is exported from `@gnldev/durable`, so the object it is handed may have come from a
    // YAML parse, a query-string parser, or a config merge — and a seal whose correctness depends on
    // which parser the caller happened to use is not a seal.
    if (k in sealed) define(sealed, k, undefined);
  }
  if (server.resourceId !== undefined) define(sealed, GNL_RESOURCE_ID_KEY, server.resourceId);
  if (server.orgId !== undefined) {
    define(sealed, GNL_ORG_ID_KEY, server.orgId);
    define(sealed, 'org', server.orgId); // the documented, client-readable name for the same server-derived fact
  }
  if (server.threadId !== undefined) define(sealed, GNL_THREAD_ID_KEY, server.threadId);
  if (server.staff === true && server.resourceId === undefined) define(sealed, GNL_STAFF_KEY, true);
  // "This call came through a door": NOT enumerable, so the context a host's dynamic agent reads is the
  // one it always was (spread, JSON and equality do not see it) — the engine reads it by name in run()/stream().
  Object.defineProperty(sealed, GNL_DOOR_KEY, { value: true, enumerable: false, writable: false, configurable: false });
  return sealed;
}

/** P1.7: reads the sealed server identity back out of a request context (see sealRequestContext). Keys the
 *  context doesn't carry are simply ABSENT from the result (never `undefined`-valued properties). */
export function serverIdentityOf(ctx: RequestContext): { resourceId?: string; orgId?: string; threadId?: string; staff?: true } {
  const out: { resourceId?: string; orgId?: string; threadId?: string; staff?: true } = {};
  if (ctx[GNL_STAFF_KEY] === true) out.staff = true;
  if (typeof ctx[GNL_RESOURCE_ID_KEY] === 'string') out.resourceId = ctx[GNL_RESOURCE_ID_KEY] as string;
  if (typeof ctx[GNL_ORG_ID_KEY] === 'string') out.orgId = ctx[GNL_ORG_ID_KEY] as string;
  if (typeof ctx[GNL_THREAD_ID_KEY] === 'string') out.threadId = ctx[GNL_THREAD_ID_KEY] as string;
  return out;
}

/**
 * THE caller of a call through the registry, decided once: the server's seal wins (a sealed user, or
 * sealed staff), then the call's explicit `caller`, then the `resourceId` shorthand, else `unknown`.
 */
function callerOfCall(rc: RequestContext, opts: { resourceId?: string; caller?: Caller } | undefined): Caller {
  // One rule (run-identity.ts `resolveCaller`): the seal decides, and a declaration that disagrees with it throws.
  return resolveCaller(serverIdentityOf(rc), opts);
}

/**
 * Dynamic agent field: a fixed value OR a function deriving it from the request context.
 * Durable twist: the resolved system/messages freeze into `:input` via persistInput → replay-deterministic;
 * the resolved model (string spec) freezes into `:cfg:model` → same model on resume even if the agent
 * definition changes.
 */
export type DynamicArg<T> = T | ((ctx: RequestContext) => T | Promise<T>);

async function resolveDyn<T>(v: DynamicArg<T>, ctx: RequestContext): Promise<T> {
  return typeof v === 'function' ? await (v as (c: RequestContext) => T | Promise<T>)(ctx) : v;
}

/** P1.2: FNV-1a (32-bit) — a cheap, dependency-free, stable string hash (same algorithm across Node
 *  versions/platforms, unlike relying on iteration order or object hashing). Used ONLY to bucket runIds
 *  for scorer sampling — not a security hash, no collision-resistance requirement here. */
function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** P1.2: WeakSet so an invalid scorerSampling.rate warns ONCE per config object, not once per run
 *  (a hot agent could otherwise flood stderr with the same warning on every completed run). */
const warnedInvalidSamplingRate = new WeakSet<object>();

/** P1.2: normalizes AgentConfig.scorerSampling into an effective rate — see the field's JSDoc for the
 *  invalid-value/warn-once contract. No `scorerSampling` at all → 1 (existing behavior: score every run). */
function effectiveScorerRate(a: AgentConfig): number {
  const s = a.scorerSampling;
  if (!s) return 1;
  const r = s.rate;
  if (typeof r === 'number' && Number.isFinite(r) && r >= 0 && r <= 1) return r;
  if (!warnedInvalidSamplingRate.has(s)) {
    warnedInvalidSamplingRate.add(s);
    console.warn(`[gnl] scorerSampling.rate is invalid (${String(r)}) — expected a number in [0,1]; treating as 1 (scoring every run)`);
  }
  return 1;
}

/** P1.2: deterministic per-runId sampling decision — see AgentConfig.scorerSampling's JSDoc for why this
 *  is a runId hash and not Math.random(). Bucket space is 0..9999 (four-digit resolution is plenty for a
 *  sampling *rate*, and keeps the hash→bucket math exact in floating point). */
function shouldSampleScorers(runId: string, rate: number): boolean {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  const bucket = fnv1a32(runId) % 10000;
  return bucket < rate * 10000;
}

/**
 * Structural compatibility with @gnldev/evals's Scorer (a reverse import would be circular). Runtime
 * scoring: when a run completes, each scorer is memoized under `${runId}:proc:eval:${name}` →
 * EXACTLY-ONCE for the same sample and scorer (even llmJudge doesn't rerun on resume/repeat calls, the
 * same score is returned; a memo computed on another sample — e.g. by 0.9.0, without the question —
 * or by an edited scorer is redone).
 * Names must be distinct per agent: createGnl refuses two scorers with one name.
 * Same key schema as scoreRun — studio /runs/:id/score sees the same records.
 */
export interface ScorerLike {
  name: string;
  /** See `FingerprintedScorer.fingerprint`: what the score depends on besides the sample. */
  fingerprint?: string;
  /**
   * Runtime scoring sample (built by `runScoreSample`, as in evals' `scoreRun`): `output` = the
   * text the run returned — after the agent's output processors, so a redactor's input never reaches
   * a judge (and a later `scoreRun` scores the same text, replaying this memo) — `input` = the question from the run's frozen input — the prompt, or the last
   * user turn when the run was started with `messages` — and `runId`.
   * NOTE: RAG context (`context`) is NOT AVAILABLE here — scorers that require context (faithfulness,
   * hallucination, contextPrecision) always return 0 in registry scorers; use them with `scoreRun`,
   * which builds a custom sample.
   */
  score(sample: { output: string; input?: string; expected?: string; runId?: string }): Promise<{ score: number; [k: string]: unknown }> | { score: number; [k: string]: unknown };
}

export interface AgentConfig {
  /** Short description of what the agent does — the network router sees this when picking an agent. */
  description?: string;
  /**
   * An AI SDK model OR a 'provider/model' string (resolved via the router) OR a fallback CHAIN
   * (array: tried in order, the winner is written to `<runId>:cfg:model` → deterministic fallback)
   * any of these can also be a function deriving it from requestContext.
   */
  model: DynamicArg<ModelInput | ModelInput[]>;
  tools?: DynamicArg<ToolSet>;
  system?: DynamicArg<string>;
  guard?: Guard;
  maxSteps?: number;
  /** 8.7 Processor pipeline (PII/moderation/tool-filter). */
  processors?: Processor[];
  /**
   * C5 first-class agent network: names of other registered agents. Each is exposed as an
   * `agent_<name>` tool (agent-as-tool, two-level journal → exactly-once handoff; a completed
   * sub-agent is fully skipped on parent resume).
   */
  agents?: string[];
  /**
   * Workflows this agent may START, by registry name — the missing direction of composition.
   *
   * A workflow has always been able to contain agents (its steps call them); an agent could not
   * reach a workflow at all, so "look this up, and if it needs the full onboarding pipeline, kick
   * it off" was not expressible. Each name becomes a `workflow_<name>` tool. The nested workflow
   * runs DURABLY on the same journal under a runId derived from the tool call
   * (`wf:<toolCallId>`), so a parent resume does not start it twice — the same exactly-once
   * contract `agents` already has.
   */
  workflows?: string[];
  /** C4 runtime scorers: automatic, journal-memoized (exactly-once) scoring when a run completes. */
  scorers?: ScorerLike[];
  /**
   * P1.2 opt-in sampling for `scorers` — without this, EVERY completed run pays
   * for every scorer (can be llmJudge, i.e. a full extra model call per scorer per run). `rate` is the
   * fraction of runs scored, 0..1 (0 = never, 1 = always/default-equivalent). Invalid values (NaN,
   * <0, >1, non-number) are treated as 1 (score everything) with a ONE-TIME console.warn — never throw,
   * a misconfigured sampling rate must not take an agent down.
   *
   * DETERMINISTIC BY DESIGN — derived from a stable hash of `runId`, NOT `Math.random()`:
   * replay consistency: `run()` can be called again for the SAME runId (resume, at-least-once
   *    delivery, a retried HTTP call) — a coin-flip sampler would risk scoring once and skipping the
   *    next time (or vice versa) for the identical run, which is both confusing (the same run "flips")
   *    and breaks the exactly-once memoization contract scorers otherwise have (see ScorerLike).
   * uniform sampling: a hash of runId spreads pseudo-randomly across the bucket space regardless of
   *    how runIds are minted (sequential, UUID, timestamp-prefixed, ...), so the sampled subset doesn't
   *    silently skew toward (or away from) any run-id pattern.
   * cost rationale: scorers (especially LLM-judge ones) are a per-run cost multiplier; sampling lets
   *    an agent get a statistically representative quality signal at a fraction of the spend.
   */
  scorerSampling?: { rate: number };
  /**
   * WHICH ADDRESS A `workKey` IS UNIQUE WITHIN, for this agent. Default `'resource'`.
   *
   * `'resource'` — the job belongs to a PERSON. Ayşe's `invoice-4471` and Mehmet's `invoice-4471`
   * are two jobs, because the subject is hashed into the run identity alongside the name.
   * `'org'` — the job belongs to the INSTALLATION (or the organization): tonight's reconciliation,
   * the nightly sweep, the cron that must run once no matter which of six workers woke up first.
   *
   * THE COST OF PICKING THE WRONG ONE IS NOT SYMMETRIC, and that asymmetry is why this is a
   * per-agent declaration instead of a per-call convenience (§6):
   *
   *   wrong `'resource'` → NOISY AND CHEAP. Work that should have been shared runs twice. Somebody
   *     sees two runs in Studio, or pays two invoices' worth of tokens, and fixes it that afternoon.
   *   wrong `'org'`      → SILENT AND DANGEROUS. Two tenants derive ONE id, so the second caller is
   *     handed the FIRST caller's answer — a cross-customer leak that looks, from every log line, like
   *     an ordinary cache hit. The counter-advocate's measured scenario had three separate gates
   *     watching this happen and none of them able to see it: the request was well-formed, the id
   *     existed, and the reply was a legitimate replay of a run that really was under that id.
   *
   * So the engine does not treat the two as equal choices. `'resource'` is the default, a `'resource'`
   * agent called with no subject is REFUSED rather than quietly widened (fail-closed — a missing
   * address is an unanswered question, not a bigger scope), and an `'org'` run's actual scope value is
   * written into its `:input` record where an operator can read it back. On an installation with no
   * organizations configured, `'org'` means the deployment as a whole and carries the `'~deployment'`
   * sentinel as its address (§10.2) — deliberate, single-tenant deployments are a legitimate main
   * case, and the value is visible rather than invented in silence.
   *
   * Renaming the agent changes the identity of its unfinished work: the name is in the hash (§3), so
   * half-done jobs under the old name keep the old id and a retry under the new name starts a new run.
   * That is the honest price of "the same workKey from two agents is two jobs".
   */
  workScope?: WorkScopeKind;
  /**
   * The orgs this agent belongs to. IF NOT GIVEN, the agent is GLOBAL (every org + operator
   * sees/runs it — existing behavior). If given, only identities whose orgId is in the list (plus
   * operator=orgless) see/run it. Visibility logic is SHARED via `agentVisibleToOrg` (server + studio
   * use the same helper).
   */
  orgs?: string[];
}

/**
 * Org-scoped agent visibility decision (SHARED helper for server + studio). Opt-in:
 * agent didn't GIVE `orgs` → GLOBAL, everyone sees it (existing behavior, backward-compatible).
 * caller is NOT org-bound (operator / auth off → undefined) → sees everything.
 * otherwise: visible only if the caller's org is in the agent's `orgs` list.
 * @internal — engine plumbing shared with the GNL door, memory and rag packages; gnl builds its argument, no host writes it.
 */
export function agentVisibleToOrg(cfg: { orgs?: string[] }, callerOrgId: string | undefined): boolean {
  if (!cfg.orgs?.length) return true; // global agent
  if (!callerOrgId) return true; // operator (orgless) / auth off
  return cfg.orgs.includes(callerOrgId);
}

/**
 * Structural type for the workflow registry — to AVOID CREATING a dependency on @gnldev/workflow
 * (workflow→durable already exists; a reverse import would be circular). @gnldev/workflow's `Workflow`
 * class structurally satisfies this.
 */
export interface WorkflowLike {
  build(): { id: string }[];
  run(input: any, ctx: { runId: string; journal: Journal }): Promise<any>;
  runResumable?(
    input: any,
    ctx: { runId: string; journal: Journal },
    // P0.4 resume delivers typed HITL payloads (consumed via ctx.resumeData/
    // waitForResume); signal is the in-process cancel/disconnect path, checked between steps.
    // FLOW-08: workflowName is mirrored into the `wfrun:` status record (see @gnldev/workflow's
    // runResumable) so the run registry can show which workflow a run belongs to.
    opts?: { maxSteps?: number; resume?: Record<string, unknown>; signal?: AbortSignal; workflowName?: string },
  ): Promise<
    | { status: 'completed'; output: any }
    | { status: 'suspended'; stepId: string; reason?: unknown }
    | { status: 'paused'; stepId: string; partial?: unknown }
    // P0.4: a durable cancel (cancelWorkflowRun) or an aborted signal — terminal, resuming stays canceled.
    | { status: 'canceled'; stepId?: string; reason?: unknown }
  >;
}

/** Introspection of a workflow (studio Workflows view). */
export interface WorkflowMeta {
  name: string;
  steps: { id: string; kind: string }[];
}

/**
 * What `runWorkflow` accepts. Written out as a named type because package #3 gave it a third way to
 * say which run this is, and an inline literal repeated on two functions is how the outer door and the
 * inner one drift apart.
 *
 * `runId` XOR `workKey`, like every other door (see resolveWorkIdentity) — with the one difference
 * this door has always had: passing NEITHER is still allowed, and still answered with the loud
 * generated id that tells the caller their retry will not dedupe.
 *
 * `workScope` is per-call here, unlike the agent doors where it is declared once on the agent. A
 * workflow has no config object of its own to carry the declaration, and `runWorkflow` is where
 * installation-wide work actually lives (the nightly reconciliation is a workflow, not a chat turn).
 * Default `'resource'`, for the same fail-closed reason: read AgentConfig.workScope's note before
 * reaching for `'org'` — the two mistakes do not cost the same.
 */
export interface WorkflowRunOpts {
  runId?: string;
  /** Your name for this unit of work; the engine derives the run id from it. See RunOptions.workKey. */
  workKey?: string;
  /** Which address that name is unique within. Default `'resource'`. */
  workScope?: WorkScopeKind;
  maxSteps?: number;
  resume?: Record<string, unknown>;
  signal?: AbortSignal;
  /** Shorthand for `caller: user(resourceId)`. */
  resourceId?: string;
  /** See RunOptions.caller. */
  caller?: Caller;
  /** The calling run's identity, for a workflow started from inside a run (child run). */
  parent?: RunIdentity;
  actor?: string;
  threadId?: string;
  context?: RequestContext;
}

/** Result of a workflow run (with step outputs). */
export interface WorkflowRunResult {
  runId: string;
  output?: unknown;
  suspended?: boolean;
  /** Step-through: the maxSteps limit was reached — stepId is the next (not-yet-run) step. */
  paused?: boolean;
  /** P0.4 the run was durably canceled (cancelWorkflowRun) or its signal aborted. */
  canceled?: boolean;
  stepId?: string;
  reason?: unknown;
  /**
   * `fallback` is present only when the step's `output` came from a `retry(..., { fallback })`
   * substitute rather than from the step itself. Without it the two are indistinguishable in the
   * record — a "charged via provider A" step reads identically whether it worked first time or blew
   * up twice and landed on provider B, which is the reading an operator is most likely to get wrong.
   *
   * `stepId` is the load-bearing half. `attempts` is the number CONSUMED before the substitution, and
   * since a fallback is only reached once the budget is spent it normally equals `policy.attempts` —
   * which the workflow definition already states. It differs only when a resumed run meets a policy
   * that has since been lowered, so read it as "attempts consumed", not as this run's failure count.
   *
   * TOP-LEVEL steps only. A `retry` inside a nested `asStep` workflow writes its marker under the
   * inner step's prefixed key, and this list does not enumerate inner steps at all — so a substitution
   * there is invisible here, exactly as the inner step's output already is.
   */
  steps: { id: string; kind: string; output: unknown; fallback?: { attempts: number; stepId: string } }[];
}

export interface CreateGnlConfig {
  /**
   * This process's liveness (process-liveness.ts): what its executor holds while it lives, and what
   * another process asks before continuing its runs. Default: the one installed for the process, else the
   * storage's own (`storage.processLiveness()`: a Sqlite file lock, a Postgres session); a store only this
   * process reaches (in memory) needs none. Behind a transaction-mode pooler pass
   * `await postgresLiveness({ connectionString: <direct URL> })`.
   */
  liveness?: ProcessLiveness;
  /** Tuning of the process's run executor (detached.ts), taken from the first registry on a store. */
  detached?: Pick<DetachedRunsOptions, 'sweepMs' | 'pollMs' | 'coalesceMs' | 'outcomeAskMs' | 'signal' | 'onComplete'>;
  /** Storage (RunJournal + optional MemoryStore/...). Preferred over `journal` (composite + memory). */
  storage?: Storage;
  /** Low-level journal (if no storage). runDurable works with this; `storage` is required for memory. */
  journal?: Journal;
  agents?: Record<string, AgentConfig>;
  /** Common tools added to all agents. */
  tools?: ToolSet;
  /** Conversation memory. `false` = explicitly off. If not given, derived via `memoryFactory` (if any). */
  memory?: Memory | false;
  /** If `memory` isn't given, derives a Memory from the storage source (Storage if present, otherwise Journal). */
  memoryFactory?: (storage: Storage | Journal) => Memory;
  /** Common processors added to all agents (run before the agent's own). */
  processors?: Processor[];
  /** Named workflow registry (studio Workflows view: list + run). */
  workflows?: Record<string, WorkflowLike>;
  /** Named dynamic agent networks (parity with Supervisor/`.network()`) — run via `runNetwork(name, ...)`. */
  networks?: Record<string, NetworkConfig>;
  /**
   * Task 3 (opt-in): validates that INSTALLED sibling @gnldev/* packages (memory/server/studio/...) share
   * @gnldev/durable's OWN version — catches a `--force`/overrides-installed incompatible suite that the
   * package manager's caret range would normally prevent (see suite-consistency.ts
   * `assertSuiteConsistent`). `true` → warn on mismatch (default), `'throw'` → hard error at
   * `createGnl()` time. Default: `undefined` (OFF) — existing behavior byte-for-byte unchanged; this is
   * a new opt-in check, not a new implicit requirement.
   */
  checkSuiteConsistency?: boolean | 'throw';
  /**
   * Provider-specific tool-schema compatibility, same meaning as runDurable's option: `true` for the
   * default rule set, or an explicit list. Applies to every agent this registry runs.
   *
   * It is declared here because @gnldev/tool-schema's README documents exactly this call —
   * `createGnl({ ...config, schemaCompat: defaultRules })` — and until now the registry forwarded a
   * fixed allowlist of options to runDurable that did not include it, so the package's only
   * documented integration was silently doing nothing.
   */
  schemaCompat?: boolean | ToolSchemaRuleLike[];
  /**
   * FAZ-4 — the banking/defense/medical bundle, as ONE opt-in switch. `'critical'` applies, for
   * every run()/stream() call (explicit opts still win, field by field):
   *   toolPolicy 'strict-critical'          (side-effect tools must answer the crash window)
   *   limits.sideEffectDuplicates { action:'suspend', scope:'thread' } — the repeat becomes a
   *     human question EVERY time, across the whole conversation (a deliberate second identical
   *     job is approved into existence, an accidental one is refused; threadId-less runs fall back
   *     to run scope with a loud warn — the F3 contract)
   *   exclusiveModelStep on                 (closes the concurrent same-runId model-claim gap)
   *   lock on                               (auto owner, ttl 300s — a concurrent duplicate 409s)
   *   strictInput + actor binding on        (one runId = one request, one owner)
   *   conflictLedger on                     (every refusal leaves a PII-free trace)
   *   tombstonePolicy 'reject'              (a swept runId's late retry is refused, not re-run)
   * JOURNAL GUIDANCE (documented, not enforced): prefer Postgres, and if it replicates, run it with
   * `synchronous_commit = on` and a synchronous standby — a claim acknowledged only by a primary that
   * then fails over can be lost, and with it the exactly-once promise.
   * SINGLE-HOME BOUND (the guarantee's edge, restated where the guarantee is SOLD — full statement
   * on the Journal interface JSDoc): every exactly-once promise here — locks, fingerprints,
   * ledger, tombstones, dedup windows — holds for any number of workers sharing ONE journal store.
   * Two regions with independent journals are two independent dedup windows; a runId must always be
   * ROUTED to its home journal (per-run ownership). This is a routing contract, not a consensus
   * feature, and a multi-region deployment that ignores it silently halves every guarantee above.
   * SCOPE, stated honestly (denetçi K6): the overlay wraps run() and stream() — the agent entry
   * points. runNetwork() inherits the two protections that MAP to nested delegations (toolPolicy
   * 'strict-critical' + sideEffectDuplicates 'suspend'); locks/fingerprints stay per-entry-point.
   * RunWorkflow() (FAZ-8) is covered with the protections that MAP to workflows: required runId,
   * SideEffect-steps-must-carry-recover, tombstone reject, input fingerprint and a heartbeated
   * run-lock — step-level exactly-once stays FAZ-1's claim protocol, which workflows already carry.
   */
  preset?: 'critical' | 'assistant' | 'headless';
  /*
   * 'assistant' ve 'headless' (heyet matrisi, 7 Eyl 2026): critical'ın sertlik paketini AÇMADAN,
   * yalnız sınıf-bazlı tekrar politikasını basarlar (policy-matrix.ts):
   *   assistant → para/bildirim sorar, delete "zaten yapılmıştı" notu, upsert sessiz;
   *               replayDisclosure default 'explain' (ekranda insan var, dürüst anlatım açık).
   *   headless  → soracak insan yok: para tekrarı typed-RED (DLQ'ya düşer), bildirim/delete atlar
   *               + iz; hiçbir hücre suspend üretmez. Zarf/iz her hücrede tam (görünmezlik yasağı).
   * Workflow/lock/strictInput kapıları bu ikisine GELMEZ — onlar critical'ın kimliğidir.
   */
  /**
   * HERMES v1 — onay-kapılı öneri/öğrenme katmanı (see suggestions.ts for the full contract).
   * Two independent switches: `generate` (may the system PROPOSE memory-lessons after completed
   * runs?) and `apply` (may APPROVED lessons be injected into system prompts?). Nothing is ever
   * applied without a human decision (`gnl.suggestions.decide`), approved lessons outlive the
   * switches, and the org-promotion code path exists only when the `promotion` block is present.
   * Config contradictions THROW at createGnl time (validateSuggestionsConfig).
   * SCOPE, stated honestly (K6'nın preset dersi): injection and learning cover run() and stream() —
   * the agent entry points. Sub-agents (`agents`), network delegations and workflow agent steps do
   * NOT see lessons; extending them is a deliberate future decision, not an oversight to paper over.
   */
  suggestions?: SuggestionsConfig;
  /**
   * Replay-disclosure policy, forwarded to every run()/stream() (per-call RunOptions wins).
   * 'explain' lets the model narrate honestly when a tool result came from the journal instead of
   * executing ("the operation was not performed again") — via a TRANSIENT per-step note that never
   * persists. Default 'silent' (existing behavior). See RunDurableArgs.replayDisclosure.
   */
  replayDisclosure?: 'explain' | 'silent';
}

/**
 * Dynamic network definition: the router-LLM picks one from the `agents` list each turn, or writes
 * the final answer. Determinism: routing decisions freeze into `<runId>:net:route:<i>` via CAS
 * (see network.ts) → the router isn't called again on resume; the router model's fallback chain
 * (materializeModel) also freezes into `<runId>:cfg:model`. The loop is bounded by `maxIterations`
 * (default 6).
 */
export interface NetworkConfig {
  /** Router model — same shapes as AgentConfig.model (spec/object/fallback chain/dynamic). */
  router: DynamicArg<ModelInput | ModelInput[]>;
  /** Names of registered agents that can be routed to (AgentConfig.description serves as the router's introduction). */
  agents: string[];
  /** Extra instruction for the router. */
  system?: DynamicArg<string>;
  /** Routing turn cap (default 6); once reached, the router is forced to finalize. */
  maxIterations?: number;
}

/** Derives a kind from a composite step id (parallel(a+b) / branch(..) / foreach(..) / loop(..) → kind). */
/**
 * A retry's fallback marker, as written by @gnldev/workflow. Structural rather than imported — the
 * dependency only runs one way (see the WorkflowLike note above) — and checked field by field,
 * because a truthy-only test once let an ordinary step output stand in for one.
 */
function isFallbackMarker(v: unknown): v is { __gnlFallback: true; attempts: number; stepId: string } {
  if (!v || typeof v !== 'object') return false;
  const m = v as Record<string, unknown>;
  return m.__gnlFallback === true && typeof m.attempts === 'number' && typeof m.stepId === 'string';
}

function workflowStepKind(id: string): string {
  return id.startsWith('parallel(') ? 'parallel'
    : id.startsWith('branch(') ? 'branch'
    : id.startsWith('foreach(') ? 'foreach'
    : id.startsWith('loop(') ? 'loop'
    : 'step';
}

export interface RunOptions {
  /**
   * The RAW run id — still accepted, still exactly what it always was, and now one of TWO ways to say
   * which run this call belongs to (the other is `workKey` below). Pass this one when you are holding
   * an id the engine already issued (resuming derived work, following a `result.runId`) or when your
   * own system already owns a stable identifier for the job.
   *
   * Optional, not gone: exactly one of `runId` / `workKey` is required on the agent doors. Passing
   * NEITHER is refused for the same reason it always was — a run with no stable name cannot be
   * retried, resumed or deduped, and silently generating one would hand the caller a promise the
   * framework then cannot keep.
   */
  runId?: string;
  /**
   * YOUR NAME FOR THIS UNIT OF WORK. The engine derives the run id from it (§1), so you never handle
   * the id at all unless you want to.
   *
   * A `workKey` is a BUSINESS NAME — the invoice being issued, the document being published, the
   * firmware rollout for device 7742, tonight's reconciliation batch. It is not a random retry token
   * and it is not a conversation id: coming from `thread_id`, note that the same key there means
   * "continue this conversation" and here means "this is the same job". Reuse a workKey to RETRY work,
   * never to add a turn — a conversation is `threadId`, a different field, and both can be set at once.
   *
   * WHAT THE ENGINE DOES WITH IT. `runId = derive(agent, workScope, subject, workKey)` — a 128-bit
   * digest behind the `run1_` prefix. The name itself is stored in the run's record (queryable,
   * shown on operator screens); the id is opaque and is a stable PSEUDONYM of your key, not an
   * anonymisation of it (a low-entropy key is recoverable by dictionary). Keep sensitive data out of
   * it: a workKey is echoed in error details and displayed in Studio.
   *
   * WHAT HAPPENS ON THE SECOND CALL — the two axes, whose names are fixed even though v1 gives each
   * exactly one behaviour and therefore no field to set (adding a single-valued enum would be
   * furniture; the names live here so tomorrow's second value is an addition, not a break):
   *
   *   onConflict: 'reject'  — the work is RUNNING right now → `409 run_busy` (+ Retry-After).
   *   onReuse:    'replay'  — the work already FINISHED → the recorded answer comes back, nothing
   *                           re-runs, no side effect fires twice.
   *
   * And the asymmetry that is a rule rather than a footnote: a run that ended in FAILURE has no
   * answer to replay, so the same workKey is free to run again. Retrying failed work is the normal
   * case, not an escape hatch.
   *
   * HOW LONG A workKey STAYS UNIQUE: as long as the run record lives — not a minute longer.
   * Recognition is a property of the stored run, not of the text. Size your retention window so it is
   * at least as long as the longest retry your clients can produce, or turn on tombstones
   * (`tombstones: true` + `tombstonePolicy: 'reject'`) so a late retry is refused with `409 run_swept`
   * instead of silently starting the job over.
   *
   * Mutually exclusive with `runId` — passing both is refused at the call, because two identities for
   * one call is a question the engine would have to answer by guessing.
   */
  workKey?: string;
  prompt?: string;
  messages?: any;
  /**
   * P1.7: PRECEDENCE — if `context` carries a server-sealed identity (see sealRequestContext /
   * GNL_THREAD_ID_KEY), that value ALWAYS wins over this field. Chosen deliberately: `context` is where
   * a server-side caller (e.g. @gnldev/server after auth) seals the AUTHENTICATED identity, so it must not
   * be overridable by a plain top-level RunOptions field a less-trusted caller could also set.
   */
  threadId?: string;
  /** P1.7: same precedence as `threadId` above — a server-sealed `context` resourceId wins. */
  resourceId?: string;
  /**
   * WHO is calling (run-identity.ts): `user(id)`, `STAFF`, or `UNKNOWN`. `resourceId` is the shorthand
   * for a user; with neither, the call is `unknown` — closed. A server-sealed `context` identity wins
   * over both. Re-entering an existing run runs it as its RECORDED owner; a caller that may not act on
   * it is refused (`RunOwnerMismatchError`).
   */
  caller?: Caller;
  approvals?: Record<string, boolean>;
  /** Request context: passed to dynamic model/system/tools functions (organization/role/user…). */
  context?: RequestContext;
  /** Playground session overrides (agent definition is used if not given). */
  model?: string;
  temperature?: number;
  topP?: number;
  system?: string;
  /** Playground tool allow-list: if given, only these tool NAMES are exposed to the model this run
   *  (a subset of the agent's resolved tools). Names not in the resolved set are ignored. */
  tools?: string[];
  /** W1 (opt-in): per-run cost cap + loop detection — INHERITED by sub-agents. */
  limits?: RunLimits;
  /**
   * These protections lived only on the low-level runDurable args and were unreachable through
   * createGnl — the documented main path could not enable strict tool-policy, strict replay, timeouts, or
   * model-step exclusivity. Opt-in; forwarded to runDurable/streamDurable (toolPolicy also to sub-agents).
   */
  toolPolicy?: 'strict' | 'strict-critical';
  /** FAZ-4 (critical profile) — see run.ts RunOptions for full semantics; forwarded verbatim. */
  strictInput?: boolean;
  /** See RunDurableArgs.trustRecordedInput — the host vouches for an older recorded input. Ignored on a door's call. */
  trustRecordedInput?: boolean;
  conflictLedger?: boolean;
  auditOnReject?: 'best-effort' | 'require';
  /** Replay-disclosure policy (see CreateGnlConfig.replayDisclosure); this per-call value wins. */
  replayDisclosure?: 'explain' | 'silent';
  /** Kanal etiketi ('chat' | 'api' | 'batch:<id>'...) — XID origin'i; sorular "5 dk önce, sohbetten" diyebilsin. */
  channel?: string;
  tombstonePolicy?: 'ignore' | 'reject';
  actor?: string;
  replay?: 'strict' | 'lenient';
  timeouts?: { modelStepMs?: number; toolMs?: number; claimTtlMs?: number };
  exclusiveModelStep?: { ttlMs?: number };
  /**
   * (b) — `stream()` only (run() already THROWS on a block, so there is nothing extra to
   * surface there): invoked once at stream finish when a loop/maxToolCalls/duplicate/tainted block or
   * a durable-tool block sentinel fired, with the RAW structured breach `{ kind, message, detail }`.
   * Advisory — a throw from it is swallowed with a console.warn. See StreamDurableArgs.onBlocked.
   */
  onBlocked?: (breach: StreamBreach) => void | Promise<void>;
  /**
   * CANCELS THE RUN — not the call. A run executes apart from the call that started it (detached.ts):
   * the caller leaving (a closed tab, a dropped connection) does not stop it, and a door never wires a
   * request's own signal here. Aborting this signal is the caller saying "stop": the run is canceled
   * durably, in whichever process executes it — as `gnl.cancel(runId)` does: at once here, at its next
   * event elsewhere.
   */
  abortSignal?: AbortSignal;
  /**
   * `stream()`: the reader's cursor — what `cursor()` of an earlier stream of this run said (a door's
   * `Last-Event-ID`: an event's `seq`, or `seq.offset` mid-answer). The returned stream continues after it;
   * nothing the reader has is sent again.
   */
  after?: number | string;
}

/**
 * THE GATE (package #3 of docs/RUNID-WORKKEY-HEYET-KARARI.md). One function, four doors.
 *
 * `run`, `stream`, `runWorkflow` and `runNetwork` each mint a run id, and each of them now accepts a
 * `workKey` instead. Writing the rule four times is how three of them end up subtly different — the
 * measured history of this file is a list of gates that existed on the agent path and not on the
 * workflow one — so the rule lives here and the doors pass their differences in as arguments.
 *
 * THE RULE, in the order a caller meets it:
 *
 *   BOTH → refuse. Two identities for one call is a question with no honest answer: obey the runId
 *     and the declared name is a lie; obey the workKey and the id the caller passed goes nowhere.
 *   NEITHER → refuse on the agent/network doors (today's required-runId behaviour, unchanged), allow
 *     on `runWorkflow`, which has its own loud anonymous fallback and keeps it.
 *   ONLY runId → today's path, byte for byte. `assertRunIdSafe` still judges it downstream.
 *   ONLY workKey → derive. `derivedRunId(entity, scopeKind, scopeValue, workKey)`.
 *
 * WHY THE ENTITY NAME IS TYPE-PREFIXED — a micro-decision this package makes on top of §3, flagged
 * here because it is not in the decision's text. §3 requires the agent name in the tuple so two
 * agents cannot collide on one workKey. A registry can hold an agent AND a workflow under the same
 * name (`pay` the agent, `pay` the pipeline), and a bare name would collide THOSE: one digest, two
 * completely different kinds of run, and whichever started first would answer for the other. The
 * prefixes are the ones the engine already writes into its composite ids (§7's exception row):
 * `agent:`, `wf:`, `net:`.
 *
 * WHY A MISSING SUBJECT THROWS (§6). `'resource'` scope with nothing to scope to is not a wider
 * scope; it is an unanswered question. XID's fail-open posture does not transfer here: losing a
 * question costs a question, while losing the address delivers the work to the wrong door — and the
 * wrong door is another customer's. So the refusal is at the gate, before a key is written.
 *
 * WHY IT IS EXPORTED (package #5). An HTTP route needs the id BEFORE it calls the door: the
 * ownership gate reads `<runId>:input`, the cancel registry is keyed by it, and `X-Gnl-Run-Id` has
 * to say which run answered. A route that derived it with its own copy of these four lines would be
 * the fifth copy of a rule this function exists to keep at one — and the copy that drifts is the one
 * that echoes an id nothing was written under. So the surfaces call THIS, then hand the door the
 * `workKey` (not the id they just computed), and the door resolves the same tuple to the same
 * answer: one rule, two readers, no second implementation to keep honest.
 */
export type WorkIdentityRequest = {
  runId?: string;
  workKey?: string;
  /** The scope in force: the agent's declaration, or the caller's on the workflow/network doors. */
  scopeKind: WorkScopeKind;
  /** The EFFECTIVE subject (sealed identity wins — the caller works that out before asking). */
  resourceId?: string;
  /** The EFFECTIVE organization, when the deployment has one. */
  orgId?: string;
  /** What a call with neither half means on this door: 'refuse' everywhere but `runWorkflow`. */
  anonymous: 'refuse' | 'allow';
  /** How the door reads in an error message, e.g. `run('pay')`. */
  surface: string;
};

/** What the doors get back: an id to run under (absent only on the anonymous workflow path) and, when
 *  the id was derived, the declaration to freeze into the run's record so it can be read back. */
export type ResolvedWorkIdentity = { runId?: string; work?: { workKey: string; workScope: WorkScope } };

export function resolveWorkIdentity(entityName: string, req: WorkIdentityRequest): ResolvedWorkIdentity {
  const { runId, workKey, surface } = req;
  if (runId !== undefined && workKey !== undefined) {
    throw new Error(
      `@gnldev/durable: ${surface} was given BOTH a runId and a workKey — one identity, one declaration. ` +
        'A workKey is your name for the work and the engine derives the id from it; a runId IS the id. ' +
        'Pass the half you own: workKey if you are naming a job, runId if you are holding an id the engine ' +
        'already issued (a resume, a fork, an id you stored).',
    );
  }
  if (workKey === undefined) {
    if (runId !== undefined) return { runId };
    if (req.anonymous === 'allow') return {};
    throw new Error(
      `@gnldev/durable: ${surface} needs an identity — pass a workKey (your name for this unit of work; the ` +
        'engine derives the run id from it) or a runId (a raw id you already hold). Without one there is nothing ' +
        'for a retry to find, so the call could only ever run the work again.',
    );
  }
  let scopeValue: string;
  if (req.scopeKind === 'resource') {
    if (!req.resourceId) {
      throw new Error(
        `@gnldev/durable: ${surface} declared workKey '${workKey}' in a 'resource' workScope, and the call names no ` +
          'resourceId — the address the name is unique within is missing, so the engine cannot tell whose job this is. ' +
          'Pass resourceId (or seal an authenticated one onto the request context). If this job belongs to the ' +
          "installation rather than to a person — a nightly reconciliation, a scheduled sweep — declare workScope: 'org', " +
          'and read that field\'s note first: the two mistakes do not cost the same.',
      );
    }
    scopeValue = req.resourceId;
  } else {
    // An org-less installation runs org-scoped work under the deployment sentinel (§10.2). Visible,
    // not silent: the value travels into `:input.workScope.value`.
    scopeValue = req.orgId ?? DEPLOYMENT_SCOPE;
  }
  return {
    runId: derivedRunId(entityName, req.scopeKind, scopeValue, workKey),
    work: { workKey, workScope: { kind: req.scopeKind, value: scopeValue } },
  };
}

/**
 * Tool names carrying an `effectClass`, across the shared toolset and every agent's own.
 *
 * STATIC ONLY, deliberately. `AgentConfig.tools` may be a `DynamicArg` — a function resolved per
 * request with the RequestContext — and calling one here would mean inventing a context at
 * construction time to answer a diagnostic question. A dynamic toolset is simply not scanned, so the
 * warning below can miss; it never fires wrongly, which is the direction a startup warning has to
 * err in if anyone is to keep reading them.
 */
function toolsDeclaringEffectClass(config: CreateGnlConfig): string[] {
  const found = new Set<string>();
  const scan = (tools: unknown) => {
    if (!tools || typeof tools !== 'object') return;
    for (const [name, tool] of Object.entries(tools as Record<string, unknown>)) {
      if (tool && typeof tool === 'object' && (tool as { effectClass?: unknown }).effectClass !== undefined) found.add(name);
    }
  };
  scan(config.tools);
  for (const a of Object.values(config.agents ?? {})) scan(a.tools);
  return [...found].sort();
}

/**
 * What a sub-agent's run takes from the run that delegated to it. TOTAL over RunOptions: an option
 * added to RunOptions does not compile until it says here whether it crosses the delegation — the
 * hand-picked copy this replaces carried four of thirty, and a protection added later never reached a
 * sub-agent (measured: cancellation, tool timeouts, processors, scorers, the preset's run lock).
 *
 * 'inherit' — a protection or a decision the parent runs under; the child runs under it too.
 * 'own'     — the child's: its id, its task, its agent's model/system/tools, its own run lock (the
 *             preset takes one per run), its replay mode.
 * 'frame'   — comes down in the delegation frame, not as an option: whom it runs for, the parent's
 *             cancellation and approvals (agent-tool.ts ChildFrame).
 */
const CHILD_RUN_POLICY = {
  runId: 'own', workKey: 'own', prompt: 'own', messages: 'own', model: 'own', temperature: 'own', topP: 'own',
  system: 'own', tools: 'own', replay: 'own', trustRecordedInput: 'own',
  threadId: 'frame', resourceId: 'frame', caller: 'frame', approvals: 'frame', abortSignal: 'frame',
  context: 'inherit', limits: 'inherit', toolPolicy: 'inherit', strictInput: 'inherit', conflictLedger: 'inherit',
  auditOnReject: 'inherit', replayDisclosure: 'inherit', channel: 'inherit', tombstonePolicy: 'inherit', actor: 'inherit',
  timeouts: 'inherit', exclusiveModelStep: 'inherit', onBlocked: 'inherit', after: 'own',
} as const satisfies Record<keyof RunOptions, 'inherit' | 'own' | 'frame'>;

/** A child's run options: what it inherits from the parent's, plus its own. */
function childRunOptions(parent: RunOptions, own: RunOptions): RunOptions {
  const inherited: Record<string, unknown> = {};
  for (const k of Object.keys(CHILD_RUN_POLICY) as (keyof RunOptions)[]) {
    if (CHILD_RUN_POLICY[k] === 'inherit' && parent[k] !== undefined) inherited[k] = parent[k];
  }
  return { ...(inherited as RunOptions), ...own };
}

export function createGnl(config: CreateGnlConfig) {
  refuseCreateGnlNames(config);
  // Task 3 (opt-in): run BEFORE anything else — a version-skewed suite should be caught up front, not
  // after agents/tools are already wired against a possibly-incompatible sibling package.
  if (config.checkSuiteConsistency) {
    assertSuiteConsistent({ onMismatch: config.checkSuiteConsistency === 'throw' ? 'throw' : 'warn' });
  }
  // Resolve memory once: explicit `false` → off; if not given, memoryFactory (if any) derives it from the journal.
  const journal: Journal = config.storage ? config.storage.runs : config.journal!;
  if (!journal) throw new Error('createGnl: `storage` or `journal` is required');
  const memSource: Storage | Journal = config.storage ?? config.journal!;
  // A declaration nothing reads. `effectClass` is the tool's half of the policy matrix — it says what
  // a REPEAT of this tool costs — and the only thing that ever reads it is a profile
  // (`limits.sideEffectDuplicates.byClass`, which `preset` fills in; see policy-matrix.ts and
  // durable-tool.ts's dupConfigOf). Without one, `byClass` is absent, `dupConfigOf` falls through to
  // the plain default, and a tool that carefully declared itself `transactional` is treated exactly
  // like one that declared nothing. The author has done the hard half and gets none of the benefit,
  // with nothing on screen to say so — which is the shape of a silent misconfiguration rather than a
  // missing feature.
  //
  // Warn, not throw, and config-time rather than per-call: a per-call `opts.limits.sideEffectDuplicates
  // .byClass` ALSO activates these declarations, and this function cannot see one. So the message says
  // both remedies and does not pretend the declarations are certainly dead — a caller who passes
  // limits per run is doing it right and should be able to read that from the sentence.
  if (!config.preset) {
    const declared = toolsDeclaringEffectClass(config);
    if (declared.length) {
      console.warn(
        `@gnldev/durable: ${declared.length} tool(s) declare \`effectClass\` but no profile reads it: ${declared.join(', ')}. ` +
        "A declaration is only consulted through `limits.sideEffectDuplicates.byClass`, which `preset` writes — " +
        "add `preset: 'assistant'` (or 'headless' / 'critical') to createGnl's config, or pass `limits.sideEffectDuplicates.byClass` " +
        'on every run(). Until then these tools dedup exactly like undeclared ones.',
      );
    }
  }
  const resolvedMemory: Memory | undefined =
    config.memory === false
      ? undefined
      : config.memory ?? (config.memoryFactory ? config.memoryFactory(memSource) : undefined);
  /**
   * The same resolution, with the ONE distinction the engine needs and the public surface does not:
   * whether "no memory" was DECLARED or merely never configured.
   *
   * run.ts warns once when a `threadId` arrives with nothing to put it in (warnThreadIgnored), and
   * `memory: false` is how a project says it meant that. Keeping the public `gnl.memory` at
   * `Memory | undefined` matters more than reusing one variable here: callers destructure it and
   * check it for truthiness, and widening it to `false` would change a documented return type to buy
   * nothing on that side.
   */
  const memoryArg: Memory | false | undefined = config.memory === false ? false : resolvedMemory;
  // HERMES v1: validated LOUDLY at construction (semantic layer's precedent — a static contradiction
  // must be impossible to ship), then built once; run()/stream() consult it per call.
  let suggestionsApi: SuggestionsApi | undefined;
  if (config.suggestions) {
    validateSuggestionsConfig(config.suggestions, journal);
    suggestionsApi = createSuggestions(journal, config.suggestions);
  }
  // A score is kept under its scorer's name (result, memo, metrics), so two with one name collapse
  // into one — refused here, at construction, like the two evals runners refuse it per call.
  for (const [agentName, a] of Object.entries(config.agents ?? {})) {
    if (a?.scorers?.length) assertDistinctScorerNames(a.scorers, `createGnl agent '${agentName}'`);
  }
  function agent(name: string): AgentConfig {
    const a = config.agents?.[name];
    if (!a) throw new Error(`agent '${name}' is not registered`);
    return a;
  }

  /**
   * Model chain → single model: string specs are resolved via the router; multiple candidates enter
   * the deterministic fallback wrapper (the winner is written to `<runId>:cfg:model` via CAS, sticks
   * on resume). Object models are tracked with the '#<index>' label (chain order must be stable).
   */
  async function materializeModel(spec: ModelInput | ModelInput[], runId: string) {
    const chain = Array.isArray(spec) ? spec : [spec];
    if (chain.length === 0) throw new Error('model chain is empty');
    const candidates: FallbackCandidate[] = [];
    for (let i = 0; i < chain.length; i++) {
      const m = chain[i]!;
      candidates.push(typeof m === 'string' ? { spec: m, model: await resolveModel(m) } : { spec: `#${i}`, model: streamable(m) });
    }
    return withModelFallback(candidates, journal, runId);
  }

  /**
   * Converts `a.workflows` names into `workflow_<name>` tools.
   *
   * Mirrors `buildSubAgentTools` deliberately, contract for contract: the child runId comes from
   * the toolCallId, so the SAME parent step always maps to the SAME workflow run — replaying the
   * parent skips a completed workflow instead of launching a second one. A suspended workflow is
   * returned as data (`suspended`, `stepId`, `reason`), not thrown: the agent asked a question and
   * "it is waiting on a human" is an answer.
   */
  /** `identity` — buildSubAgentTools ile aynı gerekçe: devretmek sahibi düşürmek değildir. */
  function buildWorkflowTools(names: string[] | undefined, identity?: { actor?: string }): ToolSet {
    const out: ToolSet = {};
    for (const wfName of names ?? []) {
      if (!config.workflows?.[wfName]) {
        // The same early, clear refusal `agent()` gives for an unknown sub-agent: at wiring time,
        // naming what exists — not a mid-run "not registered" from inside a tool call.
        throw new Error(
          `agent config names workflow '${wfName}', but it is not registered. `
          + `Registered workflows: ${Object.keys(config.workflows ?? {}).join(', ') || '(none)'}`,
        );
      }
      out[`workflow_${wfName}`] = Object.assign(aiTool({
        description: `Start the '${wfName}' workflow and return its output`,
        // Declared as JSON Schema, not zod, and deliberately. `@ai-sdk/provider-utils` forces
        // `additionalProperties: false` on every object it converts through its ZOD 4 path
        // (addAdditionalPropertiesToJsonSchema, reached from zod4Schema but not zod3Schema), so on
        // zod 4 this schema told the provider the input accepts NO properties at all. Measured:
        //   zod 3.25.76 → {"type":"object","additionalProperties":{}}
        //   zod 4.4.3   → {"type":"object","propertyNames":{...},"additionalProperties":false}
        // It is not specific to z.record — `z.looseObject({})` and `z.object({}).passthrough()` are
        // clobbered identically, so no zod spelling survives. A workflow takes an arbitrary input
        // object by definition, and jsonSchema() bypasses the converter, which also makes this
        // independent of whichever zod major the host installs.
        inputSchema: jsonSchema<{ input?: Record<string, unknown> }>({
          type: 'object',
          properties: {
            input: {
              type: 'object',
              additionalProperties: true,
              description: 'input object handed to the workflow',
            },
          },
        }),
        execute: async ({ input }: { input?: Record<string, unknown> }, options: any) => {
          // Parent-scoped, for the same reason as agent-tool's nested runId above: a toolCallId is
          // unique within a completion, not across runs.
          // Ajan İÇİNDEN doğan iş akışı: ebeveynin kimliğini devralır. "Org düzeyi iş, öznesi yok"
          // muafiyeti bu doğum yolu için yanlış — bu, belli bir kullanıcının koşumundan çıkıyor.
          // The workflow run's id is the engine's (`wf:<parent>:<call>`): begun here, from the parent's call.
          const r = await runWorkflow(wfName, input ?? {}, minted({
            runId: nestedAgentRunId(options?.parentRunId, options?.toolCallId, 'wf'),
            // The calling run's identity (options.gnl) — a child run is its parent's caller.
            parent: identityOf(options),
            ...(identity?.actor ? { actor: identity.actor } : {}),
          }));
          return r.suspended
            ? { suspended: true, stepId: r.stepId, reason: r.reason, runId: r.runId }
            : { output: r.output, runId: r.runId };
        },
      }), { idempotent: true });
    }
    return out;
  }

  /**
   * `a.agents` names as `agent_<name>` tools. A sub-agent is a run of the engine like any other — the
   * same `runAgent` a direct run goes through, so it has every protection that run has (its own
   * processors, scorers, sub-agents, guard, preset) — born one frame below the run that delegated:
   * that run's caller, cancellation and approvals come down in the frame, the protections it runs
   * under come down as options (CHILD_RUN_POLICY), and taint crosses both ways (agent-tool.ts).
   */
  function buildSubAgentTools(names: string[] | undefined, rc: RequestContext, parentOpts: RunOptions): ToolSet {
    const out: ToolSet = {};
    for (const subName of names ?? []) {
      const sub = agent(subName); // early, clear error if not registered
      out[`agent_${subName}`] = delegationTool(
        sub.description ?? `Delegate a task to the '${subName}' agent`,
        journal,
        async (task, nestedRunId, frame) => {
          // The sub-agent's id is the engine's (`agent:<parent>:<call>`): begun here, from the parent's call.
          const r = await runAgent(subName, minted(childRunOptions(parentOpts, { runId: nestedRunId, prompt: task, context: rc })), frame);
          return { text: r.text, interrupts: r.interrupts, steps: r.steps };
        },
        { agent: subName },
      );
    }
    return out;
  }

  /**
   * What a COMPLETED agent run gets after it ended, whichever path ran it (a direct `run()`, a sub-agent):
   * its scorers (memoized per run — exactly once), and the learning pass (not for a sub-agent's run).
   */
  async function afterCompletedRun(name: string, opts: RunOptions, runId: string, result: any, who: { resourceId?: string; threadId?: string; frame?: ChildFrame } = {}): Promise<void> {
    const a = agent(name);
    const effectiveResourceId = who.resourceId;
    const effectiveThreadId = who.threadId;
    const frame = who.frame;
    // C4 runtime scoring: only on a COMPLETED run (not suspended). Each scorer is memoized to the
    // journal → doesn't rerun on resume/repeat calls (exactly-once), returns the same score.
    // P1.2: opt-in sampling (AgentConfig.scorerSampling) gates the WHOLE block — a skipped run writes
    // NOTHING (durableProcessorStep, and hence the `proc:eval:*` journal key, is never reached), and the
    // decision is deterministic per runId so resume/replay can't flip it (see shouldSampleScorers).
    if (a.scorers?.length && result.interrupts.length === 0 && shouldSampleScorers(runId, effectiveScorerRate(a))) {
      const scores: Record<string, unknown> = {};
      // The sample and the memo are the run-scoring owner's (scoring.ts: runScoreSample,
      // scoreRunMemoized) — the same calls scoreRun makes, so scoring this run again from Studio
      // replays this memo instead of asking the judge twice. The output is the owner's too: the run's
      // journaled returned output when an output processor changed it (result.text is that same text).
      // RAG context isn't available here — see ScorerLike.
      const sample = await runScoreSample(journal, runId, { output: (result as any).text ?? '' });
      for (const s of a.scorers) {
        scores[s.name] = await scoreRunMemoized(journal, runId, s, sample);
      }
      (result as any).scores = scores;
      // P2-skor a SECOND, ADDITIVE metrics pass — recordRunMetrics (run.ts's
      // completion choke points) already ran and cannot see `scores` (computed HERE, after it runs —
      // see the comment on that call below). Best-effort/non-blocking: a scoring bug or a journal
      // without incrBy/applyBatch must never fail an otherwise-successful run. Only reached on the
      // sampled-IN path (shouldSampleScorers above) — see recordRunScores's JSDoc for the resulting bias.
      recordRunScores(journal, runId, name, scores as Record<string, number | { score: number }>).catch(() => {});
    }

    // HERMES generate: the learning pass runs only on a COMPLETED run (an interrupted run is an
    // unfinished story — no lesson yet), memoized AT-MOST-ONCE per runId inside generateFor, and
    // best-effort by contract: a learning failure must never fail an otherwise-successful run.
    // stream() has no auto-pass (a stream returns before completion); hosts call
    // gnl.suggestions.generateFor from their finish hook when they want streamed runs to learn.
    // A sub-agent's run applies the person's lessons (above) but does not learn: what it did comes back
    // in its parent's answer, and the parent's run is the one the person had — one learning pass per
    // request, not one per delegation, and no lesson drawn from a task a model wrote for another.
    if (suggestionsApi && config.suggestions?.generate && result.interrupts.length === 0 && !frame) {
      try {
        await suggestionsApi.generateFor({
          runId,
          resourceId: effectiveResourceId,
          threadId: effectiveThreadId,
          ...(typeof opts.prompt === 'string' && opts.prompt ? { prompt: opts.prompt } : {}),
          output: (result as any).text ?? '',
        });
      } catch { /* best-effort — see the contract above */ }
    }

  }

  // ── DETACHED: an agent run executes apart from the call that started it (detached.ts) ──────────
  //
  // `stream()` and `run()` start the run on this process's executor for the store (executors.ts) — or
  // join it, when it already executes here or in a live process — and return a FOLLOW of it (`stream`)
  // or a wait for its end (`run`). Whose run it is, is the engine's own admission (`admitAgentRun`),
  // asked before anything is executed or joined. A process that dies mid-run has its runs continued by
  // another, from the journal.
  function executor(): Promise<DetachedRuns> {
    return executorFor(journal, {
      resume: (rec) => resumeLaunch(rec),
      // The store's liveness: given, else the store's own (the storage's, or the run journal's own when
      // only a journal was handed over).
      liveness: {
        ...(config.liveness ? { given: config.liveness } : {}),
        own: () => {
          const source = (config.storage ?? journal) as { processLiveness?: () => ProcessLiveness | Promise<ProcessLiveness> };
          return source.processLiveness?.();
        },
      },
      ...(config.detached ? { options: config.detached } : {}),
    });
  }

  /**
   * How this process continues a run it did not start (a takeover, an approval that arrived elsewhere):
   * as its RECORDED owner, from its recorded input — nothing of the original call is needed, and nothing
   * about a person is kept outside the run's own records.
   */
  async function resumeLaunch(rec: ExecRecord): Promise<Launch> {
    const agentName = (rec.meta as { agent?: string } | undefined)?.agent;
    if (!agentName) throw new Error(`@gnldev/durable: run '${rec.runId}' names no agent to continue it with`);
    const owner = await runOwnerOf(journal as any, rec.runId);
    if (owner.state !== 'owned') throw new Error(`@gnldev/durable: run '${rec.runId}' has no owner to continue it as`);
    // A background call's task or continuation is continued from what made it (deferred.ts), never
    // from a call: the spec its launcher recorded, the task's own record.
    const deferred = (rec.meta as { deferred?: string } | undefined)?.deferred;
    if (deferred) {
      const parentRunId = (owner.record as { parentRunId?: unknown } | undefined)?.parentRunId;
      if (typeof parentRunId !== 'string') throw new Error(`@gnldev/durable: run '${rec.runId}' names no run it was made for`);
      const toolCallId = toolCallIdOf(rec.runId, deferred === 'task' ? 'task' : 'cont', parentRunId);
      if (!toolCallId) throw new Error(`@gnldev/durable: run '${rec.runId}' is not a background call's run`);
      if (deferred === 'task') return taskLaunch(agentName, await taskArgs(agentName, rec.runId, await taskSpecOf(parentRunId, toolCallId)));
      const c = await continuationFor(agentName, parentRunId, toolCallId);
      if (!c) throw new Error(`@gnldev/durable: run '${rec.runId}' has no ended task to answer`);
      return (signal) => streamDurable({ ...c.args, abortSignal: signal });
    }
    const threadId = (owner.record as { threadId?: unknown } | undefined)?.threadId;
    const args = await streamArgs(agentName, { runId: rec.runId, caller: owner.owner, ...(typeof threadId === 'string' ? { threadId } : {}) });
    return (signal) => streamDurable({ ...args, abortSignal: signal });
  }

  // ── BACKGROUND TOOLS (types.ts `background`, deferred.ts) ─────────────────────────────────────────
  //
  // A background tool reaches the model as a LAUNCHER: an idempotent call that starts the task run and
  // answers `{ status: 'started', taskId }`. The task executes the tool's body; its end wakes the agent
  // with ONE continuation run. Each is started through this process's executor and admitted by the
  // engine as the parent's recorded owner; nothing here decides whose a run is.

  /** The tool a launcher stands for. */
  const BACKGROUND_BODY = Symbol('gnl.backgroundBody');
  /**
   * The spec a task executes, recorded by its launcher under the PARENT (the run that made the call, and
   * whose erasure takes it) before the task exists — a key under the task's own id would be a row of a
   * run with no owner yet. A takeover of the task reads it there; so does every reader of the call's
   * outcome, for which it makes the call its task's (call-outcome.ts `callRecordKey`).
   */
  const taskSpecKey = runKeys.taskSpec;

  function withBackgroundTools(name: string, tools: ToolSet): ToolSet {
    let out: ToolSet | undefined;
    for (const [toolName, t] of Object.entries(tools)) {
      if ((t as AnyTool | undefined)?.background !== true) continue;
      // The launcher keeps the tool's surface (description, schema) and its `confirm` — a person is asked
      // before the task starts — and none of its durability: the body's declarations are the task's.
      const launcher: Record<string | symbol, unknown> = { ...t };
      for (const k of TOOL_DURABILITY_NAMES) delete launcher[k];
      Object.assign(launcher, {
        idempotent: true,
        ...((t as AnyTool).confirm !== undefined ? { confirm: (t as AnyTool).confirm } : {}),
        execute: async (input: unknown, options: { toolCallId?: string; gnl?: GnlToolContext }) =>
          ({ status: 'started', taskId: await startTask(name, toolName, input, options) }),
        [BACKGROUND_BODY]: t,
      });
      (out ??= { ...tools })[toolName] = launcher as AnyTool;
    }
    return out ?? tools;
  }

  /** The launcher's work: record the spec, start the task (or find it started). Returns its run id. */
  async function startTask(name: string, toolName: string, input: unknown, options: { toolCallId?: string; gnl?: GnlToolContext }): Promise<string> {
    const parent = options.gnl?.identity;
    if (!parent?.runId || !options.toolCallId) throw new Error(`@gnldev/durable: background tool '${toolName}' was called outside a run`);
    const runId = deferredTaskRunId(parent.runId, options.toolCallId);
    const spec: TaskSpec = { gnlTask: 1, tool: toolName, parentRunId: parent.runId, toolCallId: options.toolCallId, requestRunId: requestOf(parent), input };
    // First writer wins: a repeated or replayed call executes the spec the first one recorded.
    await journalClaim(journal, taskSpecKey(spec.parentRunId, spec.toolCallId), spec);
    const args = await taskArgs(name, runId, await taskSpecOf(spec.parentRunId, spec.toolCallId));
    const runs = await executor();
    const scope = orgScopeOf(journal);
    await runs.start(withMintOf({ runId, ...(scope !== undefined ? { scope } : {}), admit: () => admitAgentRun(args), meta: { agent: name, deferred: 'task' }, launch: taskLaunch(name, args) }, args));
    return runId;
  }

  async function taskSpecOf(parentRunId: string, toolCallId: string): Promise<TaskSpec> {
    const spec = decodeTaskSpec(JSON.stringify((await journal.get(taskSpecKey(parentRunId, toolCallId))) ?? null));
    if (!spec) throw new Error(`@gnldev/durable: run '${parentRunId}' recorded no background call '${toolCallId}'`);
    return spec;
  }

  /** The parent's recorded owner and thread — whom its background call's runs are for, and where they answer. */
  async function parentRecordOf(parentRunId: string, runId: string) {
    // A run made by a deleted run is deleted with it: refused before anything of it is built.
    await assertNotErased(journal, runId, await erasureBaseline(journal, parentRunId));
    const owner = await runOwnerOf(journal as any, parentRunId);
    if (owner.state !== 'owned') throw new Error(`@gnldev/durable: run '${parentRunId}' has no owner for its background call`);
    const threadId = (owner.record as { threadId?: unknown } | undefined)?.threadId;
    return { owner: owner.owner, ...(typeof threadId === 'string' ? { threadId } : {}) };
  }

  /** The task's run: the agent's run settings, the task model, the one tool, no memory, as the parent's owner. */
  async function taskArgs(name: string, runId: string, spec: TaskSpec): Promise<any> {
    const { owner, threadId } = await parentRecordOf(spec.parentRunId, runId);
    const base = await streamArgs(name, { runId, caller: owner, prompt: encodeTaskSpec(spec), ...(threadId ? { threadId } : {}) });
    const launcher = base.tools?.[spec.tool] as Record<symbol, unknown> | undefined;
    const t = launcher?.[BACKGROUND_BODY] as AnyTool | undefined;
    if (!t) throw new Error(`@gnldev/durable: agent '${name}' has no background tool '${spec.tool}' to run task '${runId}' with`);
    const { background: _b, confirm: _c, ...body } = t;
    // Built by the engine from the parent's recorded call: the one place a task's run is begun from.
    return minted({
      ...base,
      model: taskModel(),
      tools: { [spec.tool]: body },
      caller: runIdentity(owner, runId, { ...(threadId ? { threadId } : {}), parentRunId: spec.parentRunId, ...(spec.requestRunId ? { requestRunId: spec.requestRunId } : {}) }),
      // The call was already gated in the parent (guard, confirm); the task speaks to nobody.
      memory: false, system: undefined, guard: undefined, processors: undefined, approvals: undefined,
      stopWhen: stepCountIs(2),
    });
  }

  /**
   * The task's run, whose ENDING wakes the agent (detached.ts `LaunchEnd`): the executor calls it when an
   * execution ends the task — the one that ran it, or one that only closes it after its process died —
   * and releases the task to the next sweep when it throws, so a wake that a store error or a drain
   * interrupted is done again instead of dropped.
   */
  function taskLaunch(name: string, args: any): Launch {
    return async (signal) => {
      const result: any = await streamDurable({ ...args, abortSignal: signal });
      const spec = decodeTaskSpec(args.prompt)!;
      const end: LaunchEnd = (_state, s) => wake(name, spec, s);
      return Object.assign(result, { end });
    };
  }

  /**
   * The continuation of a task that ended: its question (the result, from the task's record), and its
   * run's arguments — the agent's own run on the parent's thread, as the parent's owner. `undefined`
   * when the task has not ended.
   */
  async function continuationFor(name: string, parentRunId: string, toolCallId: string) {
    const runId = deferredContinuationRunId(parentRunId, toolCallId);
    const taskRunId = deferredTaskRunId(parentRunId, toolCallId);
    const { owner, threadId } = await parentRecordOf(parentRunId, runId);
    const outcome = await taskOutcome(journal, taskRunId, toolCallId);
    if (!outcome) return undefined;
    const spec = await taskSpecOf(parentRunId, toolCallId);
    const base = await streamArgs(name, { runId, caller: owner, prompt: continuationPrompt(taskRunId, spec.tool, outcome), ...(threadId ? { threadId } : {}) });
    return { runId, threadId, args: minted({ ...base, caller: runIdentity(owner, runId, { ...(threadId ? { threadId } : {}), parentRunId }) }) };
  }

  /** Wakes the agent once: when the thread has no live turn, the continuation is started (or found started). */
  async function wake(name: string, spec: TaskSpec, signal: AbortSignal): Promise<void> {
    const taskRunId = deferredTaskRunId(spec.parentRunId, spec.toolCallId);
    const runs = await executor();
    const scope = orgScopeOf(journal);
    // A refusal here (the conversation was deleted meanwhile) ends the task with it: the executor reads
    // the erasure and settles the task away.
    const c = await continuationFor(name, spec.parentRunId, spec.toolCallId);
    // Ended while its call may have run (its claim is there, its outcome is not): not ended — given back,
    // and the next execution takes the call up where the crash ladder says. A call that never ran is
    // decided by `taskOutcome` (the task failed).
    if (!c) throw new Error(`@gnldev/durable: background task '${taskRunId}' ended before its call was settled`);
    if (c.threadId) {
      await takeThreadTurn(journal, c.threadId, { runId: c.runId, parentRunId: spec.parentRunId, waiting: taskRunId, baseline: await erasureBaseline(journal, spec.parentRunId) },
        (ids) => runs.executing(scope, ids), { pollMs: config.detached?.pollMs ?? 200, signal });
    }
    await runs.start(withMintOf({
      runId: c.runId, ...(scope !== undefined ? { scope } : {}),
      admit: () => admitAgentRun(c.args), meta: { agent: name, deferred: 'continuation' },
      launch: (s) => streamDurable({ ...c.args, abortSignal: s }),
    }, c.args));
  }

  /**
   * The run a call names, when it is a background call's task or continuation that exists: its arguments
   * as what made it builds them (the task's spec and model, the continuation's question), with the
   * CALLER's identity, actor and approvals — so the engine's admission judges this caller against the
   * run's recorded owner, as for any run (a stranger is refused there), and an approval reaches the run it
   * names. `undefined` for any other run (and for an id nobody has made: that is a run like any other).
   */
  async function derivedRunFor(name: string, requested: any): Promise<{ kind: 'task' | 'continuation'; args: any } | undefined> {
    const runId: string = requested.runId;
    const family = runIdFamilyOf(runId);
    const kind = family === 'task' ? 'task' : family === 'cont' ? 'continuation' : undefined;
    if (!kind) return undefined;
    const owner = await runOwnerOf(journal as any, runId);
    const parentRunId = owner.state === 'owned' ? (owner.record as { parentRunId?: unknown } | undefined)?.parentRunId : undefined;
    if (typeof parentRunId !== 'string') return undefined;
    const toolCallId = toolCallIdOf(runId, kind === 'task' ? 'task' : 'cont', parentRunId);
    if (!toolCallId) return undefined;
    const base = kind === 'task'
      ? await taskArgs(name, runId, await taskSpecOf(parentRunId, toolCallId))
      : (await continuationFor(name, parentRunId, toolCallId))?.args;
    if (!base) return undefined;
    const place = { ...(base.caller?.threadId ? { threadId: base.caller.threadId } : {}), parentRunId, ...(base.caller?.requestRunId ? { requestRunId: base.caller.requestRunId } : {}) };
    return {
      kind,
      args: {
        ...base,
        caller: runIdentity(requested.caller, runId, place),
        ...(requested.actor !== undefined ? { actor: requested.actor } : {}),
        approvals: requested.approvals,
      },
    };
  }

  /** Starts (or joins) the run a call names, and follows it from the caller's cursor. */
  async function startFollowed(name: string, opts: RunOptions, surface: 'stream' | 'run') {
    const { abortSignal, after, ...rest } = opts;
    if (surface === 'run') refuseRunNames(`run('${name}')`, rest);
    // The reader's cursor, read before anything is started: one that is not a cursor is refused.
    const from = after === undefined ? undefined : readCursor(after);
    const requested = await streamArgs(name, rest);
    // A background call's run named by a caller (an answer to the task's question for a human): it is
    // continued as what it is — from what made it — for THIS caller, whom the admission below judges.
    const derived = await derivedRunFor(name, requested);
    const args = derived?.args ?? requested;
    // A background call's task and continuation are begun by the engine only, from the parent's recorded
    // call (`derived` above carries its mark); the run-id gate at their birth (`claimRunOwner`, reached
    // through `admitAgentRun`) refuses a caller naming one the engine has not made — before, it was
    // admitted as an ordinary run owned by that caller, so a stranger who knew a parent run id and a tool
    // call id took the id first and the owner's task never ran (audit B1).
    const runId: string = args.runId;
    // Whether this call lands on a run that already had its input (a retry, a resume): a door's
    // `X-Gnl-Idempotency-Status: replay`. Read before the admission writes a new run's owner.
    const priorInput = await journal.get<{ prompt?: unknown; messages?: unknown }>(runKeys.input(runId)).catch(() => undefined);
    const priorRun = priorInput !== undefined && (priorInput.prompt !== undefined || priorInput.messages !== undefined);
    const runs = await executor();
    const scope = orgScopeOf(journal);
    const started = await runs.start(withMintOf({
      runId, ...(scope !== undefined ? { scope } : {}),
      admit: () => admitAgentRun(args),
      meta: { agent: name, ...(derived ? { deferred: derived.kind } : {}) },
      resumeIntent: opts.approvals !== undefined,
      launch: derived?.kind === 'task' ? taskLaunch(name, args) : (signal) => streamDurable({ ...args, abortSignal: signal }),
    }, args));
    // The caller's "stop": the run is canceled, durably, wherever it executes (see RunOptions.abortSignal).
    if (abortSignal) {
      const cancel = () => {
        void runs.cancel({ runId, ...(scope !== undefined ? { scope } : {}), reason: String((abortSignal.reason as Error | undefined)?.message ?? abortSignal.reason ?? 'aborted') }).catch(() => undefined);
      };
      if (abortSignal.aborted) cancel(); else abortSignal.addEventListener('abort', cancel, { once: true });
    }
    // A run that ended before runs had an event log (or whose log is gone) has nothing to follow: its
    // answer is replayed from its journal instead — a completed run calls no model and runs no tool.
    if (started.state === 'finished' && !(await lastRunEvent(journal, runId))) {
      const replayed: any = await streamDurable({ ...args });
      Object.defineProperty(replayed, '__gnlPriorRun', { value: priorRun });
      return { args, followed: replayed };
    }
    const followed = followedRun(runs, { runId, ...(scope !== undefined ? { scope } : {}), journal, after: from ?? started.from, state: started.state });
    Object.defineProperty(followed, '__gnlPriorRun', { value: priorRun });
    return { args, followed };
  }

  async function stream(name: string, opts: RunOptions) {
    return (await startFollowed(name, opts, 'stream')).followed;
  }

  /**
   * The run's result when it has ended (or waits on a human): its text (the RETURNED output when an
   * output processor changed it), steps, interrupts, finish reason and usage. A run that failed rejects
   * with its error — same name and code as the error the engine threw.
   */
  async function run(name: string, opts: RunOptions) {
    const { args, followed } = await startFollowed(name, opts, 'run');
    const [ending, steps, finishReason, usage] = await Promise.all([followed.ended, followed.steps, followed.finishReason, followed.usage]);
    // A run that stopped for a human because nothing could settle a call (side_effect_retry_blocked): it
    // waits (pending lists it), and the caller is told why, as before — with the engine's error.
    if (ending?.state === 'waiting-approval' && ending.error) throw errorOf(ending.error);
    // A call whose outcome is unknown (OutcomeUnknownError): the run waits for its result and continues
    // from it on its own (detached.ts); the caller is told why now, as for a run waiting on a human.
    if (ending?.state === 'waiting-outcome') throw errorOf(ending.error ?? { message: `run '${followed.runId}' waits for a call's outcome`, name: 'OutcomeUnknownError' });
    if (ending?.state === 'canceled') throw ending.error ? errorOf(ending.error) : new RunCanceledError(followed.runId);
    if (ending?.state === 'failed') throw errorOf(ending.error ?? { message: `run '${followed.runId}' failed` });
    const returned = await journal.get<{ text?: unknown }>(runKeys.output(followed.runId)).catch(() => undefined);
    const text = typeof returned?.text === 'string' ? returned.text : (steps[steps.length - 1]?.text ?? '');
    const result: any = {
      runId: followed.runId, text, steps, finishReason, usage, totalUsage: usage,
      toolCalls: steps.flatMap((x: any) => x.toolCalls), toolResults: steps.flatMap((x: any) => x.toolResults),
      interrupts: ending?.state === 'waiting-approval' ? (ending.interrupts ?? []) : [],
    };
    await afterCompletedRun(name, opts, followed.runId, result, { resourceId: userIdOf(args.caller), ...(args.threadId ? { threadId: args.threadId } : {}) });
    return result;
  }

  /**
   * The one birth of an agent run. A direct run (`run`) has no frame; a sub-agent's run has the frame
   * its delegation hands down — whom it runs for, the parent's cancellation and approvals — and is
   * otherwise the same run: same preset, same gates, same processors, scorers and sub-agents.
   */
  async function runAgent(name: string, opts: RunOptions, frame?: ChildFrame) {
    refuseRunNames(`run('${name}')`, opts);
    if (config.preset === 'critical') {
      opts = {
        ...opts,
        toolPolicy: opts.toolPolicy ?? 'strict-critical',
        exclusiveModelStep: opts.exclusiveModelStep ?? {},
        // Sınıf-bazlı matris (heyet): beyansız araç default hücresiyle BUGÜNKÜ davranışta kalır
        // (thread-suspend); beyanlı araç kendi hücresini alır (idempotent-write'ta soru sorulmaz vb.).
        limits: { sideEffectDuplicates: { byClass: PRESET_MATRIX.critical, default: PRESET_DEFAULT.critical }, ...(opts.limits ?? {}) },
        strictInput: opts.strictInput ?? true,
        conflictLedger: opts.conflictLedger ?? true,
        tombstonePolicy: opts.tombstonePolicy ?? 'reject',
      };
    } else if (config.preset === 'assistant' || config.preset === 'headless') {
      // Hafif profiller: YALNIZ tekrar-politikası matrisi (+ assistant'ta dürüst anlatım default'u).
      // critical'ın kilit/fingerprint/ledger paketi bilinçli olarak gelmez.
      opts = {
        ...opts,
        limits: { sideEffectDuplicates: { byClass: PRESET_MATRIX[config.preset], default: PRESET_DEFAULT[config.preset] }, ...(opts.limits ?? {}) },
        ...(config.preset === 'assistant' ? { replayDisclosure: opts.replayDisclosure ?? 'explain' } : {}),
      };
    }
    const a = agent(name);
    const rc = opts.context ?? {};
    // P1.7: a server-sealed resourceId/threadId (sealRequestContext) ALWAYS wins over opts.resourceId/
    // opts.threadId when present — see the RunOptions.resourceId/threadId precedence note below.
    const serverIdentity = serverIdentityOf(rc);
    assertNoCallerSystemMessage({ ...opts, fromDoor: cameThroughDoor(opts.context) });
    // A child runs for the caller of the run that delegated; that run already passed every door gate.
    const caller = frame ? frame.identity : callerOfCall(rc, opts);
    const effectiveResourceId = userIdOf(caller);
    const effectiveThreadId = frame ? frame.identity.threadId : (serverIdentity.threadId ?? opts.threadId);
    // THE GATE (package #3), before the model is resolved and therefore before anything touches the
    // journal: from here on `runId` is the run's id — either the raw one the caller passed or the one
    // the engine derived from their workKey. The scope comes from the AGENT, not from the call: which
    // address a name is unique within is a property of the work an agent does, and a per-call override
    // would put the dangerous half ('org', see AgentConfig.workScope) within reach of a request body.
    const identity = resolveWorkIdentity(`agent:${name}`, {
      ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
      ...(opts.workKey !== undefined ? { workKey: opts.workKey } : {}),
      scopeKind: a.workScope ?? 'resource',
      ...(effectiveResourceId ? { resourceId: effectiveResourceId } : {}),
      ...(serverIdentity.orgId ? { orgId: serverIdentity.orgId } : {}),
      anonymous: 'refuse',
      surface: `run('${name}')`,
    });
    const runId = identity.runId!;
    const model = await materializeModel(opts.model ?? (await resolveDyn(a.model, rc)), runId);
    const agentTools = a.tools ? await resolveDyn(a.tools, rc) : undefined;
    // Sub-agent and workflow tools take the caller from the CALL (options.gnl), not from here.
    const subTools = buildSubAgentTools(a.agents, rc, {
      ...opts,
      ...((serverIdentity.resourceId ?? opts.actor) ? { actor: serverIdentity.resourceId ?? opts.actor } : {}),
    });
    const wfTools = buildWorkflowTools(a.workflows, {
      ...((serverIdentity.resourceId ?? opts.actor) ? { actor: serverIdentity.resourceId ?? opts.actor } : {}),
    });
    const system = opts.system ?? (a.system ? await resolveDyn(a.system, rc) : undefined);
    const processors = [...(config.processors ?? []), ...(a.processors ?? [])];
    const mergedTools = { ...config.tools, ...agentTools, ...subTools, ...wfTools };
    // Playground tool allow-list: expose only the requested subset to the model (agent tools unchanged).
    const runTools = opts.tools ? Object.fromEntries(Object.entries(mergedTools).filter(([n]) => opts.tools!.includes(n))) : mergedTools;
    // HERMES apply: the lesson block is FROZEN per runId (claim, empty included) BEFORE composing the
    // system prompt — a retry of the same runId sees the identical prompt even if a lesson was
    // approved in between (strictInput's fingerprint stays honest). See suggestions.ts.
    let effectiveSystem = system;
    if (suggestionsApi) {
      const inj = await suggestionsApi.prepareInjection(runId, effectiveResourceId);
      if (inj.text) effectiveSystem = effectiveSystem ? `${effectiveSystem}\n\n${inj.text}` : inj.text;
    }
    // A run the engine begins for an id only it may begin (a sub-agent's, a network step's) carries its
    // mark from the options it was handed (`minted`) — the mark is bound to the id, so nothing else passes.
    const result = await runDurable(withMintOf({
      runId,
      journal: journal,
      agentName: name,
      origin: cameThroughDoor(opts.context) ? 'door' : 'host',
      ...(opts.trustRecordedInput === true && !cameThroughDoor(opts.context) ? { trustRecordedInput: true } : {}),
      model,
      tools: runTools,
      system: effectiveSystem,
      guard: a.guard,
      // A child works on a task, not on the conversation: it neither reads the thread's history nor
      // writes its own exchange into it. The thread still names whose work it is (ownership).
      memory: frame ? undefined : memoryArg,
      threadId: effectiveThreadId,
      caller,
      // SAHİPLİK DAMGASI — ÖNCELİK BURADA KURULUR: mühürlü kimlik kazanır, çağıranın beyanı değil.
      // Bu satır eklendiğinde aşağıda ayrıca `...(opts.actor ? { actor: opts.actor } : {})` vardı ve
      // object-literal'de SON yazan kazandığı için damgayı EZİYORDU. Sonuç sessizdi: doğrulanmış
      // kimlikten basılan damganın üzerine isteğin gövdesinden gelen bir değer geçiyordu — yani
      // sahiplik kilidi kendi kendine verilebilir hale geliyordu, ki o zaman kilit değildir.
      // opts.actor SİLİNMEDİ, geri plana alındı: mühür kurmayan hostlar (kendi rotasını yazan
      // uygulamalar, CLI, testler) için tek kimlik kanalı odur — ama yalnız mühürlü kimlik YOKKEN.
      ...((serverIdentity.resourceId ?? opts.actor) ? { actor: serverIdentity.resourceId ?? opts.actor } : {}),
      approvals: frame?.approvals ?? opts.approvals,
      stopWhen: stepCountIs(a.maxSteps ?? 12),
      ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
      ...(opts.topP != null ? { topP: opts.topP } : {}),
      ...(processors.length ? { processors } : {}),
      ...(opts.limits ? { limits: opts.limits } : {}),
      // Forward the protections that were previously runDurable-only.
      ...(opts.toolPolicy ? { toolPolicy: opts.toolPolicy } : {}),
      // FAZ-4 critical-profile forwards (no-ops unless set — see RunOptions).
      ...(opts.strictInput !== undefined ? { strictInput: opts.strictInput } : {}),
      ...(opts.conflictLedger !== undefined ? { conflictLedger: opts.conflictLedger } : {}),
      ...(opts.auditOnReject ? { auditOnReject: opts.auditOnReject } : {}),
      ...((opts.replayDisclosure ?? config.replayDisclosure) ? { replayDisclosure: opts.replayDisclosure ?? config.replayDisclosure } : {}),
      ...(opts.channel ? { channel: opts.channel } : {}),
      ...(opts.tombstonePolicy ? { tombstonePolicy: opts.tombstonePolicy } : {}),
      ...(config.schemaCompat ? { schemaCompat: config.schemaCompat } : {}),
      ...(opts.replay ? { replay: opts.replay } : {}),
      ...(opts.timeouts ? { timeouts: opts.timeouts } : {}),
      ...(opts.exclusiveModelStep ? { exclusiveModelStep: opts.exclusiveModelStep } : {}),
      ...((frame?.abortSignal ?? opts.abortSignal) ? { abortSignal: frame?.abortSignal ?? opts.abortSignal } : {}), // P0.2: see RunOptions.abortSignal; a child stops with its parent
      // The declaration travels with the run so package #2's writer can freeze it into `:input`:
      // the id is opaque, and the answer to "which run was the invoice job?" has to live somewhere
      // a person can read. Only present when the id was DERIVED — a raw runId declared nothing.
      ...(identity.work ? { workKey: identity.work.workKey, workScope: identity.work.workScope } : {}),
      ...(opts.messages ? { messages: opts.messages } : { prompt: opts.prompt }),
    } as any, opts));

    await afterCompletedRun(name, opts, runId, result, { resourceId: effectiveResourceId, threadId: effectiveThreadId, frame });

    // P1.6b: materialized metrics recording moved from here DOWN into run.ts's completion choke points
    // (next to recordRunUsage in runDurableInner AND in streamDurable's onFinish) — ONE source covers
    // run()/stream()/resume/bare-runDurable alike; no registry-level hook needed. See metrics.ts.
    return result;
  }

  // The streaming counterpart of run: resolves model/tools/system/guard/memory/processors the SAME way.
  // The only difference (per streamDurable's docs): output processors only apply to messages that get
  // persisted — streamed text-deltas can't be retroactively transformed.
  // (a): streamDurable now ENFORCES the run-lock (acquire at start, release on stream finish) →
  // opts.lock is forwarded. FAZ-7: the streamed lock now SELF-RENEWS on a ttl/2 heartbeat (parity
  // with run()) — the old "no heartbeat, use a generous ttl" bound is closed; ttlMs is back to being
  // the crash-takeover window, not a worst-case-duration estimate.
  // P1.6b: streamed runs' materialized-metrics recording lives in streamDurable's onFinish (run.ts,
  // next to recordRunUsage) — the former TODO here is closed; no backfill dependency remains.
  /** Everything `streamDurable` is called with for this agent and call — resolved once, the same way `runAgent` resolves it. */
  async function streamArgs(name: string, opts: RunOptions): Promise<any> {
    refuseRunNames(`stream('${name}')`, opts);
    if (config.preset === 'critical') {
      opts = {
        ...opts,
        toolPolicy: opts.toolPolicy ?? 'strict-critical',
        exclusiveModelStep: opts.exclusiveModelStep ?? {},
        // Sınıf-bazlı matris (heyet): beyansız araç default hücresiyle BUGÜNKÜ davranışta kalır
        // (thread-suspend); beyanlı araç kendi hücresini alır (idempotent-write'ta soru sorulmaz vb.).
        limits: { sideEffectDuplicates: { byClass: PRESET_MATRIX.critical, default: PRESET_DEFAULT.critical }, ...(opts.limits ?? {}) },
        strictInput: opts.strictInput ?? true,
        conflictLedger: opts.conflictLedger ?? true,
        tombstonePolicy: opts.tombstonePolicy ?? 'reject',
      };
    } else if (config.preset === 'assistant' || config.preset === 'headless') {
      // Hafif profiller: YALNIZ tekrar-politikası matrisi (+ assistant'ta dürüst anlatım default'u).
      // critical'ın kilit/fingerprint/ledger paketi bilinçli olarak gelmez.
      opts = {
        ...opts,
        limits: { sideEffectDuplicates: { byClass: PRESET_MATRIX[config.preset], default: PRESET_DEFAULT[config.preset] }, ...(opts.limits ?? {}) },
        ...(config.preset === 'assistant' ? { replayDisclosure: opts.replayDisclosure ?? 'explain' } : {}),
      };
    }
    const a = agent(name);
    const rc = opts.context ?? {};
    // P1.7: same server-identity precedence as run() above — see RunOptions.threadId/resourceId JSDoc.
    const serverIdentity = serverIdentityOf(rc);
    assertNoCallerSystemMessage({ ...opts, fromDoor: cameThroughDoor(opts.context) });
    const caller = callerOfCall(rc, opts);
    const effectiveResourceId = userIdOf(caller);
    const effectiveThreadId = serverIdentity.threadId ?? opts.threadId;
    // THE GATE, the same call run() makes and deliberately not a variation of it (see
    // resolveWorkIdentity): chat-adapter and agui stream, so a rule that held only on the generate
    // path would be a rule missing from the two doors most requests actually arrive through.
    const identity = resolveWorkIdentity(`agent:${name}`, {
      ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
      ...(opts.workKey !== undefined ? { workKey: opts.workKey } : {}),
      scopeKind: a.workScope ?? 'resource',
      ...(effectiveResourceId ? { resourceId: effectiveResourceId } : {}),
      ...(serverIdentity.orgId ? { orgId: serverIdentity.orgId } : {}),
      anonymous: 'refuse',
      surface: `stream('${name}')`,
    });
    const runId = identity.runId!;
    const model = await materializeModel(opts.model ?? (await resolveDyn(a.model, rc)), runId);
    const agentTools = a.tools ? await resolveDyn(a.tools, rc) : undefined;
    // Sub-agent and workflow tools take the caller from the CALL (options.gnl), not from here.
    const subTools = buildSubAgentTools(a.agents, rc, {
      ...opts,
      ...((serverIdentity.resourceId ?? opts.actor) ? { actor: serverIdentity.resourceId ?? opts.actor } : {}),
    });
    const wfTools = buildWorkflowTools(a.workflows, {
      ...((serverIdentity.resourceId ?? opts.actor) ? { actor: serverIdentity.resourceId ?? opts.actor } : {}),
    });
    const system = opts.system ?? (a.system ? await resolveDyn(a.system, rc) : undefined);
    const processors = [...(config.processors ?? []), ...(a.processors ?? [])];
    const mergedTools = { ...config.tools, ...agentTools, ...subTools, ...wfTools };
    // A background tool reaches the model as its launcher (see BACKGROUND TOOLS above).
    const runTools = withBackgroundTools(name, opts.tools ? Object.fromEntries(Object.entries(mergedTools).filter(([n]) => opts.tools!.includes(n))) : mergedTools);
    // HERMES apply: same frozen-injection contract as run() — see the note there.
    let effectiveSystem = system;
    if (suggestionsApi) {
      const inj = await suggestionsApi.prepareInjection(runId, effectiveResourceId);
      if (inj.text) effectiveSystem = effectiveSystem ? `${effectiveSystem}\n\n${inj.text}` : inj.text;
    }
    return ({
      runId,
      journal: journal,
      agentName: name,
      origin: cameThroughDoor(opts.context) ? 'door' : 'host',
      ...(opts.trustRecordedInput === true && !cameThroughDoor(opts.context) ? { trustRecordedInput: true } : {}),
      model,
      tools: runTools,
      system: effectiveSystem,
      guard: a.guard,
      memory: memoryArg,
      threadId: effectiveThreadId,
      caller,
      // SAHİPLİK DAMGASI — ÖNCELİK BURADA KURULUR: mühürlü kimlik kazanır, çağıranın beyanı değil.
      // Bu satır eklendiğinde aşağıda ayrıca `...(opts.actor ? { actor: opts.actor } : {})` vardı ve
      // object-literal'de SON yazan kazandığı için damgayı EZİYORDU. Sonuç sessizdi: doğrulanmış
      // kimlikten basılan damganın üzerine isteğin gövdesinden gelen bir değer geçiyordu — yani
      // sahiplik kilidi kendi kendine verilebilir hale geliyordu, ki o zaman kilit değildir.
      // opts.actor SİLİNMEDİ, geri plana alındı: mühür kurmayan hostlar (kendi rotasını yazan
      // uygulamalar, CLI, testler) için tek kimlik kanalı odur — ama yalnız mühürlü kimlik YOKKEN.
      ...((serverIdentity.resourceId ?? opts.actor) ? { actor: serverIdentity.resourceId ?? opts.actor } : {}),
      approvals: opts.approvals,
      stopWhen: stepCountIs(a.maxSteps ?? 12),
      ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
      ...(opts.topP != null ? { topP: opts.topP } : {}),
      ...(processors.length ? { processors } : {}),
      ...(opts.limits ? { limits: opts.limits } : {}),
      // + B3(a): same protection forwards as run(), now INCLUDING lock (streamDurable enforces
      // it — see the stream lock note above; FAZ-7: heartbeat parity with run() included).
      ...(opts.toolPolicy ? { toolPolicy: opts.toolPolicy } : {}),
      // FAZ-4 critical-profile forwards (no-ops unless set — see RunOptions).
      ...(opts.strictInput !== undefined ? { strictInput: opts.strictInput } : {}),
      ...(opts.conflictLedger !== undefined ? { conflictLedger: opts.conflictLedger } : {}),
      ...(opts.auditOnReject ? { auditOnReject: opts.auditOnReject } : {}),
      ...((opts.replayDisclosure ?? config.replayDisclosure) ? { replayDisclosure: opts.replayDisclosure ?? config.replayDisclosure } : {}),
      ...(opts.channel ? { channel: opts.channel } : {}),
      ...(opts.tombstonePolicy ? { tombstonePolicy: opts.tombstonePolicy } : {}),
      // Parity with runAgent: the stream path dropped it, so a strict provider's schema rules never applied
      // to a streamed (now: every registry) run.
      ...(config.schemaCompat ? { schemaCompat: config.schemaCompat } : {}),
      ...(opts.replay ? { replay: opts.replay } : {}),
      ...(opts.timeouts ? { timeouts: opts.timeouts } : {}),
      ...(opts.exclusiveModelStep ? { exclusiveModelStep: opts.exclusiveModelStep } : {}),
      // (b): stream-only visibility callback (run() throws instead — see RunOptions.onBlocked).
      ...(opts.onBlocked ? { onBlocked: opts.onBlocked } : {}),
      ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}), // P0.2: see RunOptions.abortSignal
      // The declaration travels with the run so package #2's writer can freeze it into `:input`:
      // the id is opaque, and the answer to "which run was the invoice job?" has to live somewhere
      // a person can read. Only present when the id was DERIVED — a raw runId declared nothing.
      ...(identity.work ? { workKey: identity.work.workKey, workScope: identity.work.workScope } : {}),
      ...(opts.messages ? { messages: opts.messages } : { prompt: opts.prompt }),
    } as any);
  }

  /**
   * Runs a dynamic network: the router assigns a task to one of the registered agents each turn
   * (nested durable run, runId = `net:<runId>:<i>`) or writes the final answer. Sub-agent semantics
   * are the SAME as agent-tool (model fallback freezes into the nested runId, limits inherited AS-IS,
   * NO memory) — the only difference is that the selection comes from the router-LLM instead of a
   * static `agent_<name>` tool, and CAS-freeze is applied to the decision.
   */
  async function runNetwork(
    name: string,
    // `resourceId`/`threadId`/`actor`/`channel` — kimlik alanları BURADA YOKTU, yani ağ yolu bir
    // özneyi taşıyamıyordu bile: host vermek istese verecek yeri yoktu. Ajan yollarıyla (`run`,
    // `stream`) aynı şekil; yönlendirme bir kimlik değişimi değildir.
    // `runId`/`workKey`/`workScope` — the network's half of the package #3 gate. `runId` is optional
    // now because a caller may name the WORK instead (`workKey`), exactly as on the agent doors; the
    // scope is per-call here rather than per-agent, since a network has no AgentConfig of its own to
    // declare one on. Its default is the same conservative `'resource'`.
    opts: { runId?: string; workKey?: string; workScope?: WorkScopeKind; task: string; context?: RequestContext; limits?: RunLimits; approvals?: Record<string, boolean>; resourceId?: string; caller?: Caller; threadId?: string; actor?: string; channel?: string },
  ): Promise<NetworkResult> {
    const net = config.networks?.[name];
    if (!net) throw new Error(`network '${name}' is not registered`);
    const rc = opts.context ?? {};
    // Ajan yollarıyla AYNI öncelik: mühürlü kimlik kazanır, gövdeden gelen ancak mühür yokken.
    const serverIdentity = serverIdentityOf(rc);
    const caller = callerOfCall(rc, opts);
    const effectiveResourceId = userIdOf(caller);
    const effectiveThreadId = serverIdentity.threadId ?? opts.threadId;
    const effectiveActor = serverIdentity.resourceId ?? opts.actor;
    // THE GATE (package #3) — the same one the agent doors call. It sits above `assertRunIdSafe`
    // because the id being judged may not exist yet: a caller who declared a workKey has no id until
    // this line mints one.
    const identity = resolveWorkIdentity(`net:${name}`, {
      ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
      ...(opts.workKey !== undefined ? { workKey: opts.workKey } : {}),
      scopeKind: opts.workScope ?? 'resource',
      ...(effectiveResourceId ? { resourceId: effectiveResourceId } : {}),
      ...(serverIdentity.orgId ? { orgId: serverIdentity.orgId } : {}),
      anonymous: 'refuse',
      surface: `runNetwork('${name}')`,
    });
    const runId = identity.runId!;
    // AYNI SINIF AÇIK, aynı kapı: `runNetworkCore` bu runId'yi anahtar öneki olarak kullanıyor
    // (`netKeys`), yani ağ yolu da rezerve bir aileyi ele geçirebiliyordu. İç içe alt-ajan id'leri
    // (`net:<runId>:<i>`) kendi köklerini `net:` yaptığı için oradan sızmıyor — sızan, router'ın
    // KENDİ koşum kimliği. Süzgeç model çözümlemesinden ve her journal I/O'sundan önce — türetilmiş
    // id de buradan geçer, ama geçeceği baştan bellidir: `run1_<32 hex>` rezervasyonun kabul ettiği
    // TEK şekil. Süzgecin işi hâlâ ham, çağıran seçimi bir adın başkasının ailesini sahiplenmesi.
    // THREAD SAHİPLİĞİ — iş akışı yoluna kurulan kapının (runWorkflow, yukarıda) aynısı, aynı gerekçeyle.
    // Ağ yolu da gövdeden `threadId` + `resourceId` alıyor, yani `{resourceId:'mallory',
    // threadId:'t-ayse'}` burada da yazılabiliyordu: `net-x:input` mallory'yi sahip, Ayşe'nin thread'ini
    // konu yazar ve `purgeResource('mallory')` o koşumdan `purgeThread('t-ayse')`e ulaşır.
    //
    // Kapı MÜHÜRLENMİŞ çift üstünde: `serverIdentityOf` zaten gövdeyi eziyor, kapının başka bir çifte
    // bakması iki yönlü bir kaçak olurdu.
    //
    // SINIR: memory yoksa ya da `getThreadResource` yoksa kapı KURULMAZ (ajan ve iş akışı yollarıyla
    // kelimesi kelimesine aynı koşul) — sahibi doğrulayacak bilgi yokken reddetmek, doğrulanamayan bir
    // iddiayı suç saymak olurdu. Sahibi HENÜZ olmayan thread de geçer: ilk tur bir thread yaratır.
    //
    // Ama OKUNAMAYAN sahip DÜŞÜRÜR — bkz. runWorkflow'daki kardeş kapının yorumu. Burada `.catch`
    // yok, bilerek: bir okuma hatası "sahibi yok" gibi okunursa kapı tam da deposu arızalıyken
    // devre dışı kalır.
    // The same gate as the agent and workflow doors (thread-owner.ts), for every memory.
    if (effectiveThreadId) await admitThreadRun(journal, resolvedMemory, effectiveThreadId, caller);
    // SAHİP KAYDI — iş akışındakiyle AYNI desen, aynı anahtar, aynı ilk-yazan-kazanır.
    //
    // Alt-ajanlar kimliği zaten devralıyordu (aşağıda alt koşumun çerçevesine iniyor); sahipsiz kalan ROUTER'IN
    // KENDİ koşumuydu — ve `<runId>:net:route/step` kayıtları görev metnini ve alt-ajan çıktılarını
    // taşıyor, yani kişisel veri. Sahibi yazılmayınca `purgeResource` o koşumu hiç saymıyor ve
    // `ownershipDenied` sahibi bulamayıp sessizce geçiyordu.
    //
    // `<runId>:input`'a, ağın kendi `net:` anahtarlarına değil: sahiplik kapısı,
    // `listRunsPaged({resourceId})` süzgeci ve `purgeResource` üçü de O anahtarı okuyor.
    // Beyan edilmezse hiçbir şey yazılmaz — "org düzeyi iş, öznesi yok" muafiyeti korunuyor.
    //
    // Package #3 adds the declared name to the same record and to the same condition: a DERIVED run
    // always has something to write down (its id was minted from that name), so a workKey alone is
    // now reason enough to claim the identity entry. Otherwise an org-scoped network job — the exact
    // case the exemption above protects — would hold an opaque id that nothing on earth can map back
    // to the job it was.
    // WRITTEN FOR EVERY NETWORK RUN, ownerless too (the common start point, run-identity.ts): a
    // missing record read as "not started" and let an end user adopt a staff network run.
    // The same entry as every run kind (run-identity.ts admitRun): an existing run — even one whose
    // record is gone but whose rows remain — is refused to a caller who may not act on it, and a
    // re-entry runs as the recorded owner.
    const { acting } = await admitRun(journal, runId, caller, {
      ...(effectiveActor ? { actor: effectiveActor } : {}),
      ...(effectiveThreadId ? { threadId: effectiveThreadId } : {}),
      ...(identity.work ? { workKey: identity.work.workKey, workScope: identity.work.workScope } : {}),
      network: name,
    });
    const netIdentity = runIdentity(acting, runId, effectiveThreadId ? { threadId: effectiveThreadId } : {});
    // Targets are set up BEFORE the router model → an unregistered agent gives a clear error before model resolution.
    // A network's sub-agent is born like any agent run (runAgent), one frame below the network run; interrupts propagate upward.
    const targets: Record<string, NetworkTarget> = {};
    for (const subName of net.agents) {
      const sub = agent(subName); // early, clear error if not registered
      targets[subName] = {
        description: sub.description,
        // The same birth as an agent-as-tool child (runAgent), one frame below the network run.
        // `child` is the network's run arguments for this step: its mark goes on to the member's run.
        run: (task, nestedRunId, child) =>
          runDelegated(journal, runId, nestedRunId, requestOf(netIdentity), async () => {
            const r = await runAgent(subName, withMintOf(childRunOptions(
              { limits: opts.limits, context: rc, ...(effectiveActor ? { actor: effectiveActor } : {}), ...(opts.channel ? { channel: opts.channel } : {}) },
              { runId: nestedRunId, prompt: task },
            ), child), { identity: childIdentity(netIdentity, nestedRunId), parentRunId: runId, ...(opts.approvals ? { approvals: opts.approvals } : {}) });
            return { text: r.text, interrupts: r.interrupts, ...childOutcome(r.steps) };
          }),
      };
    }
    const routerModel = await materializeModel(await resolveDyn(net.router, rc), runId);
    // The network's limits are the request's: its children measure them here (limits.ts registerSubRun).
    if (opts.limits) await seedLimits(journal, runId);
    return runNetworkCore({
      runId,
      journal,
      routerModel,
      agents: targets,
      task: opts.task,
      system: net.system ? await resolveDyn(net.system, rc) : undefined,
      maxIterations: net.maxIterations,
    });
  }

  /** Introspect registered networks (studio Networks view: name + target agents). */
  function listNetworks(): { name: string; agents: string[]; maxIterations: number }[] {
    return Object.entries(config.networks ?? {}).map(([name, n]) => ({
      name,
      agents: n.agents,
      maxIterations: n.maxIterations ?? 6,
    }));
  }

  /** Introspect registered workflows (name + steps + kind). */
  function listWorkflows(): WorkflowMeta[] {
    return Object.entries(config.workflows ?? {}).map(([name, wf]) => ({
      name,
      steps: wf.build().map((s) => ({ id: s.id, kind: workflowStepKind(s.id) })),
    }));
  }

  /** Runs a workflow durably; collects step outputs from the journal and returns them. Suspend-safe.
   * Step-through: opts.maxSteps only applies to workflows with runResumable (returns paused).
   * P0.4 opts.resume/opts.signal are forwarded to runResumable AS-IS (only
   *  workflows with runResumable can use them — a plain `run()`-only WorkflowLike has no suspend/cancel
   *  story to attach them to); a `{status:'canceled'}` result maps into `WorkflowRunResult.canceled`
   *  the SAME way `suspended`/`paused` already do. */
  /**
   * `resourceId`/`actor`/`threadId` — iş akışı koşumlarının SAHİBİ.
   *
   * Bu alanlar yoktu ve sonucu yalnız "eksik alan" değildi: `POST /workflows/runs/:id/cancel`
   * sahiplik kapısını ÇAĞIRIYOR ama kapı sahibi `<runId>:input`'tan okuyor, iş akışı ise
   * `<runId>:wf:_input`'a yazıyor — farklı anahtar, yani kontrol HİÇ ateşlemiyordu. Çağrılan ama
   * hiçbir zaman iş görmeyen bir kapı, olmayan kapıdan daha kötüdür: okuyan onu bir koruma sanır.
   *
   * Kimlik `<runId>:input`'a yazılıyor — iş akışının kendi `:wf:_input`'una değil. Sebebi tek bir
   * alan eklemekten fazlası: sahiplik kapısı, `listRuns({resourceId})` süzgeci ve `purgeResource`
   * hepsi O anahtarı okuyor. Kimliği başka bir yere koymak, üç yüzeyi de yeniden yazmak demekti.
   */
  /**
   * The workflow door's admissibility gate — `run.ts`'s `assertRunAdmissible`, in the shape this path
   * can actually wear. Order is the same, and deliberately: tombstone → owner → input fingerprint.
   *
   * IT USED TO LIVE INSIDE `if (preset === 'critical')`, all three checks, and that was the finding.
   * The agent doors stopped keying these two on a profile flag in package #3: once the engine MINTS
   * the id from a workKey (`run1_…`), the id is no longer a name the caller invented — it is a claim
   * about whose work this is and what the work is, and the engine has to keep the promise it made
   * itself. The workflow door mints exactly the same ids through exactly the same
   * `resolveWorkIdentity` and kept none of it. Measured shape of the hole: `workScope: 'org'`, one
   * workKey, two different subjects — both compute the SAME `run1_` id, the second call inherits the
   * first one's journaled steps, and on any profile but `critical` nothing objects.
   *
   * SO THE CONDITION IS THE ID, NOT THE PROFILE. `critical` still calls this for RAW ids too (that
   * profile's whole bargain is that a named run is a promise), and the owner row below is the one
   * check that stays derived-only — on a raw id, handing a run between subjects is a host's own
   * business and always has been. A raw id under any other profile never reaches here.
   *
   * TOMBSTONE IS UNCONDITIONAL HERE, with no `tombstonePolicy` to soften it, because
   * `WorkflowRunOpts` has no such field to read: the choice is refuse-or-ignore with nobody to ask,
   * and a swept derived run whose steps would silently re-fire is the wrong side to guess on.
   */
  async function assertWorkflowAdmissible(name: string, wfRunId: string, input: unknown, opts: WorkflowRunOpts | undefined, work: { workKey: string; workScope: WorkScope } | undefined): Promise<Caller> {
    const derived = isDerivedRunId(wfRunId);
    // Which sentence the refusal ends with. A derived id was minted by us and the caller cannot
    // simply "use a fresh runId" — they would have to name different work — so the two cases do not
    // get one blurred message.
    const because = derived
      ? 'this id was DERIVED from a workKey, so the engine vouches for it on every profile'
      : "the 'critical' profile vouches for a named run";
    if ((await journal.get(runRecordKey(wfRunId, 'swept'))) !== undefined) {
      await recordIdemConflict(journal, { runId: wfRunId, code: 'run_swept' });
      throw new RunSweptError(
        `@gnldev/durable: workflow run '${wfRunId}' was retention-swept — its dedup window is gone; a late retry must not silently re-run the steps (${because}). ` +
          (derived ? 'Name the work differently, or verify the external system first.' : 'Use a fresh runId.'),
        { runId: wfRunId },
      );
    }
    // THE OWNER OF A DERIVED WORKFLOW RUN — `assertRunAdmissible`'s §6 row, same both-sides-present
    // rule and same reason. A call with no subject is the org/operator case the ownership rule
    // exempts (the nightly reconciliation names nobody on purpose), and a run with no frozen subject
    // never claimed one; refusing either would be inventing an owner in order to enforce ownership.
    //
    // Read from `<runId>:input` and not `<runId>:wf:_input`: the identity claim lives on the first
    // key (workflow-identity.test.ts pins that, and `listRuns`/`purgeResource`/the cancel gate all
    // read it), while the second holds this door's input fingerprint. Two keys, two questions.
    if (derived) {
      const asking = userIdOf(workflowCaller(opts));
      const frozenOwner = (await journal.get<{ resourceId?: string }>(runKeys.input(wfRunId)))?.resourceId;
      if (frozenOwner && asking && frozenOwner !== asking) {
        await recordIdemConflict(journal, { runId: wfRunId, code: 'run_owner_mismatch', detail: { owner: frozenOwner, requested: asking } });
        throw new RunOwnerMismatchError(
          `@gnldev/durable: workflow run '${wfRunId}' belongs to a different subject — this call names '${asking}'. ` +
            'An engine-derived id is a hash of a scope and a workKey, so two callers inside the same org scope compute ' +
            'the same id; the run itself is still one person\'s. If this work really is shared, it is the installation\'s ' +
            'work — run it without a subject.',
          { runId: wfRunId, owner: frozenOwner, requested: asking },
        );
      }
    }
    // The owner is recorded BEFORE the fingerprint below writes the run's first row: a row with no
    // owner record reads as an existing, ownerless run (run-identity.ts), i.e. nobody's to start.
    const acting = await enterWorkflowRun(name, wfRunId, opts, work);
    const inputHash = argsHash(input);
    const frozen = await journal.get<{ hash?: string }>(runRecordKey(wfRunId, 'wf', '_input'));
    // RESUME ESCAPES (denetçi blokeri — F7'nin K6 dersi, workflow'a taşınmış hali): the REAL resume
    // surfaces (Studio inbox, @gnldev/server's resume route) re-send NO input — `input` arrives
    // undefined and `opts.resume` carries the HITL payload. Both are journal-anchored resume
    // intents, not new content: admit them instead of 409'ing the approval path to death.
    const resumeIntent = frozen !== undefined && (input === undefined || opts?.resume !== undefined);
    if (frozen === undefined) {
      // K4: the claim's boolean IS decision data — a same-instant twin with DIFFERENT input can
      // lose the claim silently and then run as if ITS input were the frozen one. The loser
      // re-reads and holds itself to the winner's fingerprint.
      const won = await journalClaim(journal, runRecordKey(wfRunId, 'wf', '_input'), { hash: inputHash, at: Date.now() });
      if (!won) {
        const winner = await journal.get<{ hash?: string }>(runRecordKey(wfRunId, 'wf', '_input'));
        if (winner?.hash !== undefined && winner.hash !== inputHash) {
          await recordIdemConflict(journal, { runId: wfRunId, code: 'run_input_mismatch', detail: { expectedHash: winner.hash, actualHash: inputHash } });
          throw new RunInputMismatchError(
            `@gnldev/durable: workflow run '${wfRunId}' was concurrently started with DIFFERENT input (fingerprint ${winner.hash} != ${inputHash}) — one runId carries one request.`,
            { runId: wfRunId, expectedHash: winner.hash, actualHash: inputHash },
          );
        }
      }
    } else if (!resumeIntent && frozen.hash !== undefined && frozen.hash !== inputHash) {
      await recordIdemConflict(journal, { runId: wfRunId, code: 'run_input_mismatch', detail: { expectedHash: frozen.hash, actualHash: inputHash } });
      throw new RunInputMismatchError(
        `@gnldev/durable: workflow run '${wfRunId}' was started with DIFFERENT input (fingerprint ${frozen.hash} != ${inputHash}) — one runId carries one request; use a fresh runId for new content.`,
        { runId: wfRunId, expectedHash: frozen.hash, actualHash: inputHash },
      );
    }
    return acting;
  }

  /**
   * A workflow run's ENTRY (run-identity.ts admitRun): the owner record is written for every run —
   * owner or not — and a re-entry runs as the RECORDED owner; a caller who may not act on the run is
   * refused. Returns who the run acts for.
   */
  async function enterWorkflowRun(name: string, runId: string, opts: WorkflowRunOpts | undefined, work: { workKey: string; workScope: WorkScope } | undefined): Promise<Caller> {
    const seal = serverIdentityOf(opts?.context ?? {});
    const actor = seal.resourceId ?? opts?.actor;
    const thread = seal.threadId ?? opts?.threadId;
    const { acting } = await admitRun(journal, runId, workflowCaller(opts), withMintOf({
      ...(actor ? { actor } : {}),
      ...(thread ? { threadId: thread } : {}),
      ...(work ? { workKey: work.workKey, workScope: work.workScope } : {}),
      workflow: name,
    }, opts));
    return acting;
  }

  /** A workflow's caller: its parent run's (child run), else the call's (callerOfCall). */
  function workflowCaller(opts: WorkflowRunOpts | undefined): Caller {
    return opts?.parent ? callerOf(opts.parent) : callerOfCall(opts?.context ?? {}, opts);
  }

  async function runWorkflow(name: string, input: unknown, opts?: WorkflowRunOpts): Promise<WorkflowRunResult> {
    refuseUnknownNames(`runWorkflow('${name}')`, opts, WORKFLOW_RUN_NAMES);
    const wf = config.workflows?.[name];
    if (!wf) throw new Error(`workflow '${name}' is not registered`);
    // THE GATE (package #3), and the one door whose "neither half" answer is ALLOW: `runWorkflow` has
    // always accepted a call with no id and answered it with a loud generated one (see the warn in
    // runWorkflowInner). That fallback is not a promise this package can improve on — it says out loud
    // that the call has no dedup — so it stays exactly as it was. What changes is that there is now a
    // third thing a caller can pass instead: a name for the job.
    //
    // Note the type prefix (`wf:`): a workflow and an agent may share a registry name, and without it
    // `pay` the pipeline and `pay` the agent would derive ONE id from one workKey.
    const wfSeal = serverIdentityOf(opts?.context ?? {});
    const wfIdentityGate = resolveWorkIdentity(`wf:${name}`, {
      ...(opts?.runId !== undefined ? { runId: opts.runId } : {}),
      ...(opts?.workKey !== undefined ? { workKey: opts.workKey } : {}),
      scopeKind: opts?.workScope ?? 'resource',
      ...(userIdOf(workflowCaller(opts)) ? { resourceId: userIdOf(workflowCaller(opts)) } : {}),
      ...(wfSeal.orgId ? { orgId: wfSeal.orgId } : {}),
      anonymous: 'allow',
      surface: `runWorkflow('${name}')`,
    });
    // The derived id becomes THIS call's runId for everything below — the critical profile's
    // required-runId check included, which is the intended reading: declaring a workKey IS naming the
    // work, so a critical deployment is satisfied by it.
    if (wfIdentityGate.runId !== undefined) opts = { ...(opts ?? {}), runId: wfIdentityGate.runId };
    // runId SÜZGECİ — journal'a HERHANGİ bir yazımdan önce. Ajan yolları (`runDurable`/`resumeRun`/
    // `streamDurable`) bunu girişte çağırıyordu; iş akışı yolu hiç çağırmıyordu ve bu, iş akışı
    // koşumları `<runId>:input`'a sahip kaydı yazmaya başladığı anda ölçülebilir bir silme silahına
    // dönüştü: `{runId:'mem', resourceId:'mallory'}` ile `mem:input` doğuyor, o kayıt artık
    // mallory'nin bir koşumu sayılıyor, `purgeResource('mallory')` onu geziyor, `purgeRun('mem')`
    // `del('mem:')` yapıyor — `mem:` ise TÜM kullanıcıların thread hafızasının kökü. Kendi verisini
    // silme hakkı, herkesin verisini silme yetkisine dönüşüyor. `thread`, `om`, `xid` ... aynı sınıf.
    //
    // Kontrol BURADA, `critical` bloğundan da önce: o blok `<runId>:swept` okuyor ve
    // `<runId>:wf:_input` claim'liyor — reddedilecek bir ad, reddedilmeden önce anahtar yaratamaz.
    // Anonim üretilen `wf-<ad>-<ms>-...` id'leri (runWorkflowInner) süzgeçten doğal geçer: kökleri
    // rezerve ailelerin hiçbiri değil. Beyan edilmemiş runId burada sorgulanmaz — o yol henüz bir ad
    // seçmedi; üretilen ad zaten güvenli aileden. workKey'den TÜRETİLEN id ise (bir üstteki kapı) bu
    // satıra bir runId olarak gelir ve sorgulanır: motorun kendi bastığı ad da süzgeçten geçsin, çünkü
    // "bizim bastığımız güvenlidir" varsayımı tam olarak yeni bir ailenin fark edilmeden doğduğu yerdir.
    // A workflow tool's run (`wf:<parent>:<call>`) carries the engine's mark from the tool that begins it.
    // THREAD SAHİPLİĞİ — ajan yolundaki kapının (run.ts, ThreadOwnerMismatchError) iş akışı hali.
    // Ajan yollarında bu kapı vardı, iş akışı yolunda YOKTU ve sahip kaydı `wfThread`'i sorgusuz
    // yazıyordu. Ölçülen sonuç: `{runId:'x', resourceId:'mallory', threadId:'t-ayse'}` → `x:input`
    // mallory'yi sahip, Ayşe'nin thread'ini konu yazar; `purgeResource('mallory')` o koşumdan
    // `purgeThread('t-ayse')`e ulaşır ve Ayşe'nin hafızası mallory'nin silme hakkıyla silinir.
    //
    // Kapı, MÜHÜRLENMİŞ (etkili) çift üstünde çalışır — beyan edilen değil: `serverIdentityOf` zaten
    // gövdeyi eziyor, kapının başka bir çifte bakması iki yönlü bir kaçak olurdu.
    //
    // SINIR, dürüstçe: memory yoksa ya da `getThreadResource` yoksa kapı KURULMAZ. Ajan yolu da tam
    // olarak bu koşulla susuyor (run.ts:2463 ile kelimesi kelimesine aynı koşul) — parite kasıtlı.
    // Sahibi doğrulayacak bilgi yokken reddetmek, doğrulanamayan bir iddiayı suç saymak olurdu; ve
    // sahibi HENÜZ olmayan bir thread (ilk tur) de geçer, yoksa her yeni konuşma reddedilirdi.
    //
    // BİLİNMEYEN sahip geçer, OKUNAMAYAN sahip DÜŞÜRÜR. İlk yazışta burada `.catch(() => undefined)`
    // vardı ve ikisini aynı cevaba indiriyordu: bir okuma hatası "sahibi yok" gibi okunuyor, kapı da
    // tam deposu arızalıyken — yani en çok gerektiği anda — sessizce devre dışı kalıyordu. İkisi aynı
    // şey değil: biri masumiyet ("bu thread henüz kimsenin"), diğeri bilgisizlik ("kimin olduğunu
    // soramadım"). Bilgisizlik geçiş hakkı değildir; hata yayılsın, koşum başlamasın.
    {
      const gateIdentity = serverIdentityOf(opts?.context ?? {});
      const gateThread = gateIdentity.threadId ?? opts?.threadId;
      // The same gate as the agent door (thread-owner.ts), for every memory.
      if (gateThread) await admitThreadRun(journal, resolvedMemory, gateThread, workflowCaller(opts));
    }
    // FAZ-8: the critical preset now covers the WORKFLOW entry path with the protections that MAP
    // to it (the old honest-scope note said "apply them explicitly" — this is that, done once here):
    //   runId REQUIRED            (exactly-once without a stable key is a contradiction)
    //   step policy               (a declared sideEffect step must carry recover — strict-critical's analog)
    //   tombstone reject          (a swept id's late retry is refused, not silently re-run)
    //   input fingerprint         (one runId = one input; frozen first-wins at `<runId>:wf:_input`)
    //   run-lock + heartbeat      (a concurrent duplicate of the same workflow run gets RunBusyError)
    // Refusals land in the conflict ledger (best-effort — workflow opts carry no auditOnReject yet).
    if (config.preset === 'critical') {
      if (!opts?.runId) {
        throw new Error(
          `@gnldev/durable: preset 'critical' requires an explicit runId for runWorkflow('${name}') — the generated fallback gives a retry ZERO dedup, which the critical profile exists to forbid.`,
        );
      }
      // FAST-FAIL half: top-level build() steps refuse before the run starts. Combinator legs and
      // nested (asStep) children carry their durability inside closures build() cannot see — THOSE
      // are caught by the RUNTIME net (ctx.strictSideEffects → the workflow engine refuses the step
      // before its claim; denetçi K6). Two layers on purpose: early where possible, airtight where not.
      for (const st of wf.build()) {
        const d = (st as { durability?: { sideEffect?: boolean; recover?: unknown } }).durability;
        if (d?.sideEffect === true && typeof d.recover !== 'function') {
          throw new Error(
            `@gnldev/durable: preset 'critical' — workflow '${name}' step '${st.id}' declares sideEffect without recover(); the crash window must be answered before the run starts (strict-critical's workflow analog).`,
          );
        }
      }
      const wfRunId = opts.runId;
      const acting = await assertWorkflowAdmissible(name, wfRunId, input, opts, wfIdentityGate.work);
      const lockTtl = 300_000;
      const lockHandle = await acquireRunLock(journal, wfRunId, `critical-wf-${randomUUID()}`, lockTtl);
      if (!lockHandle) {
        await recordIdemConflict(journal, { runId: wfRunId, code: 'run_busy' });
        throw new RunBusyError(runBusyMessage(`workflow run '${wfRunId}' is already running — it is locked by another process`), { runId: wfRunId, atLockAcquisition: true });
      }
      let hbInflight: Promise<unknown> = Promise.resolve();
      const beat = setInterval(() => { hbInflight = lockHandle.renew(lockTtl).catch(() => false); }, Math.floor(lockTtl / 2));
      (beat as { unref?: () => void }).unref?.();
      try {
        return await runWorkflowInner(name, wf, input, opts, true, wfIdentityGate.work, acting);
      } finally {
        clearInterval(beat);
        try { await hbInflight; } catch { /* a failed renew changes nothing about release */ }
        await lockHandle.release();
      }
    }
    // THE SAME GATE, WITHOUT THE PROFILE — see assertWorkflowAdmissible's note. An id the engine
    // derived carries the engine's own promise, so the three checks follow the ID here, not the
    // preset. A raw runId falls straight through, exactly as it always has: it is the caller's own
    // name for their own key and nothing was ever vouched for it on this path.
    const acting = opts?.runId !== undefined && isDerivedRunId(opts.runId)
      ? await assertWorkflowAdmissible(name, opts.runId, input, opts, wfIdentityGate.work)
      : undefined;
    return runWorkflowInner(name, wf, input, opts, undefined, wfIdentityGate.work, acting);
  }

  async function runWorkflowInner(name: string, wf: WorkflowLike, input: unknown, opts?: WorkflowRunOpts, strictSideEffects?: boolean, work?: { workKey: string; workScope: WorkScope }, entered?: Caller): Promise<WorkflowRunResult> {
    // The generated fallback is the SAME contract as the chat route's anon fallback: LOUD, never
    // silent — a fresh id per call means a retry of this exact call re-runs every step (zero dedup),
    // which is the framework breaking its own rule quietly. The id is returned on the result
    // (WorkflowRunResult.runId) so the caller can retry against it. The counter closes the same-ms
    // collision WITHIN one process; across replicas it cannot — see the id's construction below.
    let runId = opts?.runId;
    if (!runId) {
      // Süreç-içi sayaç TEK BAŞINA yetmiyor: modül düzeyinde yaşıyor, yani her replika kendi
      // sıfırından sayıyor. Ortak bir journal üstünde iki süreç aynı milisaniyede `wf-<ad>-<ms>-0`
      // üretir ve İKİ FARKLI çağrı tek koşuma düşer — exactly-once sessizce ihlal edilir. Bu yorum
      // eskiden "sayaç aynı-ms çarpışmasını kapatır" diye açık bir vaat yazıyordu; kapattığı şey
      // yalnız TEK süreç içindeki çarpışmaydı. Süreçler-arası olanı ancak süreç-dışı bir entropi
      // kaynağı kapatır. (Doğru çözüm hâlâ istikrarlı bir runId GÖNDERMEK — aşağıdaki uyarı bunu
      // söylüyor; bu satır yalnız "kötüden daha kötüye" düşmeyi engelliyor.)
      runId = `wf-${name}-${Date.now()}-${wfAnonCounter++}-${randomUUID().slice(0, 8)}`;
      console.warn(
        `@gnldev/durable: runWorkflow('${name}') called without a runId — generated '${runId}'. A retry of ` +
        `this call will NOT dedupe (every step re-runs). Pass a stable runId (it is echoed on result.runId) for exactly-once.`,
      );
    }
    let wfRunIdentity: RunIdentity;
    // SAHİP KAYDI — ilk yazan kazanır (koşum kimliği devir boyunca değişmez). `wfrun:` durum
    // kütüğüyle karışmasın diye ayrı: o "iş akışı nerede", bu "kimin işi".
    {
      const wfThread = serverIdentityOf(opts?.context ?? {}).threadId ?? opts?.threadId;
      // `work` (package #3): the declared name joins the record. Tonight's reconciliation is an
      // org-scoped, subject-less derived run, useless to an operator if its opaque id maps back to
      // nothing.
      //
      // WRITTEN FOR EVERY RUN, owner or not. It used to be written only when there was something to
      // put in it, and a run with no owner therefore left no record at all — which the write gates
      // read as "not started yet" and waved an end user through: approving a staff member's
      // suspended workflow, reading its steps, and (first write wins) becoming its owner. A record
      // with no `resourceId` says what the gates need to hear: this run exists and nobody owns it.
      // (enterWorkflowRun — already done when an admission check ran first, see assertWorkflowAdmissible.)
      const acting = entered ?? (await enterWorkflowRun(name, runId, opts, work));
      // A re-entry runs as the RECORDED owner; a caller who may not act on this run is refused.
      wfRunIdentity = runIdentity(acting, runId, { ...(wfThread ? { threadId: wfThread } : {}), ...(opts?.parent?.runId ? { parentRunId: opts.parent.runId } : {}) });
    }
    // The step context carries the run's identity: a step that calls a tool or starts an agent
    // passes it on (`toolContextFor(ctx.identity)`, `runDurable({ caller: ctx.identity })`).
    const ctx = { runId, journal: journal, identity: wfRunIdentity, ...(strictSideEffects ? { strictSideEffects: true } : {}) };
    let output: unknown;
    let suspended = false;
    let paused = false;
    let canceled = false;
    let stepId: string | undefined;
    let reason: unknown;
    if (wf.runResumable) {
      const rOpts = {
        ...(opts?.maxSteps != null ? { maxSteps: opts.maxSteps } : {}),
        ...(opts?.resume ? { resume: opts.resume } : {}),
        ...(opts?.signal ? { signal: opts.signal } : {}),
        // FLOW-08: `name` is known here (the registry key) — mirrored into the `wfrun:` status
        // record so the run registry/studio can display the workflow's name.
        workflowName: name,
      };
      const r = await wf.runResumable(input, ctx, Object.keys(rOpts).length ? rOpts : undefined);
      if (r.status === 'suspended') { suspended = true; stepId = r.stepId; reason = r.reason; }
      else if (r.status === 'paused') { paused = true; stepId = r.stepId; }
      else if (r.status === 'canceled') { canceled = true; stepId = r.stepId; reason = r.reason; }
      else output = r.output;
    } else {
      if (opts?.maxSteps != null) throw new Error(`workflow '${name}' does not support step-through (no runResumable)`);
      try {
        output = await wf.run(input, ctx);
      } catch (e: any) {
        if (e?.name === 'WorkflowSuspended') { suspended = true; reason = e?.reason; }
        else throw e;
      }
    }
    const steps: WorkflowRunResult['steps'] = [];
    for (const s of wf.build()) {
      // A plain `get`, deliberately: @gnldev/workflow writes this marker with a plain `put` for
      // exactly this reason. Its retry COUNTER cannot be read here — on a backend with `incrBy` it
      // lives in a counter map rather than the field, so a naive read would return nothing on
      // Sqlite/Postgres while looking correct in memory, and the reader that knows the difference is
      // in @gnldev/workflow, which this file must not import (see the structural-type note above).
      //
      // The `_` is that package's reserved-control-key prefix, and the brand is checked rather than
      // trusted: an unprefixed key was ALSO the key of a nested step named `fallback`, whose ordinary
      // output then came back as a substitution marker and made a step that never failed report that
      // it had. The prefix stops that collision; the brand stops any other value from posing as one,
      // since what is read here is a journal a host also writes to.
      const raw = await journal.get<unknown>(runRecordKey(runId, 'wf', `${s.id}:_fallback`));
      const fallback = isFallbackMarker(raw) ? { attempts: raw.attempts, stepId: raw.stepId } : undefined;
      steps.push({
        id: s.id,
        kind: workflowStepKind(s.id),
        output: decodeStepRecord(await journal.get(runRecordKey(runId, 'wf', s.id))),
        ...(fallback ? { fallback } : {}),
      });
    }
    return { runId, output, suspended, paused, canceled, stepId, reason, steps };
  }

  /**
   * The RESOLVED conversation store, exposed because nothing else could reach it.
   *
   * `memory` is resolved here — `config.memory`, else `config.memoryFactory(storage)`, else none — and
   * a host that passes the FACTORY (which is what an organization-scoped deployment must pass: one
   * shared object cannot carry an org boundary) never sees the instance that was built for a given
   * organization. @gnldev/server needs exactly that instance to serve a thread read, and was otherwise
   * left with a store it could write through `run()` but never read back.
   *
   * `undefined` when memory is off (`memory: false`, or neither option given), which is the same
   * answer a caller gets for a deployment that keeps no conversations.
   */
  // HERMES v1: `suggestions` is `undefined` when the config block is absent — the feature's very
  // handle is opt-in, matching the promotion block's own no-block-no-code-path rule.
  /**
   * Follows a run already started (by any process) from a reader's cursor, without starting or joining
   * anything: a door's `GET /runs/:id/events`. The door decides whether this caller may read it (its own
   * ownership rule, the same as for reading the run's record); this only reads.
   */
  /**
   * Cancels a run of this scope, wherever it executes (detached.ts `DetachedRuns.cancel`): the durable
   * cancel record, which every executor obeys, and the holder told to read it now. `'delivered'`: it
   * executes in this process and was stopped now; `'recorded'`: it executes elsewhere (stopped at its
   * next event) or nowhere (it never starts again). The door decides whether this caller may cancel it.
   */
  async function cancel(runId: string, opts: { reason?: unknown } = {}): Promise<'delivered' | 'recorded'> {
    refuseUnknownNames('gnl.cancel', opts, CANCEL_RUN_NAMES);
    const runs = await executor();
    const scope = orgScopeOf(journal);
    return runs.cancel({ runId, ...(scope !== undefined ? { scope } : {}), ...(opts.reason !== undefined ? { reason: opts.reason } : {}) });
  }

  async function follow(runId: string, opts: { after?: number | string } = {}) {
    const runs = await executor();
    const scope = orgScopeOf(journal);
    return followedRun(runs, { runId, ...(scope !== undefined ? { scope } : {}), journal, after: readCursor(opts.after), state: 'following' });
  }

  return { agent, run, stream, follow, cancel, listWorkflows, runWorkflow, runNetwork, listNetworks, memory: resolvedMemory, suggestions: suggestionsApi };
}
