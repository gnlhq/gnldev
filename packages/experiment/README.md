# @gnldev/experiment

> Part of [GNL](https://github.com/gnlhq/gnldev), a full agent framework for TypeScript — works with the rest of it, or on its own.

Change an agent, run it again, count what happened. The pieces every "what if" question about an
agent is built from — the same ones `@gnldev/optimizer` and `@gnldev/lab` use, so either can be
installed without the other.

```ts
import { replayCounterfactual, maskConversation, runTrials, retryingFetch, coalitions, coalitionKey, shapley } from '@gnldev/experiment';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { createOpenAI } from '@ai-sdk/openai';

const storage = new SqliteStorage('runs.db');
// A provider that drops connections now and then: its failed requests are sent again.
const model = createOpenAI({ fetch: retryingFetch({ retries: 5 }) }).chat('gpt-4.1-mini');
declare const tools: Parameters<typeof replayCounterfactual>[0]['tools']; // the agent's own tool definitions

// Would the run have done the same work without its two earlier messages? Three trials per question.
const parts = { history: [0, 1], orderNumber: [2, 3] };
const players = Object.keys(parts);
const trial = (on: Set<string>) => async (): Promise<number> => {
  const dropInput = Object.entries(parts).filter(([p]) => !on.has(p)).flatMap(([, at]) => at);
  const r = await replayCounterfactual({ journal: storage.runs, runId: 'order-42', model, tools, prepareStep: maskConversation({ dropInput }) });
  return !r.divergence && r.missed.length === 0 ? 1 : 0;
};
const values: Record<string, number> = {};
for (const on of coalitions(players)) {
  const t = await runTrials([trial(on), trial(on), trial(on)], { concurrency: 3 });
  values[coalitionKey(on)] = t.values.reduce((a, b) => a + b, 0) / t.values.length; // a failed trial is left out
}
console.log(shapley(players, values)); // each part's share; they sum to value(all) − value(none)
```

## What each part does

| | What | Calls a model? |
|---|---|---|
| `replayCounterfactual` | A recorded run played again with another model, system prompt or context policy (`prepareStep`). Every tool call is answered from the recording; a call the run never made stops the replay as a **divergence**. Only the run's own calls count as recorded — tool calls of earlier turns in its input are history, not its work. Reports both sides' cost, calls, missed calls, reordering | the candidate |
| `DEFAULT_SUITE`, `runSuite`, `checkScenario`, `checkExpectation` | 26 scenarios a tool-using agent does, each with fake tools and an expectation a program checks: calls that must be made (with arguments), calls that must not, what the answer must say. No judge model. A model that could not be asked is an `error`, not a failed scenario | the model |
| `maskConversation` | A `prepareStep` that changes the run's input the same way on every step — messages replaced (`replaceInput`) or left out (`dropInput`) by position, new ones put in (`insertInput`) — and leaves tool results produced during the run (`hideToolResults`, by tool name — the call stays, its output becomes a note) out | — |
| `runTrials` | Jobs run `concurrency` at a time; one that throws is a failed trial, reported and **left out** — never counted as "the outcome did not happen" | — |
| `retryingFetch` | A fetch for a provider client: a reset connection, a 5xx or a 429 is sent again (`retries`, pause `delayMs` × attempt, `onRetry` to count them, `fetch` to wrap another); any other answer is returned as it is | — |
| `coalitions`, `coalitionKey`, `shapley` | Every subset of up to 12 parts, and each part's Shapley share from a value for every subset. The shares sum to value(all) − value(none); a subset without a value is an error, not a zero | — |
| `meanInterval`, `wilson` | A mean of k numbers with a Student's t interval; a rate with a Wilson interval (twenty out of twenty is not certainty) — 95% unless another `z` is given | — |
| `newcombe`, `normalQuantile` | The difference of two rates with Newcombe's hybrid score interval (built from the two Wilson intervals) at any `z`; the standard normal quantile — `normalQuantile(1 - 0.05 / (2 * m))` is the Bonferroni `z` for m comparisons | — |
| `distribution`, `tvd` | The share of each outcome, and the distance between two such distributions (0 the same, 1 nothing in common) | — |

## Options worth knowing

- `replayCounterfactual({ journal, runId, model, tools, system, maxSteps, prepareStep, pricing, timeoutMs, answers, overrides })`
  — `tools` are the agent's definitions (the journal keeps results, not schemas); their `execute` is
  never called. `system` replaces the recorded system prompt; `maxSteps` defaults to 20, `timeoutMs` to
  120000. `answers` (`{ toolName, args, output }[]`) are results for calls the run never made, from
  someone who knows what the tool would return: a matching call (same tool and arguments, key order
  aside) gets its `output` and the replay goes on. The result's `divergence` carries the `args` of the
  call no answer covered, `trace` every call with where its result came from (`'recorded'`, `'answer'`,
  `'override'`, `'none'`), and `recordedTrace` the run's own calls with their arguments (`recordedResults`: with what each returned). `overrides`
  (same shape) put a result in place of the RECORDED one — "what if the tool had said this?": they are
  looked up before the recording, a recorded call one stands for is used up (not missed), and the call
  is traced as `'override'`. Without them the recording always answers first, and a wrong tool result
  could never be tried as the cause of what the run did.
- `runSuite({ model, scenarios, pricing, maxSteps, concurrency, timeoutMs })` — `scenarios` defaults to
  `DEFAULT_SUITE`. A scenario is data: to try an agent's own system prompt or tool set on it, map the
  scenarios to new ones.
- `maskConversation({ dropInput, hideToolResults, replaceInput, insertInput })` — every position is one
  of the ORIGINAL input, applied in that order: replaced (`replaceInput: { 3: message }`), then left out
  (`dropInput`), then put in (`insertInput: [{ at, message }]`, before the input message at `at`; the
  input's length is the end). A position outside the input, or one both replaced and dropped, is refused.
- `checkExpectation(expect, calls, text)` — the check a scenario's `expect` (an `Expectation`: `calls`,
  `forbidden`, `answerIncludes`) runs, on any calls and answer: each failure in words, `[]` when it holds.
- A recorded input that holds a system message among its messages (observational memory puts its
  observations there) is replayed with `allowSystemInMessages`, as the run itself was called.
- `runTrials(jobs, { concurrency, onProgress, signal, throttle, stopOnServerError })` — `onProgress` after
  every job (`done`, `total`, `failed`, `lastError`, `concurrency`, and `throttled` while it waits); an
  aborted `signal` starts no further job and throws its reason. What the provider says decides before the
  job's own failure (`classifyFailure`): a **429** puts the job back, drops to one job at a time and waits
  `throttle.waitMs` × the refusals in a row (default 15000) — more than `throttle.maxWaits` in a row
  (default 4) and it stops; a **5xx** that outlived the client's retries stops at once
  (`stopOnServerError`, default true). Stopping throws a `ProviderStoppedError` saying how far it got.
  Progress also comes when a job starts (`running`) and when `retryingFetch` sends a job's request again
  (`retrying`: reason, attempt, pause) — `reportRetriesTo(listener, fn)` is how: it hears every retry made
  inside `fn`, through the async context.
- `retryingFetch({ retries, delayMs, fetch, onRetry })`.

## Why the mask is rebuilt every step

ai@7 hands each step the messages the previous `prepareStep` returned. A mask that filtered those by
position cut the wrong messages from the second step on — measured: 705 of 768 trials of one
experiment were caught by a check and discarded. `maskConversation` rebuilds each step from the two
lists the SDK keeps apart (`initialMessages`, `responseMessages`), so every step is masked from the
conversation as it is.

## Guarantees it keeps

- **A replay never runs a tool.** A test holds a tool whose `execute` throws and proves it is never
  called.
- **A failed trial is not an outcome.** It is counted apart and left out of every rate.
- **A share table adds up.** Shapley shares sum to value(all) − value(none), held by a test.

## Prices

Costs come from `@gnldev/durable`'s price table: the journal's `__pricing__` document over the
defaults, or the `pricing` you pass. A model missing from the table is reported as unpriced, not as
free.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
