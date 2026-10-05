// The names of every options object @gnldev/durable reads, each held to its type by the compiler
// (@gnldev/options `optionNames`): an option added to a type and not here fails `pnpm typecheck`.
// A name not listed is refused where the object is read (`refuseUnknownNames`), naming the option it
// is closest to. Measured before: a misspelled `guard`, `limits` or `limits.maxToolCalls` left the
// agent or the run without it — the tool ran 3 times past a limit of 1, and past a guard that denies.
//
// Only options bags are checked. An implementation of an interface (a storage, a model, a tool, a
// processor, a memory) may carry members of its own, so it is never held to a name list.
import { refuseUnknownNames, refuseMisspelledNames, optionNames, type AnyVariantName } from '@gnldev/options';
import type { CreateGnlConfig, AgentConfig, NetworkConfig, RunOptions, WorkflowRunOpts } from './registry.js';
import type { RunLimits } from './limits.js';
import type { SemanticDupConfig } from './semantic-dup.js';
import type { SemanticRulesConfig } from './semantic-rules.js';
import type { DupSpec } from './policy-matrix.js';
import type { RunDurableArgs, StreamDurableArgs, ResumeAgentConfig } from './run.js';
import type { ReplayRunConfig } from './regression.js';
import type { RunNetworkOptions } from './network.js';
import type { SuggestionsConfig } from './suggestions.js';

export const CREATE_GNL_NAMES = optionNames<CreateGnlConfig>()([
  'storage', 'journal', 'agents', 'tools', 'memory', 'memoryFactory', 'processors', 'workflows', 'networks',
  'checkSuiteConsistency', 'schemaCompat', 'preset', 'suggestions', 'replayDisclosure',
]);
export const AGENT_NAMES = optionNames<AgentConfig>()([
  'description', 'model', 'tools', 'system', 'guard', 'maxSteps', 'processors', 'agents', 'workflows', 'scorers',
  'scorerSampling', 'workScope', 'orgs',
]);
// Names that belong one level away: `stopWhen` is runDurable's (the AI SDK's), an agent stops by `maxSteps`.
const AGENT_NAME_NOTES = {
  stopWhen: 'is not an agent option: an agent stops after `maxSteps` model steps (default 12). Pass `maxSteps`.',
} as const;
const SCORER_SAMPLING_NAMES = optionNames<NonNullable<AgentConfig['scorerSampling']>>()(['rate']);
export const NETWORK_NAMES = optionNames<NetworkConfig>()(['router', 'agents', 'system', 'maxIterations']);

export const RUN_NAMES = optionNames<RunOptions>()([
  'runId', 'workKey', 'prompt', 'messages', 'threadId', 'resourceId', 'caller', 'approvals', 'context', 'model',
  'temperature', 'topP', 'system', 'tools', 'limits', 'lock', 'toolPolicy', 'strictInput', 'trustRecordedInput',
  'conflictLedger', 'auditOnReject', 'replayDisclosure', 'channel', 'tombstonePolicy', 'actor', 'replay', 'timeouts',
  'exclusiveModelStep', 'onBlocked', 'abortSignal',
]);
const TIMEOUT_NAMES = optionNames<NonNullable<RunOptions['timeouts']>>()(['modelStepMs', 'toolMs', 'claimTtlMs']);
const LOCK_NAMES = optionNames<NonNullable<RunOptions['lock']>>()(['owner', 'ttlMs', 'maxHoldMs']);
export const WORKFLOW_RUN_NAMES = optionNames<WorkflowRunOpts>()([
  'runId', 'workKey', 'workScope', 'maxSteps', 'resume', 'signal', 'resourceId', 'caller', 'parent', 'actor', 'threadId', 'context',
]);

