# @gnldev/lab

> Part of [GNL](https://github.com/gnlhq/gnldev), a full agent framework for TypeScript — works with the rest of it, or on its own.

Why an agent did what it did, and what it would do changed — measured, not guessed. Each question is
answered by running the agent again with parts left out and counting what changed; the share of each
part is its Shapley value. Nothing here changes your agent: the result is something you read, and a
change you then make in your code.

| Question | Function | What it plays | Model calls |
|---|---|---|---|
| What brought this call about? | `explainRun` | a recorded run, replayed — **no tool runs** | 2^parts × `trials` |
| Which words decided it? | `wordShares` + `toolChoiceProbability` or `sampledToolChoice` | one decision, read from logprobs — or the share of tries where a provider gives none | 2^words, once each (× `samples` when sampled) |
| Can this prompt section go? | `checkPrune` | new prompts, for real — **tools run, give it fakes** | 4 arms × prompts × `trials` |
| Which parts does a new agent need? | `bestForm` | a scenario set with fake tools | 2^components × `trials` × scenarios |
| What would this run have done, changed? | `runCapsule` | a recorded run's copy — **no tool runs, nothing is written** | `trials` |
| Why did this turn of a thread go wrong? | `threadPlan` + `diagnoseTurn` | a thread's runs read, one turn's copies played — **no tool runs, nothing is written** | 2^parts × 2 + (arms + 1) × n |

The engine — replay, masking, trials, the arithmetic — is `@gnldev/experiment`; `@gnldev/optimizer`
uses the same one, and neither needs the other.

## Experimental

`@gnldev/lab` is experimental, and Studio's Lab tab says so. What that means, measured:

- **A thread diagnosis is measured on planted faults, one model.** 40 faults planted in agents' threads
  (a stale working memory, a turn fallen out of the window, a wrong tool result, a weak rule — each its
  own domain), diagnosed with gpt-6-luna through Studio's own routes, as its page asks (`guess`,
  `suggest`, 40 plays per arm): the right cause named in **39** (95% interval 87%–100%), a wrong one in
  **none**; the 40th undecided (its unchanged turn could not be judged). 15 turns with nothing wrong in
  their input, each made to fail once: **no cause named** in any (13 chance, 2 not tested). Elimination
  alone — the diagnosis before `guess` — named 15 of the same 40 and could not test 18; a model only
  asked which part was to blame named all 40, unproven. What the numbers are not: the faults were planted
  to be found — the misleading fact is in the text, where a reader sees it; a misleading recalled message
  could not be planted at all (the model never followed one); one model. Zero wrong causes in 55 puts the
  rate at most about 6.5%. The label comes off with faults a reader does not see, and more than one model.
- **Which words decided it, on a provider without logprobs, is sampled** — each word's share comes with
  how far chance can move it, and with few tries most shares are within it.
- **The API moves faster than the rest of GNL's.** It changed several times before this release and
  will change again; every change is in the CHANGELOG with what to do, as anywhere in GNL.

## What brought this call about?

```ts
import { explainRun, explainRunSize } from '@gnldev/lab';
import { retryingFetch } from '@gnldev/experiment';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { createOpenAI } from '@ai-sdk/openai';

const storage = new SqliteStorage('runs.db');
const model = createOpenAI({ fetch: retryingFetch() }).chat('gpt-4.1-mini');
declare const tools: Parameters<typeof explainRun>[0]['tools']; // the agent's own definitions; execute never runs

console.log(explainRunSize(4, 3), 'replays'); // know the bill before you ask
const r = await explainRun({
  journal: storage.runs, runId: 'order-42', model, tools,
  systemSections: { rules: 'Always look the order up first.', policy: 'Damaged: replace. Refund only if asked.' },
  messages: { greeting: [0, 1], orderNumber: [2, 3] }, // positions in the run's input; the last message stays
  toolResults: { lookup: 'searchOrders' },               // the result is hidden, the call stays
  trials: 3,
});
if (!r.representative.ok) console.log('this recording is not what the model usually does — shares are weak');
if (!r.dependsOnParts) console.log('the outcome is the same with every part and with none — read signs, not %');
for (const s of r.shares) console.log(s.part, s.share.toFixed(2), '±', s.noise.toFixed(2));
```

Before any share it says two things, because each was measured to mislead when left unsaid:
`representative` — with every part present, how often the recorded calls come out again (on 12 recorded
runs, 6 came out again in fewer than 2 of 3 trials: the recording was one draw of several); and
`dependsOnParts` — when the outcome is the same with every part and with none, the shares sum to zero,
and can still be large and opposite (a misleading message, and the turn that corrects it). Each share
has a `noise`: the same share computed from two halves of the trials.

