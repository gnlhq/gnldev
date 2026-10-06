# ADR-0006: A new thread reads no other run; a run list resumes from its last run

- **Status:** Proposed, 2026-10-06
- **Builds on:** ADR-0001 (end-user isolation), ADR-0005 (the request is the unit).

## Context

Two costs grew with every run a store held. Measured on fix/audit-r7's successor, main @67dbfa8d
(10 keys per run, a mock model, medians of 5–7):

- **A new thread read every run.** The thread gate (`threadOwnerOf`) answers "whose thread is this"
  from the owner record; with no record it walked every `listRuns` page looking for a run on the
  thread. Every new thread has no record, so every new thread's first run walked the store. An
  anonymous thread never gets a record, so the walk was also how its existence was known.

  | new thread's first run | 1 000 runs | 4 000 | 10 000 | 30 000 |
  |---|---|---|---|---|
  | Sqlite | 7 ms | – | 67 ms | 324 ms |
  | Postgres | 72 ms | – | 7.3 s | 70 s |
  | Redis | 614 ms | 9.4 s | – | did not finish in 30 min |

  A run without a thread took 1–16 ms at every size.

- **Walking a run list was quadratic.** Postgres and Sqlite paged with `LIMIT … OFFSET n`: a page at
  offset 15 000 cost 132 ms on Postgres (the plan joined and sorted every row before it), the first
  page 3 ms; 30 000 runs walked page by page took 71 s. Redis had no list of runs at all: every page
  read every key of every run (4 000 runs: one page 119 ms, the walk 9.3 s). Budget, metrics, sweep,
  doctor and the organization views walk the whole list.

- **A walk could skip a run.** A run deleted between two page requests moved every later row back by
  one, so the next page skipped a surviving run — on all four stores.

## Decisions and the measurements behind them

### D1 — how a new thread is known to be new

The same eight scenarios on every store (`thread-gate-siblings.test.ts`): a new thread, an anonymous
thread then a named user, four users racing for an anonymous thread, a thread from 0.6, an anonymous
thread from 0.6, a journal with only the required methods, a new thread among 1000 unrelated runs
(S7: fewer than 10 summaries read), and staff opening a thread.

| Candidate | Scenarios | new thread, Postgres 30k | Redis 4k | Files | Found against it |
|---|---|---|---|---|---|
| today | 7/8 (S7) | 70 s | 9.4 s | – | – |
| read the list in one page | 7/8 (S7) | 338 ms | 127 ms | 1 | still reads every run |
| index runs by thread (column, Redis set) | 8/8 | 15 ms | 11 ms | 7 | an incomplete index lets a stranger own an old thread (toggle: backfill off → `owner: 'mallory'`) |
| an anonymous turn writes an `unknown` owner record | 8/8 | 15 ms | 5.7 ms | 3 | the first named user must compare-and-set it — `putIfMatch` is optional on `Journal`, so a journal without it never speeds up; a record deleted while runs remain reads as a new thread |
| **an anonymous turn writes a `seen` marker** | **8/8** | **15 ms** | **5.4 ms** | 5 | an older process writing after the upgrade (below) |

Chosen: the marker. The owner record keeps its meaning and is only ever written first-write-wins
(`putIfAbsent`), as before; nothing new is asked of a custom journal. A store is marked complete
(`thread:records:v1`) when it has no runs at first contact, or by `upgradeThreadRecords(journal)`;
until then the gate keeps the walk, so correctness never depends on running the upgrade.

### D2 — how a run list resumes

| Candidate | Postgres walk 1k / 10k / 30k | Notes |
|---|---|---|
| today (`OFFSET`) | 47 ms / 7.6 s / 71 s | quadratic |
| `OFFSET` on `gnl_runs` only, join the page | 22 ms / 0.78 s / 5.3 s | still quadratic |
| keyset, written out (`created_at >= a AND (created_at > a OR run_id > b)`) | 10k: 1.3 s before `ANALYZE`, 0.15 s after | plan depends on statistics |
| keyset, `OR` form | 10k: 2.2 s / 0.38 s | worse |
| **keyset, row comparison `(created_at, run_id) > (a, b)`** | **14 ms / 142 ms / 432 ms** | linear; the same either side of `ANALYZE` |