const LIMIT_NAMES = optionNames<RunLimits>()([
  'maxCostUsd', 'maxTokens', 'maxToolCalls', 'maxConcurrency', 'loopDetection', 'sideEffectDuplicates', 'approvalScope',
  'taintedSideEffects', 'taintScope', 'taintLifetime', 'strict',
]);
const LOOP_NAMES = optionNames<NonNullable<RunLimits['loopDetection']>>()(['maxRepeats', 'onRepeat']);
type DupObject = Extract<NonNullable<RunLimits['sideEffectDuplicates']>, object>;
const DUP_ACTION_NAMES = optionNames<Extract<DupObject, { action: unknown }>>()(['action', 'scope', 'ttlMs', 'semantic']);
const DUP_BY_CLASS_NAMES = optionNames<Extract<DupObject, { byClass: unknown }>>()(['byClass', 'default', 'semantic']);
const DUP_SPEC_NAMES = optionNames<DupSpec>()(['action', 'scope', 'ttlMs']);
// `embedStripped` is not the host's: it marks the copy of the limits a run froze for its resume (run.ts
// serializableLimits), which comes back through the same reader.
const SEMANTIC_NAMES = [...optionNames<SemanticDupConfig>()(['embed', 'embedModelId', 'minSimilarity', 'topK', 'rules', 'judge']), 'embedStripped'] as const;
const JUDGE_NAMES = optionNames<NonNullable<SemanticDupConfig['judge']>>()(['complete', 'judgeModelId', 'qualification', 'maxCallsPerRun', 'timeoutMs']);
const RULES_NAMES = optionNames<SemanticRulesConfig>()(['sizeLadders', 'gazetteers', 'shortCodeMaxLen', 'disable']);

/** gnl's own names on runDurable / streamDurable / resumeRun: everything that is not the AI SDK's. */
type DurableOwnName = Exclude<keyof RunDurableArgs, keyof Parameters<typeof import('ai').generateText>[0]>
  | Exclude<keyof StreamDurableArgs, keyof Parameters<typeof import('ai').streamText>[0]>;
const DURABLE_OWN_NAMES = optionNames<Record<DurableOwnName, unknown>>()([
  'journal', 'runId', 'trustRecordedInput', 'origin', 'guard', 'approvals', 'memory', 'threadId', 'resourceId', 'caller',
  'channel', 'agentName', 'workKey', 'workScope', 'replay', 'lock', 'exclusiveModelStep', 'replayCacheMaxBytes', 'toolPolicy',
  'strictInput', 'conflictLedger', 'auditOnReject', 'replayDisclosure', 'tombstonePolicy', 'actor', 'processors', 'schemaCompat',
  'limits', 'timeouts', 'onBlocked',
]);
/**
 * The AI SDK's names, as this build knows them. A newer AI SDK's option close to none of these passes
 * (refuseMisspelledNames). Held to the AI SDK one way only: each name must be one of its options, so a
 * name it drops fails the build; a name it ADDS does not have to be here. Held both ways, the build broke
 * on every AI SDK release that added an option — measured: ai 7.0.114 added `streamRetries` and
 * @gnldev/durable no longer compiled anywhere the lockfile does not pin an older version.
 */
type AiSdkCall = Parameters<typeof import('ai').generateText>[0] | Parameters<typeof import('ai').streamText>[0];
const AI_SDK_NAMES = ([
  'maxOutputTokens', 'temperature', 'topP', 'topK', 'presencePenalty', 'frequencyPenalty', 'stopSequences', 'seed', 'reasoning',
  'maxRetries', 'abortSignal', 'headers', 'timeout', 'instructions', 'system', 'allowSystemInMessages', 'prompt', 'messages',
  'tools', 'toolsContext', 'model', 'toolChoice', 'stopWhen', 'telemetry', 'experimental_telemetry', 'providerOptions',
  'experimental_sandbox', 'runtimeContext', 'activeTools', 'toolOrder', 'output', 'toolApproval', 'experimental_toolCallers',
  'experimental_toolApprovalSecret', 'experimental_download', 'prepareStep', 'repairToolCall', 'experimental_repairToolCall',
  'experimental_refineToolInput', 'experimental_transform', 'includeRawChunks', 'onChunk', 'onError', 'onAbort', 'onStart',
  'experimental_onStart', 'onStepStart', 'experimental_onStepStart', 'onLanguageModelCallStart',
  'experimental_onLanguageModelCallStart', 'onLanguageModelCallEnd', 'experimental_onLanguageModelCallEnd',
  'onToolExecutionStart', 'experimental_onToolCallStart', 'onToolExecutionEnd', 'experimental_onToolCallFinish', 'onStepEnd',
  'onStepFinish', 'onEnd', 'onFinish', 'include', 'experimental_include', '_internal',
] as const) satisfies readonly AnyVariantName<AiSdkCall>[];
const DURABLE_ARG_NAMES = [...DURABLE_OWN_NAMES, ...AI_SDK_NAMES] as const;
export const RESUME_NAMES = [
  ...optionNames<ResumeAgentConfig>()([
    'model', 'tools', 'guard', 'stopWhen', 'replay', 'limits', 'replayDisclosure', 'channel', 'processors', 'memory', 'resourceId',
    'lock', 'timeouts', 'exclusiveModelStep', 'schemaCompat', 'toolPolicy', 'strictInput', 'conflictLedger', 'auditOnReject',
    'tombstonePolicy', 'actor',
  ]),
  'journal', 'approvals', 'caller', 'trustRecordedInput',
] as const;
export const REPLAY_RUN_NAMES = optionNames<ReplayRunConfig>()([
  'journal', 'runId', 'newRunId', 'model', 'tools', 'system', 'guard', 'approvals', 'stopWhen', 'replay', 'stripMemoryContext', 'trustRecordedInput',
]);
export const RUN_NETWORK_NAMES = optionNames<RunNetworkOptions>()(['runId', 'journal', 'routerModel', 'agents', 'task', 'system', 'maxIterations', 'observer', 'caller']);
const OBSERVER_NAMES = optionNames<NonNullable<RunNetworkOptions['observer']>>()(['onRouteStart', 'onRouteDecision', 'onAgentStart', 'onAgentFinish', 'onFinal']);
const SUGGESTIONS_NAMES = optionNames<SuggestionsConfig>()(['generate', 'apply', 'model', 'embed', 'embedModelId', 'minSimilarity', 'maxInject', 'promotion']);
const PROMOTION_NAMES = optionNames<NonNullable<SuggestionsConfig['promotion']>>()(['strategy', 'threshold']);

