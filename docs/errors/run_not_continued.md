# run_not_continued

**HTTP 409 · `resumable: true`**

## What happened

The process executing a detached run stopped (it crashed, it was killed, its database cut it off), and the
process that took the run over could not continue it: asking how to continue it failed. Typical causes are
an agent this deployment no longer has, a run owner the store could not read, or a recorded input the engine
refuses to run again. Nothing of the run was executed again. Its execution record is parked with the reason,
and the server logged it once:

```
@gnldev/durable: run '<runId>' could not be continued here: <the reason>
```

A client following the run — the one that sent the request, or one sending the same request again — gets
this error as the run's ending. On `POST /agents/:name/run` it answers 409; on a stream the 200 is already
sent, and the `error` event carries the code. The chat route masks the sentence like every other error.

## Why

A run that cannot be continued here would not be continued by the next sweep either, so it is not retried
in a loop: it waits for a person. Before this code existed its follower read the earlier execution's events
and then an end with no answer — a 200 that looked like a model with nothing to say, while the reason sat in
a server log (measured on the authenticated chat route, release check d25 U6). The run itself did not fail,
so nothing is written to its log: the error is the follower's reading of a parked run, and an operator can
still continue it.

## What to do

1. Find the reason in the server log line above (or in `DetachedRuns.pending()`, which lists the run with
   the reason it was parked with).
2. Fix the cause: deploy the agent the run names, restore the store's access, or decide about the recorded
   input.
3. Continue the run from its recorded input, as its owner or as staff — for example `gnl resume <runId>
   --agent <name>` — or, if the work should not happen, cancel it.

Sending the same request again does not move it; it reads the same parked run.
