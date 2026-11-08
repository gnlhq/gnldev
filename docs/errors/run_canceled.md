# run_canceled

**HTTP 409**

## What happened

The run this request names was canceled — by `POST /runs/:id/cancel`, by the caller's abort, or by an
operator — and a canceled run never resumes. Every door says so the same way:

- `POST /agents/:name/run` answers `409` with `code: "run_canceled"`. Before this code existed it answered a
  `400` with no code, which reads as "your request is malformed" and tells a retrying client to stop for the
  wrong reason.
- `POST /agents/:name/stream` and the AG-UI route send an `error` event (AG-UI: `RUN_ERROR`) whose `code` is
  `run_canceled`, to a client that was following the run when it was canceled and to one that asks for it
  afterwards. Before, a followed run that was canceled ended with a bare `done`.
- The chat route's error text reads `run_canceled: <message>` instead of the masked "An error occurred.".

## Why

A canceled run is finished by a decision, not by a failure: its completed prefix stays in the journal, and
running it again would repeat work somebody stopped on purpose. So the engine refuses to continue it, and the
answer is the same on every door, from one mapping (`endAnswerOf` in `@gnldev/durable`).

## What to do

Nothing re-sent will clear it. If the work should still happen, fork the completed prefix into a new run
(`forkRun`) or start the work under a new `runId` / `workKey`.