/**
 * The names a project's gnl.config carries for its other readers — `gnl dev`, Studio, the doors —
 * beside the engine's own. createGnl is handed that file whole (the scaffold's src/app.ts does), so it
 * takes these and reads none of them; @gnldev/cli holds its config type to this list, so a name gnl dev
 * adds and this list lacks fails its typecheck.
 */
export const PROJECT_CONFIG_NAMES = ['port', 'studio', 'title', 'subjects', 'surfaces', 'auth', 'license', 'licensePublicKey', 'licenseStrict'] as const;
const CONFIG_FILE_NAMES = [...CREATE_GNL_NAMES, ...PROJECT_CONFIG_NAMES] as const;

/** A gnl config's own names — the engine's and the project file's — without the bags inside it. */
export function refuseConfigNames(where: string, config: unknown): void {
  refuseUnknownNames(where, config, CONFIG_FILE_NAMES);
}

/** createGnl's config, and every agent, network and run-level option bag inside it. */
export function refuseCreateGnlNames(config: CreateGnlConfig): void {
  refuseConfigNames('createGnl', config);
  for (const [name, a] of Object.entries(config.agents ?? {})) {
    refuseUnknownNames(`createGnl: agents.${name}`, a, AGENT_NAMES, AGENT_NAME_NOTES);
    refuseUnknownNames(`createGnl: agents.${name}.scorerSampling`, a?.scorerSampling, SCORER_SAMPLING_NAMES);
  }
  for (const [name, n] of Object.entries(config.networks ?? {})) refuseUnknownNames(`createGnl: networks.${name}`, n, NETWORK_NAMES);
  if (config.suggestions) refuseSuggestionsNames(config.suggestions);
}

export function refuseSuggestionsNames(s: SuggestionsConfig): void {
  refuseUnknownNames('suggestions', s, SUGGESTIONS_NAMES);
  refuseUnknownNames('suggestions.promotion', s.promotion, PROMOTION_NAMES);
}

/** A run's options (gnl.run / gnl.stream), with the bags inside them. */
export function refuseRunNames(where: string, opts: RunOptions): void {
  refuseUnknownNames(where, opts, RUN_NAMES);
  refuseUnknownNames(`${where}: timeouts`, opts.timeouts, TIMEOUT_NAMES);
  refuseUnknownNames(`${where}: lock`, opts.lock, LOCK_NAMES);
  refuseUnknownNames(`${where}: exclusiveModelStep`, opts.exclusiveModelStep, EXCLUSIVE_STEP_NAMES);
  refuseRunLimitNames(`${where}: limits`, opts.limits);
}

/**
 * A run's limits, wherever they come in: a run's options, runDurable's arguments, a door's own
 * limits. One reader of RunLimits, so a limit added to the type is checked everywhere at once.
 */
