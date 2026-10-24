# @gnldev/evals

> Part of [GNL](https://github.com/gnlhq/gnldev), a full agent framework for TypeScript — works with the rest of it, or on its own.

**Scorers + LLM judge** for `@gnldev/durable` runs. `scoreRun` reads from the journal trace → deterministic &
replayable scores (memoized if the journal is writable → same score on resume). `evalDataset` runs a
resumable suite (picks up where it left off if interrupted).

> Install: `pnpm add @gnldev/evals` — or use it from a [repo clone](https://github.com/gnlhq/gnldev): `pnpm install && pnpm -r build`.

```bash
npm i @gnldev/evals   # peer: @gnldev/durable, ai
```

```ts
import { scoreRun, contains, llmJudge, evalDataset } from '@gnldev/evals';

// Score a single run.
const s = await scoreRun(journal, 'order-1', [contains('Charged'), llmJudge({ model, rubric: 'is it polite?' })]);

// Dataset suite (resumable).
const r = await evalDataset({
  journal,
  dataset: { id: 'd1', cases: [{ id: 'c1', input: 'x', expected: 'echo:x' }] },
  run: async (input) => `echo:${input}`,
  scorers: [contains('echo')],
});
```

## API
- Rule-based scorers: `exactMatch`, `contains`, `regexScore`, `embeddingSimilarity`
- `llmJudge({ model, rubric })` — general-purpose LLM judge (parses SCORE/REASON)
- Ready-made LLM-judge scorers (thin factories wrapping `llmJudge`, take `{ model }`): `faithfulness`,
  `hallucination`, `answerRelevancy`, `toxicity`, `bias`, `completeness`, `contextPrecision`,
  `toneConsistency`. For all of them, a higher SCORE = better. The ones that need context
  (`faithfulness`/`hallucination`/`contextPrecision`) read `sample.context` (string | string[]); the ones
  that need a question (`answerRelevancy`/`completeness`) read `sample.input` — if it's missing they don't
  silently return 1, they return 0 + a clear reason.
- `scoreRun(journal, runId, scorers, { context?, input?, expected? }) → ScoreRunResult` — `sample.input`
  is the run's own journaled input (its prompt, or the last user turn of its messages) unless you pass
  `input`. `context` is not derived for you — a run's tool results are not all retrieval context — so pass
  it, or pass a function that picks it from the run's journal entries (e.g. your retrieval tool's results).
- `evalDataset({ journal, dataset, run, scorers }) → EvalDatasetResult` (resumable). Each case's `input` is
  also the scorers' `sample.input` (a string as is; `{ prompt }`/`{ messages }` as the prompt or last user
  turn; anything else as JSON). A case may carry `context`; a runner that retrieved its own returns
  `{ output, context }`, which wins.
- Scorer names must be unique within one call: a score is kept under its scorer's name (result, aggregate,
  journal memo), so both runners — and an agent's `scorers` in `createGnl`, at construction — throw on a
  duplicate, naming both. Give one a `name`
  (`llmJudge({ name: 'polite', ... })`, `faithfulness({ model, name })`) or rename any scorer with a spread:
  `{ ...contains('x'), name: 'has-x' }`.

## In CI: thresholds and `gnl eval`

A suite can say what it must reach. `defineEval` names the suite; `gnl eval` (from `@gnldev/cli`) runs
every `*.eval.ts` under `./evals` and exits 1 when one falls short:

```ts
// evals/support-agent.eval.ts
import { defineEval, faithfulness, contains } from '@gnldev/evals';
import { openai } from '@ai-sdk/openai';
declare function answer(input: string): Promise<{ output: string; context: string[] }>; // your agent

export default defineEval({
  dataset: { id: 'support', cases: [{ id: 'refund', input: 'How do I get a refund?' }] },
  run: (input) => answer(input),
  scorers: [faithfulness({ model: openai('gpt-4o-mini') }), contains('refund')],
  thresholds: { faithfulness: 0.8, contains: { every: 1 } }, // a mean, or every case
  concurrency: 4,
});
```

```bash
npx gnl eval            # ✓ / ✗ per suite, each scorer's mean and its threshold; exit 1 on a shortfall
```

A number is the least mean; `{ every }` is the least score of each case; `{ mean, every }` both. A suite
also fails when a case does not finish (its 0 is not averaged into a pass), and when a threshold names a
scorer the suite does not have — a misspelled name would otherwise never close the gate. In a test
instead of the CLI, `assertEvalThresholds(result, thresholds)` throws an `EvalThresholdError` that lists
each shortfall; `checkEvalThresholds` returns `{ pass, failures }`.

## How it works
Since scores are written to the journal, the eval suite is idempotent; long suites continue after a crash,
and the same input produces the same score. A memo is replayed only for what it was computed on: a score
for the same sample (output, question, expected, context) and the same scorer, a dataset case for the same
case and the same scorers. A scorer is known by its name and its `fingerprint`: the built-in factories set
it from their options (an `llmJudge` rubric and model, `contains`' substring), and a scorer without one is
known by the source of its `score`. Set `fingerprint` yourself when a custom scorer's behaviour comes from
values it closes over (`{ name: 'tone', fingerprint: optionsFingerprint('tone', { rubric }), score }`).
Anything else — another `expected`, an edited rubric, a scorer added to the suite, a score memoized by
0.9.0 before the runners passed the question — is computed again and replaces the record. The sample for
a run has one builder in `@gnldev/durable` (`runScoreSample`, with `scoreRunMemoized` for the memo), and
`scoreRun` and an agent's `scorers` both call it: a run the agent scored at completion is replayed when
it is scored again from Studio, not judged twice.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
