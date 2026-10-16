# ADR-0008: A run executes apart from its caller; a live process holds what it executes

- **Status:** Accepted, 2026-10-12
- **Builds on:** ADR-0001 (end-user isolation), ADR-0005 (the request is the unit), ADR-0006.

## Context

In 0.10 a run lived inside the HTTP request that started it: `await gnl.run(...)` in the request,
its tools in the same process. Three things followed.

- **A retried request could run the work twice.** A request that timed out at a proxy was sent again,
  reached another process, and both executed the same run, racing on the same tool calls. The per-run
  lock (`lock: { ttlMs }`, heartbeat-renewed) answered `409 run_busy` to a *concurrent* duplicate, but
  its truth was a clock: a process frozen past the TTL lost the lock while it was still running.
- **Leaving stopped the work.** The request's signal was wired into the run: a closed tab or a dropped
  connection aborted the answer half-way, and long tool work could not outlive the request.
- **Nothing outside the request could read the run while it ran.** A reconnect replayed the journal
  from the start; another process could not follow a run it did not execute.

The product requirement (binding, from the owner): the experience of a chat assistant — the answer
streams live on the same connection; closing the tab does not stop the work; reopening shows what was
produced so far and continues live; long work (writing files, deep research) goes on in the background
with a short status. "Everything in the background, the result later" is not acceptable. And
`@gnldev/durable` alone must provide this — a separate worker process is optional, never required.

The promises that may not weaken: exactly once, ownership, erasure completeness, organization isolation.

## Decision

**One execution model (called C during design): a run executes on its process's executor, apart from
the call that started it, and a live process holds what it executes.** There is no in-request path and
no option to choose one; a draft `detached` option was removed before release.

### D1 — whose run it is: the engine's admission, once

The executor keeps no ownership rule of its own. Before it executes, takes over, resumes or attaches,
it asks the engine's admission (`admitAgentRun`, the same block `runDurable` and `streamDurable` run):
owner, target, thread, actor, recorded input. A new run is born there, first writer wins, so a second
caller racing for an unborn id loses before any execution record exists. The execution record
(`__exec__:<scope>/<runId>#`) names a process, never a person.

### D2 — stopping: cancel is durable; a disconnect is not a cancel

`abortSignal` cancels the run (`cancelAgentRun`), in whichever process executes it, at its next step or
tool boundary. Doors no longer pass a request's signal to the run: a disconnect ends the reading only.
`lock` is removed from registry runs and the chat door: a second call for a run in flight attaches to
the same execution.

### D3 — erasure: one fenced writer

Everything written under a run (events, outcome, execution record, delivery marks) goes through one
writer that reads the erasure fence before it appends (at most every 250 ms) and before the end, and
settles once more after the run's stream has quiesced. The execution record is in the erasure model
(`RUN_DEPENDENTS.platformKeys`, `ORGANIZATION_DEPENDENTS.platformPrefix`). An erased run id is never
reborn.

### D4 — one executor per process per store

`executorFor(store)`; organization registries register their scope. A store's `close()` stops its
executor after its runs settle.

### D5 — one path

The executor runs the stream path only. `gnl.run()` is a follow to the end, its result read from the
event log. A model step recorded by either path is read by the other (`settleModelContent`), so runs
journaled by 0.10's generate path continue. A model with no `doStream` is streamed from its generate
answer; a model that has one is always streamed.

### D6 — the event log is ours and versioned

`<runId>:ev:<seq>`, schema v1 (`encodePart` / `decodeEvent`), translated to the AI SDK's parts in one
place. A reader's cursor is `seq`, or `seq.offset` mid-segment; it is the SSE `id:` and `Last-Event-ID`.
`gnl.follow(runId, { after })` and `GET /runs/:id/events` read a run from any process.

### Event layout: a segment a second, live deltas in memory (measured)

The store gets a run's text in segments of about one second (`coalesceMs`); a reader in the executing
process gets each delta from memory as it is produced (~25 ms cadence); a reader elsewhere reads an
index range (`Journal.readRange`).

### Process liveness, per store