export function refuseRunLimitNames(where: string, limits: RunLimits | undefined): void {
  if (limits === null || typeof limits !== 'object') return;
  refuseUnknownNames(where, limits, LIMIT_NAMES);
  refuseUnknownNames(`${where}.loopDetection`, limits.loopDetection, LOOP_NAMES);
  const dup = limits.sideEffectDuplicates;
  if (dup && typeof dup === 'object') {
    const byClass = 'byClass' in dup;
    refuseUnknownNames(`${where}.sideEffectDuplicates`, dup, byClass ? DUP_BY_CLASS_NAMES : DUP_ACTION_NAMES);
    if (byClass) {
      for (const [cls, spec] of Object.entries(dup.byClass ?? {})) refuseUnknownNames(`${where}.sideEffectDuplicates.byClass.${cls}`, spec, DUP_SPEC_NAMES);
      refuseUnknownNames(`${where}.sideEffectDuplicates.default`, dup.default, DUP_SPEC_NAMES);
    }
    const sem = dup.semantic;
    refuseUnknownNames(`${where}.sideEffectDuplicates.semantic`, sem, SEMANTIC_NAMES);
    if (sem && typeof sem.rules === 'object') refuseUnknownNames(`${where}.sideEffectDuplicates.semantic.rules`, sem.rules, RULES_NAMES);
    refuseUnknownNames(`${where}.sideEffectDuplicates.semantic.judge`, sem?.judge, JUDGE_NAMES);
  }
}

/**
 * runDurable / streamDurable: gnl's own names plus the AI SDK's, which these pass on to generateText /
 * streamText. A misspelling of either is refused; a name close to none is a newer AI SDK's and passes.
 */
export function refuseDurableArgNames(where: string, args: RunDurableArgs | StreamDurableArgs): void {
  refuseMisspelledNames(where, args, DURABLE_ARG_NAMES);
  refuseUnknownNames(`${where}: timeouts`, (args as { timeouts?: unknown }).timeouts, TIMEOUT_NAMES);
  refuseUnknownNames(`${where}: lock`, (args as { lock?: unknown }).lock, LOCK_NAMES);
  refuseUnknownNames(`${where}: exclusiveModelStep`, (args as { exclusiveModelStep?: unknown }).exclusiveModelStep, EXCLUSIVE_STEP_NAMES);
  refuseRunLimitNames(`${where}: limits`, (args as { limits?: RunLimits }).limits);
}

export function refuseNetworkRunNames(opts: RunNetworkOptions): void {
  refuseUnknownNames('runNetwork', opts, RUN_NETWORK_NAMES);
  refuseUnknownNames('runNetwork: observer', opts.observer, OBSERVER_NAMES);
}

