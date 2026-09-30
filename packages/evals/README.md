# @gnldev/evals

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

## How it works
Since scores are written to the journal, the eval suite is idempotent; long suites continue after a crash,
and the same input produces the same score. A memo is replayed only for what it was computed on: a score
for the same sample (output, question, expected, context), a dataset case for the same case and the same
scorer names. Anything else — another `expected`, a scorer added to the suite, a score memoized by 0.9.0
before the runners passed the question — is computed again and replaces the record. The sample rules
(`scoreSample`, `inputText`, `assertDistinctScorerNames`, `memoizeScoring`) live in `@gnldev/durable`, so all
three runners share them.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
