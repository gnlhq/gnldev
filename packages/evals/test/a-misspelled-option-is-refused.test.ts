// Every options object @gnldev/evals reads refuses a name it does not take (@gnldev/options), naming the
// option it is closest to: a misspelled `forbiddenTools` would score a trajectory that used them as clean.
import { describe, it, expect } from 'vitest';
import {
  embeddingSimilarity, llmJudge, faithfulness, hallucination, answerRelevancy, toxicity, bias, completeness, contextPrecision,
  toneConsistency, scoreRun, evalDataset, createTrajectoryScorer, scoreTrajectory, trajectoryScorerFor, scoreToolSequence,
  contentSimilarity, keywordCoverage, textualDifference, answerSimilarity, createDatasetsManager,
} from '../src/index.js';
import { InMemoryJournal } from '@gnldev/durable';

const model: any = {};
const embed = async (t: string[]) => t.map(() => [1]);

describe('@gnldev/evals: a misspelled option is refused', () => {
  it.each([
    ['embeddingSimilarity', () => embeddingSimilarity(embed as any, { treshold: 0.5 } as any), /embeddingSimilarity: `treshold` .* did you mean `threshold`\?/],
    ['llmJudge', () => llmJudge({ model, rubic: 'x' } as any), /llmJudge: `rubic` .* did you mean `rubric`\?/],
    ...(['faithfulness', 'hallucination', 'answerRelevancy', 'toxicity', 'bias', 'completeness', 'contextPrecision'] as const).map((n) =>
      [n, () => ({ faithfulness, hallucination, answerRelevancy, toxicity, bias, completeness, contextPrecision } as any)[n]({ model, nam: 'x' }), new RegExp(`${n}: \`nam\` .* did you mean \`name\`\\?`)] as const),
    ['toneConsistency', () => toneConsistency({ model, expectedtone: 'x' } as any), /toneConsistency: `expectedtone` .* did you mean `expectedTone`\?/],
    ['scoreRun', () => scoreRun({} as any, 'r', [], { expect: 'x' } as any), /scoreRun: `expect` .* did you mean `expected`\?/],
    ['evalDataset', () => evalDataset({ dataset: [], run: async () => '', scorers: [], concurency: 2 } as any), /evalDataset: `concurency` .* did you mean `concurrency`\?/],
    ['createTrajectoryScorer', () => createTrajectoryScorer({ forbidenTools: ['x'] } as any), /createTrajectoryScorer: `forbidenTools` .* did you mean `forbiddenTools`\?/],
    ['scoreTrajectory', () => scoreTrajectory({} as any, 'r', { requiredTool: ['x'] } as any), /scoreTrajectory: `requiredTool` .* did you mean `requiredTools`\?/],
    ['trajectoryScorerFor', () => trajectoryScorerFor({} as any, { maxToolCall: 1 } as any), /trajectoryScorerFor: `maxToolCall` .* did you mean `maxToolCalls`\?/],
    ['scoreToolSequence', () => scoreToolSequence([], { weight: {} } as any), /scoreToolSequence: `weight` .* did you mean `weights`\?/],
    ['contentSimilarity', () => contentSimilarity({ nme: 'x' } as any), /contentSimilarity: `nme` .* did you mean `name`\?/],
    ['keywordCoverage', () => keywordCoverage({ keyword: ['x'] } as any), /keywordCoverage: `keyword` .* did you mean `keywords`\?/],
    ['textualDifference', () => textualDifference({ nme: 'x' } as any), /textualDifference: `nme`/],
    ['runExperiment', () => createDatasetsManager(new InMemoryJournal() as any).runExperiment({ dataset: [], run: async () => '', scorers: [], experimentID: 'e' } as any), /runExperiment: `experimentID` .* did you mean `experimentId`\?/],
    ['answerSimilarity', () => answerSimilarity({ nme: 'x' } as any), /answerSimilarity: `nme`/],
  ])('%s', async (_n, build, message) => {
    await expect((async () => (build as () => unknown)())()).rejects.toThrow(message);
  });
});
