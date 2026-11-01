// The names of every options object @gnldev/lab reads, each held to its parameter's type by the compiler
// (@gnldev/options `optionNames`): an option added to a type and not here fails typecheck. A name not
// listed is refused where the bag is read, naming the option it is closest to.
import { optionNames } from '@gnldev/options';

export const EXPLAIN_RUN_NAMES = optionNames<import('./explain-run.js').ExplainRunOptions>()([
  'journal', 'runId', 'model', 'tools', 'systemSections', 'systemBase', 'messages', 'toolResults', 'trials', 'concurrency', 'match', 'expect', 'answers', 'representativeAt', 'maxSteps', 'timeoutMs', 'pricing', 'onProgress', 'signal', 'throttle',
]);
export const WORD_SHARES_NAMES = optionNames<import('./word-shares.js').WordSharesOptions>()(['words', 'value', 'concurrency', 'empty', 'retries', 'onProgress', 'signal']);
export const SAMPLED_TOOL_CHOICE_NAMES = optionNames<import('./word-shares.js').SampledToolChoiceOptions>()(['model', 'tools', 'tool', 'system', 'before', 'samples']);
export const TOOL_CHOICE_NAMES = optionNames<import('./word-shares.js').ToolChoiceProbabilityOptions>()([
  'baseURL', 'apiKey', 'model', 'tools', 'tool', 'system', 'before', 'after', 'topLogprobs', 'body', 'fetch',
]);
export const PRUNE_CHECK_NAMES = optionNames<import('./prune-check.js').PruneCheckOptions>()([
  'model', 'tools', 'systemSections', 'systemBase', 'history', 'prompts', 'remove', 'control', 'trials', 'margin', 'maxSteps', 'concurrency', 'onProgress', 'signal', 'throttle',
]);
export const BEST_FORM_NAMES = optionNames<import('./best-form.js').BestFormOptions>()([
  'model', 'scenarios', 'components', 'baseSystem', 'trials', 'target', 'pricing', 'maxSteps', 'concurrency', 'timeoutMs', 'onProgress', 'signal', 'throttle',
]);
export const STUDIO_LAB_NAMES = optionNames<import('./studio.js').StudioLabOptions>()(['config', 'models', 'pricing', 'maxParts', 'scenarios', 'logprobs']);
export const CAPSULE_NAMES = optionNames<import('./capsule.js').CapsuleOptions>()([
  'journal', 'runId', 'model', 'tools', 'system', 'history', 'memory', 'expect', 'answers', 'overrides', 'trials', 'unchanged', 'concurrency', 'maxSteps', 'timeoutMs', 'pricing', 'onProgress', 'signal', 'throttle',
]);
export const THREAD_PLAN_NAMES = optionNames<import('./thread-diagnose.js').ThreadPlanOptions>()([
  'journal', 'threadId', 'offset', 'limit', 'expect', 'trials', 'eliminationTrials', 'targetDifference', 'power', 'undetermined', 'modelId', 'pricing', 'hypotheses',
]);
export const DIAGNOSE_TURN_NAMES = optionNames<import('./thread-diagnose.js').DiagnoseTurnOptions>()([
  'journal', 'runId', 'model', 'tools', 'expect', 'trials', 'eliminationTrials', 'topK', 'workingMemory', 'overrides', 'answers', 'corrections', 'suggest', 'guess',
  'targetDifference', 'power', 'undetermined', 'concurrency', 'maxSteps', 'timeoutMs', 'pricing', 'onProgress', 'signal', 'throttle',
]);
export const PLAN_DIAGNOSIS_NAMES = optionNames<import('./thread-diagnose.js').PlanDiagnosisOptions>()([
  'arms', 'eliminationPlays', 'tokensPerPlay', 'trials', 'targetDifference', 'power', 'undetermined', 'price', 'guessArms',
]);
export const SAVE_SCENARIO_NAMES = optionNames<import('./saved-scenarios.js').SaveScenarioOptions>()([
  'journal', 'runId', 'agent', 'title', 'by', 'expect', 'overrides', 'answers', 'system',
]);
export const RUN_SCENARIOS_NAMES = optionNames<import('./saved-scenarios.js').RunScenariosOptions>()([
  'scenarios', 'model', 'system', 'tools', 'trials', 'returns', 'maxSteps', 'concurrency', 'pricing', 'onProgress', 'signal', 'throttle',
]);
export const PLAY_AGENT_NAMES = optionNames<import('./playground.js').PlayAgentOptions>()([
  'agent', 'model', 'messages', 'maxSteps', 'pricing',
]);
export const MEASURE_AGENT_NAMES = optionNames<import('./playground.js').MeasureAgentOptions>()([
  'agent', 'model', 'messages', 'maxSteps', 'pricing', 'expect', 'trials', 'compareTo', 'concurrency', 'onProgress', 'signal', 'throttle',
]);