Chosen: the row comparison, on the existing `(created_at, run_id)` index — no schema change. The
cursor names the last run handed out (`r1:` in `run-cursor.ts`), never a row number. pg-mem cannot
parse a row comparison: the contract tests stop after their first page there (`rowValues: false`), and
`run-cursor-parity.test.ts` walks every filter, both orders and the insert/delete case on a real
Postgres in the real-backend CI job.

### D3 — how Redis lists runs

| Candidate | page of 50, 4k | walk 4k / 30k | rebuild 30k | State kept |
|---|---|---|---|---|
| today | 119 ms | 9.3 s / – | – | none |
| per-run summary hash + order | 2.4 ms | 0.21 s / 1.47 s | 6.1 s | counts, suspended set, order; 12 more non-null assertions |
| **run order only (a sorted set of runs)** | **2.2 ms** | **0.21 s / 1.46 s** | **2.3 s** | the order; added with `ZADD NX` in the write's own atomic unit |

Chosen: the run order. A page takes its runs from the order (placed by the cursor's run with `ZRANK`)
and summarizes only those runs, with the same code the full read uses; its answers equal the full
read's and Sqlite's for every filter, page size and both orders (`redis-run-order-parity.test.ts`).
A store an earlier version wrote stays on the full read until `rebuildKeyIndex()`, as in 0.10.

## Consequences

- **Breaking (0.x):** a run list's cursor is opaque and names a run. A numeric cursor from 0.10 is
  refused with a `TypeError` (a 400 from the server and Studio) instead of being read as a row
  number. A Studio list open across the upgrade needs one reload.
- `ListQuery.order: 'asc' | 'desc'` (Studio lists newest first without counting rows).
- New: `upgradeThreadRecords(journal)`, `threadSeenKey`, `THREAD_RECORDS_KEY`, `isRunCursor`.
  `rebuildKeyIndex()` also fills Redis's run order.
- Fixed on the way: the skip after a delete (all stores); Redis listed a run adopted into an
  organization twice (under both ids).

## What did not change

Who may reach a thread. The owner record decides, written first-write-wins, as before; a stranger is
refused on every store (scenarios S1–S10).

## Known limits

- **An older process writing after the upgrade** (a rolling deploy, the same rule as 0.10's key
  index): its anonymous turn writes no marker, so the gate reads that thread as new. Tested (S9, S10):
  a named user's thread stays theirs (0.10 writes the owner record), and the first named user claims
  an anonymous one, as before. One difference: staff opening such a thread claims it closed, where 0.10
  let staff pass and left it open to the first named user — stricter, never wider.
- A rare filter (an agent or a person with few runs) can still read far through a list to fill one
  page.
- Array readers (InMemory, a custom journal) place a cursor whose run and next run were both purged
  by count.

## Evidence

- `thread-gate-siblings.test.ts`: S1–S10 on memory, Sqlite, Postgres (pg-mem), Redis (fake; real in
  the real-backend job).
- `run-cursor-parity.test.ts`: every filter, page sizes 1/7/50, both orders, insert/delete between
  pages, a purged cursor, an organization's view — InMemory, Sqlite, Redis, real Postgres. On main the
  insert/delete and purged-cursor cases fail on every store.
- `redis-run-order-parity.test.ts`: in order = full read = Sqlite. Toggles: no reverse for `desc` → 2
  red; cursor placed on its own run → 3 red.

## Prediction

A new way to start a run on a thread (a door, a workflow step) keeps the gate's cost constant by
calling `admitThreadRun` — 0 files in thread-owner.ts. A new run-list filter is one line in
`matchesRunFilter` (run-cursor.ts) and, if it is a column, one condition in the keyset read.