// ── The package's other option bags: one list each, read where the bag is taken. ──
export const BUDGET_LIMIT_NAMES = optionNames<NonNullable<Parameters<typeof import('./budget.js').checkBudget>[2]>>()(['usdLimit', 'tokenLimit']);
export const ASSERT_BUDGET_NAMES = optionNames<NonNullable<Parameters<typeof import('./budget.js').assertBudget>[1]>>()(['orgId', 'fallback', 'costCache', 'strictSuspendedCost']);
export const COMPENSATE_RUN_NAMES = optionNames<NonNullable<Parameters<typeof import('./compensation.js').compensateRun>[1]>>()(['journal', 'tools', 'dryRun']);
export const AGENT_TOOL_NAMES = optionNames<NonNullable<Parameters<typeof import('./agent-tool.js').createAgentTool>[0]>>()(['journal', 'model', 'tools', 'system', 'guard', 'maxSteps', 'limits', 'actor', 'channel', 'toolPolicy', 'approvals', 'parentRunId']);
export const PURGE_RUN_NAMES = optionNames<NonNullable<Parameters<typeof import('./retention.js').purgeRun>[3]>>()(['ownershipTrace']);
export const PURGE_RESOURCE_NAMES = optionNames<NonNullable<Parameters<typeof import('./retention.js').purgeResource>[2]>>()(['vectors', 'memory', 'outsideOrganizations']);
export const RETENTION_SWEEPER_NAMES = optionNames<NonNullable<Parameters<typeof import('./retention.js').createRetentionSweeper>[1]>>()(['intervalMs', 'sweep', 'logSweep', 'onError']);
export const SWEEP_RUNS_NAMES = optionNames<NonNullable<Parameters<typeof import('./retention.js').sweepRuns>[1]>>()(['olderThanMs', 'keepSuspended', 'suspendedTtlMs', 'tombstones', 'now']);
export const SWEEP_LOG_NAMES = optionNames<NonNullable<Parameters<typeof import('./retention.js').sweepLog>[2]>>()(['olderThanMs', 'markerFor', 'now']);
export const SWEEP_THREADS_NAMES = optionNames<NonNullable<Parameters<typeof import('./retention.js').sweepThreads>[1]>>()(['olderThanMs', 'now']);
export const RUN_COST_NAMES = optionNames<NonNullable<Parameters<typeof import('./cost.js').getRunCost>[2]>>()(['modelId', 'pricing']);
export const READ_IDEM_LEDGER_NAMES = optionNames<NonNullable<Parameters<typeof import('./idem-ledger.js').readIdemLedger>[1]>>()(['runId']);
export const METRICS_SUMMARY_NAMES = optionNames<NonNullable<Parameters<typeof import('./metrics.js').readMetricsSummary>[1]>>()(['days']);
export const REGRESSION_REPORT_NAMES = optionNames<NonNullable<Parameters<typeof import('./regression.js').regressionReport>[3]>>()(['scorer']);
export const WITH_IDEMPOTENCY_NAMES = optionNames<NonNullable<Parameters<typeof import('./idempotent-tools.js').withIdempotency>[1]>>()(['journal', 'window', 'runId', 'key', 'caller']);
export const RELEASE_CLAIM_NAMES = optionNames<NonNullable<Parameters<typeof import('./idempotent-tools.js').releaseFailedClaim>[1]>>()(['toolName', 'args', 'key', 'threadId']);
export const DURABLE_MODEL_NAMES = optionNames<NonNullable<Parameters<typeof import('./durable-model.js').withDurableModel>[2]>>()(['exclusiveStep', 'stepTimeoutMs']);
export const SUBJECT_JOURNAL_NAMES = optionNames<NonNullable<Parameters<typeof import('./subject-view.js').withSubjectJournal>[2]>>()(['root']);
export const SUBJECT_MEMORY_NAMES = optionNames<NonNullable<Parameters<typeof import('./subject-view.js').withSubjectMemory>[2]>>()(['journal', 'root']);
export const POLL_LOOP_NAMES = optionNames<NonNullable<Parameters<typeof import('./polling.js').createPollLoop>[1]>>()(['pollMs', 'backoff', 'maxPollMs']);
export const FORMAT_PROTECTIONS_NAMES = optionNames<NonNullable<Parameters<typeof import('./protections.js').formatProtections>[1]>>()(['title']);
export const PROTECTION_CONTEXT_NAMES = optionNames<NonNullable<Parameters<typeof import('./protections.js').describeProtections>[1]>>()(['identity', 'devOnly', 'surface']);
export const TOOL_DURABILITY_NAMES = optionNames<NonNullable<Parameters<typeof import('./types.js').gnlTool>[1]>>()(['sideEffect', 'idempotent', 'idempotency', 'idempotencyKey', 'idempotencyWindow', 'untrusted', 'maxRetries', 'timeoutMs', 'claimTtlMs', 'recover', 'compensate', 'confirm', 'semanticIdentity', 'lookup', 'effectClass']);
export const LIST_LOG_NAMES = optionNames<NonNullable<Parameters<typeof import('./durable-log.js').listLog>[2]>>()(['limit']);
export const POLICY_GUARD_NAMES = optionNames<NonNullable<Parameters<typeof import('./policy.js').policyGuard>[1]>>()(['key', 'fallback']);
export const ROLLOVER_NAMES = optionNames<NonNullable<Parameters<typeof import('./rollover.js').rolloverRun>[2]>>()(['newRunId', 'carry']);
export const ERASE_SUBJECT_NAMES = optionNames<NonNullable<Parameters<typeof import('./erase.js').eraseSubject>[2]>>()(['orgId', 'erasers', 'memory']);
export const RESERVED_ROOT_THREADS_NAMES = optionNames<NonNullable<Parameters<typeof import('./erase.js').findReservedRootThreads>[1]>>()(['resourceId']);
export const SUBJECT_RUNS_NAMES = optionNames<NonNullable<Parameters<typeof import('./erase.js').subjectRuns>[2]>>()(['orgId']);
export const CANCEL_RUN_NAMES = optionNames<NonNullable<Parameters<typeof import('./cancel.js').cancelAgentRun>[2]>>()(['reason']);
export const SUITE_CONSISTENCY_NAMES = optionNames<NonNullable<Parameters<typeof import('./suite-consistency.js').assertSuiteConsistent>[0]>>()(['packages', 'onMismatch', 'fromDir']);
export const COMPOSITE_NAMES = optionNames<NonNullable<Parameters<typeof import('./storage.js').composite>[0]>>()(['default', 'overrides']);
export const TOOL_CALLING_MODEL_NAMES = optionNames<NonNullable<Parameters<typeof import('./mock-model.js').toolCallingModel>[0]>>()(['toolName', 'input', 'calls', 'doneText']);
export const SEMANTIC_IDENTITY_NAMES = optionNames<NonNullable<import('./types.js').ToolDurability['semanticIdentity']>>()(['keys', 'describe', 'amountFields', 'discriminatorFields']);
export const CONFIRM_NAMES = optionNames<Extract<NonNullable<import('./types.js').ToolDurability['confirm']>, object>>()(['reason']);
export const LOG_SWEEP_TARGET_NAMES = optionNames<import('./retention.js').LogSweepTarget>()(['ns', 'olderThanMs', 'markerFor', 'now']);
export const PROCESSOR_RETRY_NAMES = optionNames<NonNullable<ConstructorParameters<typeof import('./processor.js').ProcessorRetry>[2]>>()(['maxRetries']);
export const REDIS_STORAGE_NAMES = optionNames<import('./redis-storage.js').RedisStorageOptions>()(['connectionString', 'client', 'keyPrefix', 'replicationWarning', 'waitReplicas']);
export const POSTGRES_STORAGE_NAMES = optionNames<NonNullable<ConstructorParameters<typeof import('./postgres-storage.js').PostgresStorage>[0]>>()(['connectionString', 'pool']);
/** A sub-agent runs as its parent's caller; its config named an owner once, and that name is refused. */
export const REMOVED_AGENT_TOOL_NAMES = {
  resourceId: "was removed: a sub-agent runs as its parent's caller, so its config cannot name a user. Pass the user to the parent's run.",
} as const;

