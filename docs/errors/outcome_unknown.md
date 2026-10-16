# outcome_unknown

**HTTP 409 · `resumable: true`**

## What happened

A tool call reached its `maxRetries` limit, and its last attempts started the tool's body without
ever reporting a result. Whether the effect happened is not known yet. The run is waiting
(`waiting-outcome`), not failed.

The tool can still report what happened: it has a `recover()` hook, or it is `idempotent: true`.

## Why

An attempt is handed over when its process is judged gone. A process cut off from the store, for
example by a network partition that ended its database sessions, is judged gone too. But it may not
have stopped. It can still be inside the tool's body, and it can land the effect seconds later.

Calling the call "failed" at that moment would be a claim that nothing happened, and the attempt can
still prove it wrong. Measured on Postgres with three partitions in a row: such runs ended `failed`
20 times in 20, and the effect then landed once.

So the framework does not start the tool again (the limit holds), and it does not declare a failure.
It waits for the call's result.

## What happens next — on its own

The run continues from the call's recorded result as soon as one exists. That result can come from:

- **the late attempt itself:** when its body finishes, it records its result. It does this even though
  the call was handed on, as long as no live attempt holds the call;
- **`recover()`:** the executor asks it again, backing off from `outcomeAskMs` (2 s by default),
  12 times at most;
- **an operator** (see below).

The model then sees what really happened, and the run ends truthfully.

## What to do

Usually nothing. `gnl pending` lists the call in its "in doubt" group while it waits:

```bash
gnl pending                     # the call, its key, how many attempts started
```

If the external system shows the effect happened, declare it done there. The run continues from your
declaration, and your name is recorded with it. If it did not happen and must not, cancel the run.

A late result that arrives after the call was settled is not dropped. It is kept beside the call as
evidence (`<runId>:proc:late-<toolCallId>`) and logged.