Options: `journal`, `runId`, `model`, `tools`, `systemSections` (the system prompt as named sections;
omitted, the recorded prompt is kept whole), `systemBase` (text every played prompt starts with),
`messages`, `toolResults` (a part's tool name, or names), `trials` (default 3), `concurrency` (default 4),
`match` (`'calls'`, the default: the same tools with the same arguments; `'names'`: the same tools —
measured blind to an argument that changed; `'expect'`: plays that did what `expect` asks — the value a
failed run needs, whose recorded calls are the wrong ones), `expect`, `answers` (results for calls the
recording never made), `representativeAt` (default 2/3), `maxSteps`, `timeoutMs`, `pricing`,
`onProgress` (after every replay: `done`, `total`, `failed`, `lastError`), `signal` (aborted: no further
replay starts), `throttle` (`{ waitMs, maxWaits }`: a replay the provider refused with 429 is played
again after a pause, one at a time; a 5xx stops — see `runTrials` in `@gnldev/experiment`).

## Which words decided it?

```ts
import { wordShares, toolChoiceProbability } from '@gnldev/lab';
import { retryingFetch } from '@gnldev/experiment';

const value = toolChoiceProbability({
  baseURL: 'https://integrate.api.nvidia.com/v1', apiKey: process.env.NVIDIA_API_KEY!, model: 'nvidia/nemotron-3.5-lightning-30b-a3b',
  system: 'Damaged: ship a replacement with replaceOrder. Refund only if the customer asks for money back.',
  tools: ['replaceOrder', 'refundOrder'].map((name) => ({ type: 'function' as const, function: { name, parameters: { type: 'object', properties: {} } } })),
  tool: 'refundOrder',
  body: { chat_template_kwargs: { enable_thinking: false } },
  fetch: retryingFetch(),
});
const r = await wordShares({ words: ['My lamp', 'arrived', 'broken', 'and I want', 'my money', 'back.'], value });
for (const s of r.shares) console.log(s.word, s.share.toFixed(3));
```

The value is the probability that the next call is `tool`, read from the logprobs of the token that
starts the tool's name — one call per subset. A token that begins two tool names (NIM gave `re` for replaceOrder and refundOrder) is left out, so the value is a lower bound by its probability; most of it on such tokens is an error. Measured on NVIDIA NIM: "my money" +0.14 and "back." +0.12
towards a refund, "broken" −0.11; "my money back." alone gave 0.71 and the whole sentence 0.14 — the
replace rule overrode the refund rule. The same subset moved by a median 0.005 between two runs (at
most 0.57), so the large shares hold and the small ones are noise. It explains one decision, the next
one, not a whole run. A provider that returns no logprobs (Anthropic's API) is an error, not a zero.

OpenAI's API gives no probability for a tool call — measured on gpt-4.1-mini and gpt-6-luna, through
chat completions and responses alike: `logprobs.content` is null whenever the answer is a call. For such a
provider, and any model the AI SDK reaches, `sampledToolChoice` asks each subset `samples` times and the
value is the share of tries whose first call is `tool` (no call counts as not it):

```ts
import { wordShares, sampledToolChoice } from '@gnldev/lab';
import { openai } from '@ai-sdk/openai';
import { tool } from 'ai';
import { z } from 'zod';

const offered = { replaceOrder: tool({ description: 'Ship a replacement', inputSchema: z.object({}) }), refundOrder: tool({ description: 'Refund', inputSchema: z.object({}) }) };
const value = sampledToolChoice({ model: openai('gpt-4.1-mini'), tools: offered, tool: 'refundOrder', samples: 5 });
const r = await wordShares({ words: ['My lamp', 'arrived broken', 'and I want', 'my money back.'], value });
for (const s of r.shares) console.log(s.word, s.share.toFixed(2), '±', (2 * s.sd!).toFixed(2));
console.log(value.spent); // { calls, inputTokens, outputTokens }
```

Nothing runs: the tools' definitions are offered and the first step's call is read. A sampled value says
its variance — that of (picked + 1) / (samples + 2), so five tries that agree are not taken as certain —
and each word's share then carries `sd`: a Shapley value is a weighted sum of the subsets' values, each
measured apart, so its variance is the weights squared times theirs. A share within two `sd` of zero
cannot be told from chance.

Options: `wordShares({ words, value, concurrency, empty, retries, onProgress, signal })` — at most 12
words; a subset with no word is sent as `empty` (default '.'); a failed call is asked again `retries`
times (default 2), and still failing is an error; `value` answers a number or `{ value, variance }`.
`toolChoiceProbability({ baseURL, apiKey, model, tools, tool, system, before, after, topLogprobs, body,
fetch })` — `before`/`after` are chat messages around the text (a lookup already made goes in `after`);
`body` adds fields to every request. `sampledToolChoice({ model, tools, tool, system, before, samples })`
— `samples` default 5; `before` the AI SDK messages before the text.

## Can this prompt section go?

```ts
import { checkPrune } from '@gnldev/lab';
import { tool, type LanguageModel } from 'ai';
import { z } from 'zod';

declare const model: LanguageModel;
const fake = (out: unknown) => tool({ description: 'fake', inputSchema: z.object({ orderId: z.string() }), execute: async () => out });

const r = await checkPrune({
  model, tools: { searchOrders: fake({ status: 'delivered' }), replaceOrder: fake({ ok: true }) },
  systemSections: { rules: 'Always look the order up first.', tone: 'Be brief and warm.' },
  prompts: ['My lamp came with a shattered shade.', 'It came broken, refund me please.'],
  remove: 'tone', control: 'rules', trials: 45,
});
console.log(r.harmless, r.noise, r.removed.distance, r.control?.distance);
```

A low share makes a section a candidate. This checks it on prompts the agent was not explained on:
the full prompt twice (the noise floor), without the section, and without a `control` section that
should matter. A run's outcome is the tools it called, in order; `harmless` means removing the section
moved behaviour by no more than the noise plus `margin` (default 0.1). Measured: with 45 runs per
prompt the noise was 0.098, removing a tone section moved behaviour 0.149 (harmless), removing a
"look the order up first" rule 0.469. With 5 runs the noise alone was 0.24 — too few to tell.
**The tools run** (the prompts are new, there is nothing to replay): give it fakes.

Options: `model`, `tools`, `systemSections`, `systemBase`, `history` (messages before each prompt),
`prompts`, `remove`, `control`, `trials` (default 45), `margin`, `maxSteps`, `concurrency`, `onProgress`,
`signal`, `throttle` (as `runTrials`). The result says what the runs took (`inputTokens`, `outputTokens`).

## Which parts does a new agent need?

```ts
import { bestForm, promptSection, withoutTool } from '@gnldev/lab';
import { DEFAULT_SUITE } from '@gnldev/experiment';
import type { LanguageModel } from 'ai';

declare const model: LanguageModel;
const r = await bestForm({
  model, scenarios: DEFAULT_SUITE.slice(0, 10), trials: 3,
  components: {
    lookFirst: promptSection('Look an order up before you act on it.'),
    tone: promptSection('Be brief and warm.'),
    noKb: withoutTool('searchKb'),
  },
});
console.log(r.best?.components, r.best?.passRate.value, r.best?.costUsd);
for (const f of r.forms) console.log(f.components.join('+') || '(none)', f.passRate.value.toFixed(2), f.costUsd.toFixed(4));
```

Before an agent has runs of its own. A component changes a scenario — `promptSection` appends to the
system prompt, `withTool` offers a fake tool, `withoutTool` takes one away, or write your own
`{ apply }`. Every subset of components is a form of the agent, run on the scenarios `trials` times
(expectations a program checks, no judge). `best` is the cheapest form whose pass rate reaches
`target` (default: the best pass rate measured) — absent when no form passed a single scenario run, so
the cheapest of forms that all fail is never named best; `shares` is each component's part of the pass rate.
It picks nothing for you and deploys nothing: write the chosen components into the agent's code.

Options: `model`, `scenarios`, `components` (at most 12), `baseSystem` (the system prompt every form
starts from; default each scenario's own), `trials` (default 3), `target`, `pricing`, `maxSteps`,
`concurrency`, `timeoutMs`, `onProgress` (after every run of the scenario set), `signal`, `throttle` (a run
the provider refused with 429 is run again after a pause; a 5xx stops).

## What would this run have done, changed?

```ts
import { runCapsule } from '@gnldev/lab';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import type { LanguageModel, ToolSet } from 'ai';

declare const model: LanguageModel;
declare const tools: ToolSet; // the agent's definitions, changed as you want; execute never runs
const storage = new SqliteStorage('runs.db');

const r = await runCapsule({
  journal: storage.runs, runId: 'order-42', model, tools,
  system: 'Help with orders. If it came broken, refund it.',
  answers: [{ toolName: 'refund', args: { orderId: '42' }, output: { refunded: 250 } }],
  unchanged: { tools }, // also play the run as it was, as many times
});
console.log(r.sameAsRecorded.value, r.pending, r.difference);
for (const p of r.paths) console.log(p.count, p.calls.map((c) => `${c.toolName} (${c.source})`).join(' → '), p.text);
```

The run is copied into a capsule and played again there with what you changed: the system prompt, the
tools offered (taken away, added, described otherwise) and, with `history: false`, the conversation
before its last message left out. The run, its thread and its owner are only read. Every call is
answered from the recording — unless `overrides` put another result in its place (same tool, same
arguments; the call carries `source: 'override'`); a call the recording never made — a new tool, or the same tool with other
arguments — is answered from `answers`, written by whoever knows what the tool returns, or the trial
stops and the call is listed in `pending` to be answered and played again. A path answered that way is
marked: its calls carry `source: 'answer'`, and it is never counted as the recorded calls again.

`memory: false` leaves out exactly what the run's own memory layout (`:memctx.layout`, @gnldev/durable
`readRunMemoryLayout`) proves memory put in — observations, recall, the recent window, and the working
memory inside the system prompt — and keeps the turn's own messages and any row an input processor put
in. Nothing is derived from the counts: a run without a layout (recorded before layouts existed, of
another version, or unaligned), or one whose working memory has no known place in the system prompt,
is refused with that reason. When the layout places a working memory in the system prompt, `system`
is the prompt without it, and the working memory is put back behind it unless `memory` is false.

`expect` (an @gnldev/experiment `Expectation`: `calls`, `forbidden`, `answerIncludes`) is what a right
answer does: every trial is checked by a program, no judge model (`judgePlay`). `expected.passRate` is the
share of trials that did it, with its interval. A trial that stopped at a call no one answered did not
finish; it is judged only where the rest cannot change the answer — a forbidden call already made is a
failure, every expected call made (when nothing is asked of the answer and nothing is forbidden) a pass —
and is otherwise counted in `expected.undetermined`, not in the rate. `expected.bounds` is the rate over
every trial with each undetermined one counted a failure (`low`) and a pass (`high`): `passRate` alone can
lie outside them — a change that turns failures into calls nobody answered raises it with no pass more. Each path says how many of its trials passed and
how its first one fell short.

A change is worth its difference from the run left as it was, drawn as many times. With `unchanged:
{ tools }` (the agent's own tools) the run is also played `trials` times as it was — its own prompt,
history and memory, no override, the same `answers` — and counted the same way in `unchanged`.
`difference` is the change's rate minus the unchanged run's (Newcombe, 95%): with `expect` the rate of
right answers at its worst for the change (its undetermined plays wrong, the unchanged run's right),
without it the rate of plays that made the recorded calls again. An interval that holds 0 does not tell
the change from chance. The totals (`inputTokens`, `costUsd`) cover both.

Options: `journal`, `runId`, `model`, `tools`, `system`, `history` (default true), `memory` (default
true), `expect`, `answers`, `overrides`, `trials`
(default 3), `unchanged`, `concurrency`, `maxSteps`, `timeoutMs`, `pricing`, `onProgress`, `signal`, `throttle`.

## Thread diagnosis

```ts
import { threadPlan, diagnoseTurn } from '@gnldev/lab';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import type { LanguageModel, ToolSet } from 'ai';

declare const model: LanguageModel;
declare const tools: ToolSet; // the agent's definitions; execute never runs
const storage = new SqliteStorage('runs.db');

// Calls no model: every turn, how it ended, where its input came from, what diagnosing it would take.
const plan = await threadPlan({ journal: storage.runs, threadId: 'customer-7', modelId: 'gpt-4.1-mini' });
for (const t of plan.turns) console.log(t.turn, t.class, t.firstStepInputTokens, t.composition?.bySource, t.experiments?.plan.totalPlays);

const right = { calls: [{ toolName: 'createOrder', args: { address: 'Ankara' } }] };
const d = await diagnoseTurn({
  journal: storage.runs, runId: plan.turns.at(-1)!.runId, model, tools, expect: right,
  guess: model,                                                                 // name the likeliest parts first, then prove them (optional)
  workingMemory: '# Working Memory\naddress: Ankara',                          // a corrected copy to try (optional)
  overrides: [{ toolName: 'lookup', args: {}, output: { address: 'Ankara' } }], // a tool result to try instead (optional)
  suggest: model,                                                               // propose what the blamed parts should have said (optional)
});
console.log(d.verdict.sentence);
for (const a of d.arms) console.log(a.label, `${a.passed}/${a.judged}`, a.difference?.low);
```

A thread's turn did the wrong thing; why? `threadPlan` reads the thread's runs in order, a page at a time
(`offset`, `limit` — at most 50 turns), and calls no model. Each turn says how it ended. A turn that ended
before the model could be asked — the provider's 429 or 5xx, a network code, a timeout, or no model step
at all, read from the run's outcome record (`errorStatus`, `errorCode`, `errorName`), never from its
message — is `infrastructure`: nothing in it says how the agent behaves, and it is never diagnosed. Each
turn has its first model step's input tokens, and its input by source — system prompt, working memory,
observations, recall, recent window, the turn itself — in **characters**, from the run's own memory
layout (a share of characters, not of tokens; a run without a layout has only the total). For every turn
that can be diagnosed it lists the candidates, each with the change a test makes to it, the **absences**
(earlier turns of the thread missing from the input — fallen out of the recent window, or removed by an
input processor — put back from those turns' own records), what cannot be tested and why, and the plan:
how many plays, how many tokens, what it costs at the model's price. With `expect` every turn's own calls
are checked against it; `hypotheses` names the arms the person will bring so the plan counts them.

`diagnoseTurn` needs `expect` — what a right answer does — and refuses to start without it.

With `guess` (Studio's page sends it), a **guess** comes first: the model is shown the system prompt, the
conversation, what a right answer does, what the turn did and every part with its kind, and names at most
two parts (`MAX_GUESSES`) — for the working memory or a tool result, also what it should have said. Only
those are played, beside the turn unchanged: a correction for data, the part left out for anything else.
A rule or a message is never "corrected" from a guess, nor the result of a tool the expectation names:
a corrected rule can carry the answer itself (measured — a guessed prompt that changed one city's hub to
the right one was borne out). A guess the plays bear out is the verdict, and elimination is not run; one
they do not is said so (`guess.verified: false`), and the stages below run as without it — the 5% level
shared, 2.5% for the guess and 2.5% for them; the turn unchanged is played once for both. The guess is a
lead, never the verdict: the cause is named only by plays. Without `guess` it works in two stages that
never share a play:

1. **Elimination**: `explainRun` over the turn's parts, `eliminationTrials` (default 2) plays of every
   combination, valued by how often a play does what `expect` asks (`match: 'expect'`) — a failed turn's
   recorded calls are the wrong ones, so "how often they came out again" would explain the mistake, not
   its cause. `blame` is the share with its sign reversed: how far a part's presence pulls the plays away
   from the right answer. Past 8 parts, the four groups (system / memory / history / tool results) are
   the players.
2. **Verification**: the `topK` (default 3) most blamed parts, every absence, and every hypothesis the
   person brought (`workingMemory`, `overrides`) are each changed in the capsule — left out, replaced, put
   back, the result overridden — and played `trials` times, beside the turn played `trials` times
   unchanged. Each arm's rate of right answers is compared with the unchanged turn's: Newcombe's interval
   of the difference, at the Bonferroni level over every arm and the joint arm. When no single change
   helps, the two most promising together are the joint arm.

The verdict follows rules written before any play: the unchanged turn right most of the time (the 95%
lower bound of its rate at least 0.66) is **chance** — the recorded failure was a draw, and no cause is
named; an arm whose difference holds above 0 is the **cause** (the largest; the others "also helped") —
unless the two largest cannot be told apart, which says so; otherwise the joint arm, if it holds; otherwise,
when nothing was tested — every arm too undetermined, or no arm played after an elimination that could
not finish — the changes are **not tested** and nothing is said of the cause; otherwise the cause is **not
among the candidates**. Every comparison is read at its worst for the change: the arm's
undetermined plays (stopped at a call nobody answered) counted wrong, the unchanged turn's counted right —
a change that only turns wrong answers into unanswered calls cannot win that way. Each arm carries both
`bounds` of its rate and the `observedDifference` over its judged plays beside the worst-case
`difference`. An arm — or the unchanged turn — whose plays are more than 20% undetermined, even at the
share's 95% lower bound (`MAX_UNDETERMINED_SHARE`: past it the two bounds lie further apart than half the
planned difference), is not tested and decides nothing; its `pending` calls are listed, to be answered (`answers`) and diagnosed
again. Memory candidates of a run without a layout are named as not
tested, with the reason. `planDiagnosis` is the planner: plays per arm for a `targetDifference` (default
0.4) at `power` (default 0.8) and the Bonferroni level, planned for the worst-case comparison with an
assumed `undetermined` share (default 0.1, `EXPECTED_UNDETERMINED`) — the verdict charges it against the
change, so the plan does too (measured: a true 0.4 with 10% undetermined on both sides was found in 62 of
80 diagnoses at the planned n). `worstCaseDetectableDifference` is the smallest true difference seen at
that share; `detectableDifference` the one if no play stops. `guessArms` (the arms a guess plays first, 0 for
none) adds `guessPlays` and halves the level the rest is planned at. Measured with a mock model that errs at random 30% of the
time whatever it is shown: a cause was named in 3 of 200 seeded diagnoses; six arms of pure noise named one in 1.8%
of 2000 draws at the Bonferroni level and in 10% without it.

Leaving a part out tests whether it was in the way. A part that said something wrong — an old address in
the working memory, a tool result that lied, an earlier message that misled — is not fixed by its absence
(the model then knows nothing) but by what it should have said. `corrections` (`{ [part id]: text }`) is
the person's: a system section's text, a message part's (its first message's content; the rest of the part
left out; a part holding a tool call or its result cannot be corrected as text, and is said so), the
working memory, or a tool result (JSON, else the text, put in place of each of that tool's recorded
results). Each is an arm `correct:<part>`. With `suggest` (a model) the most blamed parts are shown to it
with what a right answer does, and each correction it proposes is played as an arm marked `(suggested)`
and listed in `suggestions`; only parts elimination blamed are asked about — a correction of any part
could put the right answer anywhere, and naming that part the cause would be the suggester's doing. A
"not found" verdict names in `uncorrected` the blamed parts that were only ever left out.

`threadPlan` options: `journal`, `threadId`, `offset`, `limit`, `expect`, `trials`, `eliminationTrials`,
`targetDifference`, `power`, `undetermined`, `modelId`, `pricing`, `hypotheses` (`{ workingMemory?, overrides?: tool names, corrections?: part ids, suggest? }`).
`diagnoseTurn` options: `journal`, `runId`, `model`, `tools`, `expect`, `trials` (default planned),
`eliminationTrials`, `topK`, `workingMemory`, `overrides`, `answers`, `corrections`, `suggest`, `targetDifference`, `power`, `undetermined`,
`concurrency`, `maxSteps`, `timeoutMs`, `pricing`, `onProgress`, `signal`, `throttle`.
`planDiagnosis` options: `arms`, `eliminationPlays`, `tokensPerPlay`, `trials`, `targetDifference`,
`power`, `undetermined`, `price`.

## In Studio

Give Studio the lab and it shows a **Lab** tab with three tabs of its own: **Improve**, **New agent**
and **Scenarios**. One button leads there, **Open in Lab** — on a completed run in the Inspector, and on a
thread in its ledger. Improve is one screen for both: a thread's turns sit on a strip above (folded away
by whoever wants the turn alone), the turn opened — the run sent, or the thread's failed turn — chosen; a
run of no thread has no strip. What is open is picked in the Inspector only — a run's button sends its thread too, so the Lab asks
nothing to find it — and a badge says which was sent: **Run** or **Thread**. Below,
for the turn, what a right answer does is written once, then **1. Why?** (the explanation's shares, and
on a thread's turn the diagnosis that proves the suspects) and **2. Change and try** (the capsule). The
screen says that only that turn is played again — the turns after it do not change; no step plays a
change through to later turns.

**Why?** first shows the parts proposed from
its own record — the recorded system prompt cut at blank lines, each earlier turn
of its input, each tool it called — with how many replays explaining it takes and roughly what it
costs, before anything is spent (`estimatedTokens`: each part is out of half the replays, so a replay's
input is the recorded one less half the parts' share of its characters; the result's footer puts what was
spent beside it). Every confirmation in the Lab says the same things in the same order: the plays, the
tokens (about, or at most for a thread diagnosis, whose later stages may not run), the price, that the
conversation goes to the model's provider, and that no tool runs and no record changes. The last user message is never a part, and a tool call is never in one
part with its result in another. A memory run's parts are named by where they came from — `wm` (the
working memory in the system prompt), `om`, `recall`, `recent` — as the run's own layout proves it; a
row no memory row accounts for is `unlabelled`. A memory run without a layout is not guessed at: its
parts are the plain turns, each `source: 'unknown'`, and the plan's `layout` says why. A tool the run
called that the agent's config does not define (memory's own `updateWorkingMemory`) is offered with no
description and answered from the recording, so a replay can make the call the recording made. An explanation asks for
confirmation, is written to the audit log, and shows first whether the recording is representative and
whether the outcome depends on the parts at all, then each part's share with its noise. Studio hands
every call the reader of the request it serves, scoped to the caller's organization: another
organization's run is not found.

```ts
import { studioLab } from '@gnldev/lab';
import { createStudioApp } from '@gnldev/studio';
import { toJournal, type CreateGnlConfig } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { openai } from '@ai-sdk/openai';

declare const config: CreateGnlConfig; // the config createGnl is given — its agents' tools answer the replays
const storage = new SqliteStorage('runs.db');

const studio = createStudioApp({
  reader: toJournal(storage),
  apiBase: '/studio',
  lab: studioLab({ config, models: { 'gpt-4.1-mini': openai('gpt-4.1-mini') } }),
});
```

`studioLab({ config, models, pricing, maxParts, scenarios, logprobs })` — `maxParts` (default 6, 64
combinations) caps the parts proposed for a run: past it the oldest turns are merged first, then the
system prompt's sections. `logprobs` names, per Studio model name, an OpenAI-compatible endpoint that
returns a tool call's logprobs (`{ baseURL, apiKey, model, body?, fetch? }`): "which words decided" reads
that model's probability once per subset; every other model is sampled.

**New agent** is a playground. An agent is written on the page — from nothing, or copied from one the
host's code defines (`GET /lab/playground/base`: its prompt when fixed, its tools' definitions) — with its
prompt, its tools (name, description, parameters as a JSON Schema) and what each tool returns: an answer
for given arguments, and a default for any other. It is talked to (`POST /lab/playground/play`): every
tool call is answered from the page and shown with where its answer came from; a call nothing answers
stops the play, named, and one click opens its answer. It is measured (`POST /lab/playground/measure`):
the conversation's last user message played `trials` times against what a right answer does — and, with a
definition pinned as **A**, A played as many times beside it, with the difference and whether it is past
chance. The agent has a name of its own, at the top (a copy starts with its agent's): the conversation
is kept as a scenario under that name (`POST /lab/playground/scenario`; typed on the page, no person's),
and nothing is kept without one. The scenarios kept under the name are listed in the playground and
played together against the definition on the page now (`POST /lab/playground/scenarios/run`: its
prompt, its tools and what they return in place of each scenario's own) — change something, see which
still go right; tick some and only those are played (`ids`). Nothing runs and nothing else is kept: the
definition and the conversation come with every request; plays and measures are audited
(`lab.playground`) by how many tools and messages, never what they say. In code: `playAgent` and
`measureAgent`.

Below the playground, **Try the prompt sections** is `bestForm` for an agent that has no runs yet: the
agent's system prompt as written in its config is cut at blank lines, each section a component — and,
under **Tools**, each tool the ticked scenarios offer taken away (`without <name>`, `withoutTool`) and each
tool written there added (`with <name>`: its name, description, JSON Schema and the answer every call
gets, `withTool`), at most ten components in all — and every combination is tried on the scenarios you
tick — `scenarios` per agent name, `DEFAULT_SUITE` when
not given — with their fake tools; the agent's own tools never run. When no form passes a single scenario
it names none best and says so. It shows the plan before anything
is spent, asks for confirmation, is audited as `lab.best-form`, and answers with the cheapest form that
passes as well as the best one (by cost when the model is priced, by tokens when it is not), each
section's share and every form. An agent whose prompt is built per request has nothing to divide and is
refused with that reason.

**Scenarios** holds the turns kept from **Change and try** (**Keep as scenario**, once what a right
answer does is written): each a copy of the turn's conversation as the model saw it, the expectation, the
prompt as edited and the tool answers typed (`POST /lab/saved-scenarios`). **Play them all**
(`POST /lab/saved-scenarios/run`) plays every kept scenario against the agent as the host's code defines
it now, every call answered from the copy, no tool run; a call the copy does not hold stops the play and
is listed; tick some and **Play the ticked** plays only those (`ids`). **Edit** changes a kept scenario in place (`PATCH /lab/saved-scenarios/:agent/:id`, audited
`lab.scenario-edit` with the fields changed): its title, what a right answer does, what each recorded call
returns, and the answers for calls the recording never made — not the conversation, and not whose it is.
A play is shown and kept nowhere — its failures quote the calls made, which carry the
people's data. A scenario copied from a person's conversation is kept under `personRecordKey` (see
@gnldev/durable): erasing them erases it; one whose turn names no person is kept under the agent. Every
scenario route takes 'write', and saving, removing and playing are audited (`lab.scenario-save`,
`lab.scenario-delete`, `lab.scenario-run`) by title and run, never content. Below them is the set the
host's code defines (`scenarios`, or `DEFAULT_SUITE`), which New agent tries its forms on.

In code: `scenarioOfRun({ journal, runId, agent, title, by, expect, overrides?, answers?, system? })` copies
a turn (writes nothing), `saveScenario`, `listScenarios`, `findScenario`, `deleteScenario`, `updateScenario` keep them, and
`runScenarios({ scenarios, model, system?, tools?, trials? })` plays them.

**Change and try** is the capsule of the turn: its recorded system prompt to edit,
the agent's tools to keep, take away, describe otherwise or add (a new one with its JSON Schema), the
history and memory switches, what a right answer does (calls it must and must not make, what the answer
must say — the page's, written once above), and the recorded calls. The working memory is
shown apart from the prompt; a memory run without a layout says it cannot be told where its input came
from, and memory is not offered to leave out.
A play that changes anything (the prompt, the tools, history or memory off, an override) is played beside
the run as it was, as many times, and the result opens on the two side by side with the difference and
whether it is past chance; the confirmation counts both. A play asks for confirmation and is audited as `lab.capsule` with what changed — whether the prompt
did, the tool names, how many answers — never the text. Calls the recording never made are listed with their arguments, each with a box for what the tool returns; the
answers stay in the page and go with the next play.

**Which words decided it?** (under **Why?**) cuts the turn's last user message into at most eight groups
of neighbouring words (`GET /lab/words-plan`; join or split them, at most ten) and asks, for every subset
of them, whether the agent's next call is the tool chosen — by default the one the run called first
(`POST /lab/words`). A model named in `logprobs` is asked once per subset for its probability; any other
`samples` times (default 5), and each word's share shows ± two standard deviations and is marked when
chance alone could make it. The plan shows the calls, tokens and price first. **Would removing this
section change anything?** (under **Change and try**) is `checkPrune` on the turn
(`GET /lab/prune-plan`, `POST /lab/prune`): the run's system prompt cut at blank lines, one section to
remove and optionally a control known to matter, new messages written on the page each in place of the
last one, and `trials` runs per message and arm (default 10). Its tools are called — the agent's
definitions, answered with what the page wrote for each, never the agent's code; a call with no answer
gets an error back and is listed, since what follows it is not the agent's. The result says whether the
removal moved behaviour past the noise, and whether the control did — when it did not, the check could
not tell a section that matters, and 'harmless' is not to be trusted. Neither is kept: a prune's messages
and a word's text are the person's own words. Both are audited (`lab.words`, `lab.prune`) by counts —
how many words, prompts and answers — never the text.

The thread's strip and the proof in **Why?** come from `GET /lab/thread-plan`. The turns are drawn on a timeline — each column's height
the first step's input tokens, its colours the input's sources by character share, an infrastructure turn
hatched, a turn without a layout grey, a turn judged wrong marked ✗, a turn that ended in an error
marked !; past 20 turns it scrolls. A chosen
turn shows its input by source and its candidates. Nothing runs until what a right answer does is
written down; a corrected working memory and tool results to try instead are optional. By default the
model first guesses the parts to blame, and only those are played (**Guess first**, `guess`): the result
says whether the plays bore the guess out, and when they did, that elimination did not run. By default too
the model proposes what the blamed parts should have said (each proposal its own arm, marked suggested). The
result has a box per blamed part — filled with the proposal, or empty for a part only left out — to write
what it should have said and diagnose again; the text stays in the page, and the audit and the kept
experiment name the parts only. The plan is
shown before anything is spent, with a warning when the plays per arm can only see a large difference.
The diagnosis (`POST /lab/thread`) asks for confirmation, is audited as `lab.thread` with the run, the
model, n and the arms asked for — never the expectation, the corrected text or the results typed — and
answers with the verdict, the elimination's shares, each arm beside the turn unchanged (rates with their
intervals, failed plays in no denominator), and the ways the plays went. Every chart is a figure with a
one-sentence finding and a table a screen reader reads. The report downloads as Markdown, with the
request that reproduces it. The result is kept under the run (`<runId>:derived:lab:exp:thread:`) and
goes with it; the tool results typed are not kept, only how many.

Every finished experiment — an explanation, a capsule play, a thread diagnosis, a best form — is kept for the
organization's admins (`GET /lab/experiments?kind=&target=`, the write permission): who ran it, what was
asked and what came back, under the caller's organization. A capsule's answers are not kept, only how
many there were. Each mode lists the ones kept on its run or agent, and one opens to its result.

## What the numbers are not

- **The shares are the model's you ran.** Explaining a run with a cheaper model measures the cheaper
  model's reasons. A model that changes changes them; keep the model id with a result.
- **Small shares are noise.** Two runs of the same experiment moved shares under about ±0.08 at 3 and at
  6 trials. Read the large ones and the signs; show `noise` beside every share.
- **A run's text goes to the provider.** Every replay sends the conversation to the model you give it.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
