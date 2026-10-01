# run_target_mismatch

**HTTP 409 · no `resumable`**

## What happened

A `runId` was sent to a different target than the one it was started for: agent `a`'s runId to
agent `b`, workflow `x`'s to workflow `y`, or a workflow's, network's or batch item's runId to an
agent. `detail.startedFor` and `detail.requested` name both, as `{ kind, name }`.

## Why

A run's journal belongs to the target that started it: its model steps, its tool results, its
outcome. Answering a second target from it returned the first target's result under the second
one's name — `/agents/b/run` with agent `a`'s runId answered 200 with `a`'s text, and `b`'s model
never ran. An agent attempt on a workflow's runId proceeded on an empty request instead.

The refusal is given only to a caller who may act on the run. Anyone else meets
[`run_owner_mismatch`](./run_owner_mismatch.md) and learns nothing about the run's target.

A run recorded before targets were recorded (0.9 and earlier) names no target and is not refused.

No `resumable`: what needs fixing is the id itself.

## What to do

**Use a fresh `runId` for each target.** Ids are cheap; two targets sharing one is not.

**If you meant to continue the existing run**, send it to the target in `detail.startedFor` — the
agent route for an agent run, the workflow route for a workflow run, the network for a network run.

**If the collision was accidental**, look at how the id is generated. Ids derived from a shared
counter, a request id or a user-supplied string are where two targets end up sharing one. A
`workKey` derives the id from the work and the target together.
