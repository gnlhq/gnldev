# thread_runs_in_flight

**HTTP 409 · operator console**

## What happened

You deleted a thread (`DELETE /threads/:id`) while a run on it was still writing — a turn inside the
model, for example, or a step whose tool was running. Nothing was deleted. The answer lists those runs
in `runs`.

## Why the framework refuses

Deleting a thread takes its runs with it: their prompts, tool arguments and answers are the
conversation too. A run that is still executing would write after the delete — its answer into the
thread, which comes back holding the end of the conversation, and its outcome into a run that is gone.
Worse, a step whose claim the delete removed could run its side effect a second time.

A run waiting on an approval is not in flight: it writes nothing until someone answers it, and it goes
with the thread.

## What to do

- Wait for the turn to finish, then send the same `DELETE /threads/:id` again.
- Or cancel the runs listed in `runs` (the run view's cancel, `POST /runs/:id/cancel`), then delete
  again. A cancelled run stops at its next model step, on any worker.
- A run whose worker died stays listed until it is cancelled. Cancel it, then delete the thread.
- In code, `AgentMemory.deleteThread(id, { allowInFlight: true })` (or `purgeThread`'s option) deletes
  anyway, for runs you know are abandoned.
