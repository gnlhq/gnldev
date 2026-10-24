# @gnldev/optimizer

> Part of [GNL](https://github.com/gnlhq/gnldev), a full agent framework for TypeScript — works with the rest of it, or on its own.

Lower what your agents cost without lowering what they do — measured on the conversations they
actually had, not on a benchmark someone else ran.

An agent's money goes to five places: the same opening (system prompt, tool definitions) re-sent on
every step; old tool output carried along after it was used; the expensive model doing simple work;
non-urgent work at interactive prices; answers longer than they need to be. This package finds which
of them your agent pays for, gives you the lever for each, and proves a change keeps the work the same
before you make it.

```ts
import { diagnoseAgent, replayCounterfactual, maskOldToolOutputs, withCacheBreakpoints } from '@gnldev/optimizer';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import type { AgentConfig } from '@gnldev/durable';
import { openai } from '@ai-sdk/openai';

const storage = new SqliteStorage('runs.db');

// 1. Where the money went — read from what the provider billed. No model is called.
const d = await diagnoseAgent({ journal: storage.runs, agent: 'support' });
for (const f of d.findings) console.log(f.lever, f.tokens, f.estimatedSavingUsd?.toFixed(2) ?? 'unpriced', f.why);

// 2. Would a cheaper model have done the same work? Replay a recorded run — no tool is ever executed.
declare const tools: Parameters<typeof replayCounterfactual>[0]['tools']; // the agent's own tool definitions
const r = await replayCounterfactual({ journal: storage.runs, runId: 'order-42', model: openai('gpt-4.1-mini'), tools });
console.log(r.divergence ?? 'same calls', r.recorded.costUsd, r.candidate.costUsd);

// 3. The levers, as an agent uses them.
const agent: AgentConfig = {
  model: withCacheBreakpoints(openai('gpt-4.1'), { cacheKey: 'support' }),
  processors: [maskOldToolOutputs({ keepLast: 2 })],
};
```

## What each part does

| | What | Calls a model? | Changes quality? |
|---|---|---|---|
| `diagnoseAgent` | Cost, tokens, cache reads and writes per agent; the opening re-sent on later steps and what a cache would save after one write per run; tool output older than `keepLast` steps (estimated) | no | — |
| `replayCounterfactual` | A recorded run played again with another model, system prompt or context policy. Every tool call is answered from the recording; a call the recording never made stops the replay as a **divergence**. Reports both sides' cost, calls, missed calls, reordering | the candidate | it measures it |
| `withCacheBreakpoints` / `cacheBreakpoints` | Anthropic: cache marks on the system message and the last message (within its limit of 4). OpenAI: your `promptCacheKey`. Other providers: untouched | — | no — the provider is sent the same tokens |
| `maskOldToolOutputs` | Tool output older than `keepLast` steps is replaced, for that step only, by a one-line note. The journal keeps the full output | — | possibly — replay it first |
| `replayAgent` | An agent's latest runs replayed under one candidate, summed up: divergence rate, skipped calls, reordering, cost ratio (none made up when a model is unpriced) | the candidate | it measures it |
| `saveExperiment`, `listExperiments`, `renderReport` | Each replay kept (run ids, calls and numbers — no conversation text) and a Markdown report: where the money goes, findings, replays tried, and a recommendation | — | — |
| `DEFAULT_SUITE`, `runSuite`, `compareOnSuite` | 26 scenarios a tool-using agent does (refunds, lookups, multi-step work, plain conversation, tricky arguments), each with fake tools and an expectation a program checks — no judge model | the models compared | it measures it |

## In Studio

Give Studio the optimizer and it shows an **Optimizer** tab: the diagnosis per agent, a replay of an
agent's latest runs with a candidate model you offer, the replays tried so far, and a downloadable
report. **It recommends; it changes nothing** — adopting a cheaper model is a change you make in your
code, reviewed and tested like any other. Studio hands every call the reader of the request
it serves — scoped to the caller's organization — and never holds a model itself; a replay calls a
model, so it needs write access and is written to the audit log.

```ts
import { studioOptimizer } from '@gnldev/optimizer';
import { createStudioApp } from '@gnldev/studio';
import { toJournal, type CreateGnlConfig } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { openai } from '@ai-sdk/openai';

declare const config: CreateGnlConfig; // the config createGnl is given
const storage = new SqliteStorage('runs.db');

const studio = createStudioApp({
  reader: toJournal(storage),
  apiBase: '/studio',
  optimizer: studioOptimizer({ config, models: { 'gpt-4.1-mini': openai('gpt-4.1-mini') } }),
});
```

## Options worth knowing

- `diagnoseAgent({ minCacheTokens })` — the smallest opening a provider caches (default 1024; OpenAI's
  floor and Anthropic's for most models, Gemini's is higher). A shorter opening is never counted as
  cacheable; the diagnosis says so in a note instead.
- `maskOldToolOutputs({ keepLast, minChars })` — leave out tool output older than `keepLast` steps
  (default 2), but keep any result shorter than `minChars` characters (default 200) whatever its age.

## Guarantees it keeps

- **A replay never runs a tool.** Each tool's `execute` is replaced by a lookup in the recorded run; a
  test holds a tool whose `execute` throws and proves it is never called.
- **A run's model never changes mid-run.** Nothing here routes per request: a cheaper model is a change
  you make to an agent, for its new runs.
- **The journal keeps the truth.** Masking and cache marks change what the provider is sent for a step,
  never what is recorded, and both are pure functions of the request, so a resumed run asks the same.
- **A model that could not be asked is not a quality result.** A 404 or a rate limit marks the scenario
  `error`; it is left out of the pass rate and of a comparison.

## What it does not do, on purpose

Per-request routing between models, escalating to a bigger model mid-run, answering from a "similar
question" cache, and compressing tool arguments or results. Each one can change what a run does
without anyone seeing it: a routed run loses its provider cache and can hand tool results to a model
that did not ask for them, and a cached answer skips the tool calls that should have happened.

## Prices

Costs come from `@gnldev/durable`'s price table: the journal's `__pricing__` document over the
defaults, or the `pricing` you pass. A model missing from the table is reported as unpriced, not as
free. Cache writes are billed at the row's `cacheWritePer1M` (Anthropic 1.25x input for 5 minutes).

## License

Apache-2.0 — see [LICENSE](./LICENSE).