/** A budget limit (`{ usdLimit, tokenLimit }`), wherever one comes in. */
export function refuseBudgetLimitNames(where: string, limit: unknown): void {
  refuseUnknownNames(where, limit, BUDGET_LIMIT_NAMES);
}
export const CREATE_BATCH_NAMES = optionNames<NonNullable<Parameters<typeof import('./batch.js').createBatch>[1]>>()(['tool', 'toolName', 'itemKey', 'resourceId', 'caller', 'onDuplicate']);
export const AGENT_TOOL_OPTS_NAMES = optionNames<NonNullable<Parameters<typeof import('./agent-tool.js').createAgentTool>[1]>>()(['description']);
export const EXCLUSIVE_STEP_NAMES = optionNames<import('./durable-model.js').ExclusiveStepOptions>()(['ttlMs']);
export const JUDGE_CONFIG_NAMES = JUDGE_NAMES;
type StorageAdopt = NonNullable<Parameters<import('./in-memory-storage.js').InMemoryStorage['adoptIntoOrg']>[1]>;
export const ADOPT_INTO_ORG_NAMES = optionNames<StorageAdopt>()(['dryRun', 'allowUnregistered', 'allowInFlight']);
export const COMPACT_NAMES = optionNames<NonNullable<Parameters<import('./postgres-storage.js').PostgresStorage['compact']>[0]>>()(['full']);
export const MIGRATE_SCHEMA_NAMES = optionNames<NonNullable<Parameters<import('./postgres-storage.js').PostgresStorage['migrateSchema']>[0]>>()(['dryRun']);
export const LIST_KEYS_NAMES = optionNames<NonNullable<Parameters<import('./journal.js').InMemoryJournal['listKeys']>[1]>>()(['limit']);
export const LIST_STALE_RUNS_NAMES = optionNames<NonNullable<Parameters<import('./journal.js').InMemoryJournal['listStaleRuns']>[1]>>()(['includeSuspended']);
