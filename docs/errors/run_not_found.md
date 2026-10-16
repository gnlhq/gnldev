# run_not_found

**HTTP 404**

## What happened

The run you named is not one you can reach. Either it does not exist, or it belongs to somebody else —
and this answer does not say which. Nothing was written and nothing ran.

Every door gives these same bytes for both cases: the REST routes (`/agents/:name/run`, `/stream`,
`/resume`, `/runs/:id`, `/runs/:id/events`, `/runs/:id/cancel`, `/workflows/:name/run`,
`/workflows/runs/:id/cancel`), the chat and AG-UI routes and surfaces. The A2A door says the same thing in
its own protocol ("Task not found").

```json
{ "error": "run not found", "code": "run_not_found" }
```

## Why

Two answers would be an existence oracle. Before this code, a stranger naming another user's run on
`POST /agents/:name/run` got **403** ("belongs to a different resourceId"), while naming an id nobody
had made got **409** `run_owner_mismatch` ("there is no such run for this caller"). The difference
told them which ids were real.

The same reasoning covers the ids only the engine begins — `task:`, `cont:`, `agent:`, `wf:`, `net:`
(a background call, its continuation, a sub-agent, a workflow tool, a network step). No door can start
one, so an absent one is answered as a foreign one, before any other gate. That includes the budget
gate: an over-budget organization used to answer the absent id 402 and the existing one 403.

The engine's own refusals of this kind — `run_owner_mismatch` and `run_actor_mismatch` — reach a door
as this answer too (`callerConflictAnswer` in `@gnldev/durable`).

## What to do

- **Check the id.** A run id you were given back (`X-Gnl-Run-Id`, a task id) is spelled exactly; a
  run id you made up must be one you started.
- **Check who you are calling as.** A run belongs to the user it was started for. An application
  credential names the user in the request (`resourceId`); naming a different user than the run's
  owner gets this answer.
- **To start a new run**, send an id of your own spelling (or a `workKey`). An absent id that is not
  engine-begun is yours to start — that request runs, it does not get this answer.

**Staff** (an operator credential) list every run in their organization, so there is nothing for this
answer to hide from them: staff naming a user on a run that exists and belongs to someone else still
get `403` ("belongs to a different resourceId").

## See also

- [`run_owner_mismatch`](./run_owner_mismatch.md) and [`run_actor_mismatch`](./run_actor_mismatch.md) —
  the engine's codes for the same refusal, as an embedded caller sees them.
- [`thread_owner_mismatch`](./thread_owner_mismatch.md) — a conversation, not a run, keeps its own answer.
