// The names of every options object @gnldev/evals reads, each held to its parameter's type by the
// compiler (@gnldev/options `optionNames`): an option added to a type and not here fails typecheck. A
// name not listed is refused where the bag is read, naming the option it is closest to.
import { optionNames } from '@gnldev/options';

export const EMBEDDING_SIMILARITY_OPTS_NAMES = optionNames<NonNullable<Parameters<typeof import('./scorer.js').embeddingSimilarity>[1]>>()(['threshold']);
export const LLM_JUDGE_NAMES = optionNames<NonNullable<Parameters<typeof import('./llm-judge.js').llmJudge>[0]>>()(['model', 'rubric', 'name', 'sampleFields']);
export const FAITHFULNESS_NAMES = optionNames<NonNullable<Parameters<typeof import('./scorers.js').faithfulness>[0]>>()(['model', 'name']);
export const HALLUCINATION_NAMES = optionNames<NonNullable<Parameters<typeof import('./scorers.js').hallucination>[0]>>()(['model', 'name']);
export const ANSWER_RELEVANCY_NAMES = optionNames<NonNullable<Parameters<typeof import('./scorers.js').answerRelevancy>[0]>>()(['model', 'name']);
export const TOXICITY_NAMES = optionNames<NonNullable<Parameters<typeof import('./scorers.js').toxicity>[0]>>()(['model', 'name']);
export const BIAS_NAMES = optionNames<NonNullable<Parameters<typeof import('./scorers.js').bias>[0]>>()(['model', 'name']);
export const COMPLETENESS_NAMES = optionNames<NonNullable<Parameters<typeof import('./scorers.js').completeness>[0]>>()(['model', 'name']);
export const CONTEXT_PRECISION_NAMES = optionNames<NonNullable<Parameters<typeof import('./scorers.js').contextPrecision>[0]>>()(['model', 'name']);
export const TONE_CONSISTENCY_NAMES = optionNames<NonNullable<Parameters<typeof import('./scorers.js').toneConsistency>[0]>>()(['expectedTone', 'model', 'name']);
export const SCORE_RUN_OPTS_NAMES = optionNames<NonNullable<Parameters<typeof import('./score-run.js').scoreRun>[3]>>()(['expected', 'memo', 'input', 'context']);
export const EVAL_DATASET_NAMES = optionNames<NonNullable<Parameters<typeof import('./dataset.js').evalDataset>[0]>>()(['dataset', 'run', 'scorers', 'journal', 'scope', 'concurrency', 'itemTimeoutMs', 'maxRetries', 'signal']);
export const CREATE_TRAJECTORY_SCORER_NAMES = optionNames<NonNullable<Parameters<typeof import('./trajectory.js').createTrajectoryScorer>[0]>>()(['expectedTools', 'requiredTools', 'forbiddenTools', 'maxToolCalls', 'weights', 'name']);
export const SCORE_TRAJECTORY_OPTS_NAMES = optionNames<NonNullable<Parameters<typeof import('./trajectory.js').scoreTrajectory>[2]>>()(['expectedTools', 'requiredTools', 'forbiddenTools', 'maxToolCalls', 'weights', 'name']);
export const TRAJECTORY_SCORER_FOR_OPTS_NAMES = optionNames<NonNullable<Parameters<typeof import('./trajectory.js').trajectoryScorerFor>[1]>>()(['expectedTools', 'requiredTools', 'forbiddenTools', 'maxToolCalls', 'weights', 'name']);
export const SCORE_TOOL_SEQUENCE_OPTS_NAMES = optionNames<NonNullable<Parameters<typeof import('./trajectory.js').scoreToolSequence>[1]>>()(['expectedTools', 'requiredTools', 'forbiddenTools', 'maxToolCalls', 'weights', 'name']);
export const CONTENT_SIMILARITY_NAMES = optionNames<NonNullable<Parameters<typeof import('./text-scorers.js').contentSimilarity>[0]>>()(['name']);
export const KEYWORD_COVERAGE_NAMES = optionNames<NonNullable<Parameters<typeof import('./text-scorers.js').keywordCoverage>[0]>>()(['keywords', 'name']);
export const TEXTUAL_DIFFERENCE_NAMES = optionNames<NonNullable<Parameters<typeof import('./text-scorers.js').textualDifference>[0]>>()(['name']);
export const ANSWER_SIMILARITY_NAMES = optionNames<NonNullable<Parameters<typeof import('./text-scorers.js').answerSimilarity>[0]>>()(['name']);
export const RUN_EXPERIMENT_NAMES = optionNames<import('./datasets-manager.js').RunExperimentOptions>()(['dataset', 'datasetId', 'run', 'scorers', 'experimentId', 'label', 'now']);
