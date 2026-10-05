# ADR-0005: A sub-agent keeps what the agent keeps — the request is the unit

- **Status:** Accepted, 2026-10-05
- **Builds on:** ADR-0002 (one owner per rule).

## Context

A sub-agent was born through a side door and kept 3 of the 11 guarantees the same agent keeps when run
directly. The requirements are a scenario catalog of 22 cases (payroll, support, SRE, a hospital ward,
filing, logistics), each run directly and through sub-agents. Measured on fix/audit-r7 @7e3c9867:

- work handed to sub-agents ran once per sub-agent: 30 employees, one handed ten times, were paid 40 times;
- one approval answered two sub-agents (their inner call ids were the same);
- limits counted each sub-agent apart, and a sub-agent's own sub-agents never ran;
- a sub-agent's failure reached the parent as prose only.

## Decisions and the measurements behind them

### D1 — how "once" holds across sub-agents

| Candidate | 30 orders, keyless | 30 orders, keyed | email / cancel / retry / fake row |
|---|---|---|---|
| none | 41 (11 extra) | — | ok / ok / ok / shipped |
| item mode (the model selects a row, the engine derives identity) | 30, 0 questions | — | **lost / lost / never / shipped**; work without a trusted read cannot run |
| request window (the identity carries the request) | 30, 10 questions | 30, 0 questions | ok / ok / ok / asked |

Chosen: the request window. Trade: a keyless repeat costs a human question instead of a silent loss. A
refused repeat is not asked about again in the same request (30 keyless orders: 10 questions → 3).

### D2 — where the request's record lives

| Candidate | unwind child | unwind request | purge child | structure |
|---|---|---|---|---|
| under the root run's prefix | undoes nothing | undoes the child's work | output left | — |
| own family `xreq:` + executor signature (`ranBy`) | 1 | 0 (as before) | nothing left | request root in 10 places, `xreq` in 4 files, 2 casts |
| same + one owner (`requestOf`, `runKeys`, typed `delegation`) | 1 | 0 | nothing left | 1 place, 1 file, 0 casts; max CCN 48 vs 50 |

Chosen: the third. Behaviour is identical to the second on every test and probe.

### D3 — a tool-call limit under parallel calls

| Candidate | 12 parallel, limit 5 | step time (5 reps) |
|---|---|---|
| atomic seats | 5 | 24–34 ms |
| serialize (cap 1) | 5 | ~280 ms |
| non-atomic in-flight count | 12 | 24–34 ms |

Chosen: atomic seats. As first built, the seat was a compare-and-set with 20 retries, given back after the
call was counted: with the limit a million away it refused all but 22 of 200 parallel calls, and with
limit 2 a call asked for while another was being counted was refused (1 ran). Found when measuring
Postgres and Redis, after this decision was first recorded. The seat is now one atomic `incrBy` on the
request's total, which returns the seats and the finished calls together, and a finished call gives its
seat back in the step that counts it: 200 of 200 run with the limit far away, exactly 50 with limit 50,
on memory, Sqlite, Postgres and Redis.

### D4 — where the request's spend is kept

Summing every sub-run on each check made a limited fan-out 3.4× slower on Sqlite (profile: the sum 41%,
statement preparation 36%). The spend is kept at the request root, and the Sqlite adapter caches prepared
statements. Measured against 0.9's engine with every call run (15 runs on Sqlite, 10 on Postgres):

| 200 sub-agents | Sqlite | Postgres |
|---|---|---|
| no limits | 308.6 → 157.5 ms | 1726 → 1718 ms |
| with limits | 408.2 → 238.2 ms | 2299 → 2668 ms |

The numbers first recorded here (411 → 226 ms; 2000 sub-agents 4.4 → 2.4 s) were measured while the seat
refused most calls, and are withdrawn. On Postgres a request with limits now does more: its sub-agents'
calls are counted in it (27 289 → 29 870 queries for 200 sub-agents). Two reads were cut on the way: a
child registers with its parent only when the request keeps no total (200 children on one key cost 978
reads and 587 compare-and-set writes), and that a total exists is read once per request (32 429 →
29 870).

## Consequences (breaking, 0.x)

- `sideEffectDuplicates` and `taintedSideEffects` default to `'suspend'`.
- A tool with `idempotencyKey` must declare `idempotencyWindow`.
- A sub-agent's question is addressed `<delegation call>/<child call>` and names the sub-agent.
- A delegation returns `{ status, text, interrupts, failed? }`.
- Keyed and args run-window records move to `xreq:<request>:args-…`. Records an earlier version wrote are
  carried over on resume.

## Evidence

- Suite 8666 passed; legacy 109 passed (8 skipped, real Postgres and Redis); gates green.
- Seats under load (`a-seat-under-load`): 200 parallel calls on memory, Sqlite, Postgres and Redis.
- Catalog and siblings 49/49, kept as permanent tests (`a-sub-agent-scenario-catalog` asserts no FAIL row).
- 15 disable-and-measure toggles; 2 unproven changes were removed.
- Cycles 87 → 87 (none new); duplication 0.29% → 0.25%.
- Extension test: a developer's own sub-agent built with `runDurable` gets "once" with no engine change
  (before: 2 shipments, after: 1).

## Prediction

A new way to start a child run (a door, a workflow step, a host's own) gets the request window, limits
and addressing by passing the parent's identity — 0 files in durable-tool, limits or journal. A new limit
kind is classified in one table (server `LIMIT_MERGE`) and read through `requestOf` — at most 2 files.

## Not covered

- Postgres with limits is slower than 0.9 (above, +16%); the rest is the request's own bookkeeping.
- Redis lists by `SCAN MATCH` over the whole keyspace, so unrelated keys slow a run (151 000 keys: 20
  sub-agents 77 ms → 1.7 s); pre-existing, not addressed here.
- More than 2000 children; the InMemory adapter is quadratic at large fan-out (pre-existing).
- The network router reads a step's status, not a structured result.
- Tokens can still overshoot by one step per concurrent run.