What a process holds while it lives — a Postgres session advisory lock (63-bit, try-lock), a Sqlite
file lock — and what another process asks before it takes over a run, a tool call or a queue job. A
frozen process keeps what it holds; a dead one holds nothing from the moment it is gone. Each store
answers with its own liveness (`storeLiveness`): a stamp written into a store is judged by that store's
liveness. A store other processes reach with no liveness is refused (`LivenessRequiredError`), never
given an in-memory one.

### The queue: the same liveness, an embedded worker

`@gnldev/queue` leases are judged by the holder's liveness, not their age. `createQueue(storage,
handlers)` starts a worker in the enqueueing process (`worker: false` to run workers elsewhere), and a
job waiting 10 s with no worker on its store is reported once per type.

### Background tools

`gnlTool(t, { background: true })`: the model is answered at once (`{ status: 'started', taskId }`) and
the turn goes on. The body runs as its own run (`task:<runId>:<toolCallId>`) under the engine's claim
and crash ladder; when it ends, its result is written to the thread once and the agent is woken once by
a continuation run (`cont:<runId>:<toolCallId>`) that takes the thread's turn (compare-and-set) before
it writes. Both are the parent's owner's, in its organization, stopped by its parent's erasure fence
(`ErasureBaseline.lineage`) and deleted with it. Waiting is the default; `awaited` is not a mode.

### Shutdown and upgrade

`drainProcess()` / `drainOnSignal()`: on SIGTERM a new run gets `503 draining`, a running tool finishes
and is recorded, no new step starts, the queue and the scheduler take nothing new, then the process
exits and another continues. Nothing is written to the store. Templates set pm2 `kill_timeout` 30 s
above the 25 s drain. `gnl pending` lists what the store holds in three groups — calls in doubt and
running work block a shutdown or an upgrade, runs awaiting approval do not; `gnl upgrade` refuses while
something blocks. A call's idempotency key is decided once, written into its claim, and read back by
every retry, `recover()`, `lookup()` and `compensateRun`.

### A failure that may still be revised is not declared

When a call reaches its retry ceiling and its last attempts never reported, and the tool can still tell
(`recover()`, or `idempotent: true`), the run is not `failed`: it is `waiting-outcome`
(`OutcomeUnknownError`, `outcome_unknown`, 409). The call's recorded result is the one thing that
continues it, whoever writes it: the late attempt itself (over a later attempt's claim only when that
one is gone, never over a live one), `recover()` asked again by the sweep (doubling from 2 s, at most
12 times), or an operator in `gnl pending`. A late result that finds the call settled is kept as
evidence. No timer decides an outcome. A queue job in the same state is `in-doubt`, not `failed`.

## The promise, as measured

> A side effect runs **exactly once** where the tool's provider accepts the call's idempotency key.
> Where it does not, it runs **at most the retry ceiling** — a tool's `maxRetries` (3 by default), a
> queue job's `maxAttempts` (5) — and **2** on a single network partition. A process that is only
> frozen, its session alive, is never taken over.

Measured with real processes on Postgres (SIGSTOP plus `pg_terminate_backend` on every session of the
frozen process, then SIGCONT), 20 trials per scenario, 0 invalid trials; falsification conditions
written before the runs:

| Scenario | Raw effects | Keys seen |
|---|---|---|
| Tool with `recover()` or `idempotent`, one partition | 2 ×20 | 1 ×20 |
| Queue job, one partition | 2 ×20 | 1 ×20 |
| Background task with `recover()`, one partition | 2 ×20 (result 1, wake 1) | 1 ×20 |
| Tool, partitions in a row | 3 ×20 (ceiling) | 1 ×20 |
| Queue job, partitions in a row | 5 ×20 (ceiling) | 1 ×20 |
| Tool with only `sideEffect` | 1 ×20, waits for a person | 1 |
| Frozen only, session alive (Postgres and Sqlite, 140 trials) | 1, no takeover | 1 |

Takeover happens only once the session is gone; a real partition reaches that after the server's
keepalive (~25 s). The measurement cut it at once — the worst case.

## Alternatives rejected, and why

| Alternative | Why not |
|---|---|
| Keep the run in the request (0.10) | A retried request ran the work twice; a disconnect stopped it; nothing could follow it from elsewhere. Fails the product requirement. |
| Everything in the background, result later (a queue in front of every run) | Fails the binding UX requirement (the answer must stream on the same connection) and makes a worker process mandatory. |
| Both models, chosen per call (`detached` option) | Two execution paths, two sets of rules for ownership, erasure and replay. Removed before release. |
| Ownership by a TTL lock with a heartbeat | Its truth is a clock. Measured on the queue with real SIGSTOP: a worker frozen past its lease saw its job run a second time beside it (effect 2 on Sqlite and Postgres); with liveness, 1. A dead worker's job was taken over after the TTL (30 s); with liveness, ~1 s. |
| In-memory liveness as a fallback | Every other process reads as dead: a second process's sweep took a live run over and executed it beside its owner (T1, measured). Refused instead. |
| One liveness per process | Postgres scopes advisory locks to a database: a process on two databases (a database per tenant) had its live claim in the second taken over (1 execution beside the holder, measured). Per store now: 0. |
| A caller hash on the execution record for ownership | A second ownership rule beside the engine's; the design review counted 12 special cases in the attempt. D1 asks the engine. |
| Event layout a1: a segment per delta (~30 ms) | 123–355 KB of write-ahead log per run for the event log (threshold 50 KB); run/s down to 0.93× at 200 concurrent runs. |
| Event layout b: one buffer row rewritten | Fine at 10 s (22–25 KB), quadratic at 30 s (93–136 KB): every write rewrites the whole text. |
| Keep the streaming step's periodic checkpoint | Nothing read it; it was 71–94% of a streamed run's write-ahead log (416 KB per 30 s answer). Removed. |
| Listing keys to follow a run | A follower of a 30 s answer listed 54 243 keys per run; an index range lists none. |
| At the retry ceiling, wait 30 s before declaring failure | A timer as the truth: a holder frozen longer still ended `failed` although its effect landed; 1 of 40 `idempotent` trials still failed; the queue was not covered. Replaced by the recorded result as the only thing that settles a call (60 s freeze: 5/5 completed). |
| Fall back from a failing `doStream` to `doGenerate` | Cannot tell a test double's "not implemented" from a provider's error without reading the message; on a real provider it would send (and bill) the request twice. A test double gets a `doStream` instead (CHANGELOG, Breaking). |
| Two releases (a 0.10.x with fixes, then the model) | The owner's decision: one release; a problem found later is rolled back, not pre-empted by a smaller release. |
| Background tools in a later release | The owner's decision: build the better design now rather than a restricted one to be removed later. |

## Consequences

- Breaking for hosts (CHANGELOG, Breaking and "Upgrading from 0.10"): `lock` removed; `abortSignal`
  cancels the run; a disconnect does not; `gnl.stream()` returns a followed run; SSE ids are event-log
  positions; a store other processes reach needs a liveness; a mock model needs a `doStream`;
  `waiting-outcome` / `in-doubt` where `failed` was; `drain()` drains the process.
- One more Postgres connection per store while its liveness is open.
- A live but stuck process keeps its runs and jobs until it is killed: liveness, not age, is the rule.
- The first token reaches a reader through the executor: +110–150 ms at 50 concurrent runs,
  ~+450 ms at 200, against the in-request baseline (measured, Postgres).

## Proof that the promises held

Red before, green after, with real processes where it matters:

- Ownership: a caller naming another's live run gets 404 and none of its text (Sqlite, Postgres,
  real processes); a stranger answering a background task's approval gets 404.
- Exactly once: concurrent same-run calls attach (one charge); SIGKILL at four points of a background
  task's end, three processes racing: effect 1, result 1, wake 1; SIGKILL while a continuation answers:
  one whole answer.
- Erasure: erasing a person or a run mid-answer or mid-tool from another process leaves no key under
  the run (Sqlite, Postgres); a thread deleted while a turn is written leaves no message (was 2 of 6
  runs on Postgres; the deletion is now one transaction under the thread's lock); a parked run's
  erasure leaves no execution record, call or late evidence.
- Organization isolation: an organization view keeps its organization through `toJournal` (two
  organizations charging one order id handed the provider the same key before).
- Every test that needs a real Postgres runs in CI, found by a rule (77 files; 67 ran nowhere before).

## Predictions this decision makes (to be checked by later history)

- A new kind of long-running work (a new tool kind, a new door) is added without touching the
  executor's ownership or erasure code: ≤ 2 files outside the door itself.
- No future fix adds a second ownership rule beside the engine's admission.
