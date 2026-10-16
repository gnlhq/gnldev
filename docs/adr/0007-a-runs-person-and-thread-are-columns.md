# ADR-0007: A run's person and thread are columns its own write fills; one model names what goes with what

- **Status:** Accepted, 2026-10-08; implemented (CHANGELOG, Unreleased: relation columns, the dependents model)
- **Builds on:** ADR-0001 (end-user isolation), ADR-0005 (the request is the unit), ADR-0006 (a new thread reads no other run)
- **Note:** the Redis store was removed later (CHANGELOG, Unreleased); the Redis consequence below is history.

## Context

A run's person, thread and status lived only inside its `:input` and `:outcome` records (TEXT). Every
question asked by person or thread walked the store. Measured on real Postgres 16 (medians, 5–9 reps):

| | 10k | 100k | 1M |
|---|---|---|---|
| my runs (6-run person) | 150 ms | 1.5 s | 15.8 s (5001 queries) |
| eraseSubject (~500 runs) | 4.6 s | 10.8 s | 87.5 s (325k queries) |
| approvals / org usage / thread delete with runs | – | 1.65 s / 1.64 s / 1.67 s | 14.4 s / 15.3 s / 18.7 s |

The subject index of 0.10.x (`subj:<person>:…`, written by the engine) made erasure flat but not
complete: a run written by an older process, or by a writer the engine does not own (another package's
owner record), is not in the index and survives erasure (S1, S5 on main @8905dbb2).

Independently, "what goes with what" had no single owner: `deleteThread` ×3 copies (no transaction),
`adoptIntoOrg` ×4, `resthr` parsing ×3, `threadIdOf*` ×4. Four sibling scenarios failed on all four
stores (a deleted thread's runs survive; a half-failed erasure reports success; an adopted thread
escapes erasure on InMemory).

## Candidates and measurements (1M, real Postgres)

| | today | KV index keys (B) | **columns, NULL = unplaced (C)** | generic relation table (E) | FK + CASCADE (D) | full relational (R) | hybrid document (H) |
|---|---|---|---|---|---|---|---|
| my runs tiny / heavy | 15.8 s / 1.7 s | 3.1 / 27.5 ms | **0.5 / 4.1 ms** | 260 / 111 ms | – | not measured | not measured |
| eraseSubject | 87.5 s | 5.8 s | **4.5 s** | 6.3 s | leaves 3444 rows + 840 messages | – | – |
| org usage / approvals | 15.3 / 14.4 s | 15.9 s / 113 ms | **2 / 73 ms** | 1.8 / 77 ms | – | – | – |
| queries per message | 94 | 99 | 96 | 103 | – | – | – |
| old process writes after upgrade (S1–S5) | 5/5 | **2/5** | **5/5** | 5/5 | FK refuses BasicMemory runs | trigger bridge, untested | trigger bridge, untested |
| pg-mem | ✓ | ✓ | ✓ | 12 red | – | FK/DEFERRABLE unsupported | – |
| files touched (PG) | – | 8 | 10 | 10 | – | ~15–25k lines, 2 releases | ~20 files |

Five from-scratch designs (relational/DDD, event-sourced, document-per-run, ownership-first, port-first)
converged on the same four points — person/thread as columns, one dependents definition, one owner
source, read the unplaced row — and all named C as the first step. R and H were not measured: their
rolling-deploy story rests on a database trigger that pg-mem cannot run and that moves the exactly-once
claim to a new table during the bridge release.

## Decision

1. `gnl_runs.resource_id`, `gnl_runs.thread_id` (Sqlite the same), `gnl_run_journal.owner` for thread
   owner records. The **adapter** fills them inside the same transaction as `put`/`putIfAbsent`, from one
   pure function (`runRelationsOf`, `ownerColumnOf` in journal.ts). The engine writes no relation index;
   `subj:` is removed.
2. NULL means *unplaced* (written before, or by an older process). Every lookup is `UNION ALL` of the
   placed range and the unplaced range (Merge Append; statistics-independent) and the record decides.
   `placeExisting()` fills old rows for speed; correctness never depends on it.
3. One status column replaces `suspended/failed/running/canceled`; partial index `gnl_runs_open`
   serves approvals and strict usage.
4. One model (`model.ts`) names each entity's dependents (what a run, a thread, a person, a scope own)
   and derives relations. `deleteThread`, `purgeThread`, `purgeRun`, `eraseSubject`, `adoptIntoOrg` run
   plans produced from it through one executor. The thread owner record is the single owner source.
5. Indexes: `(resource_id, created_at, run_id) WHERE resource_id IS NOT NULL`, the same for `thread_id`,
   `(created_at, run_id) WHERE resource_id IS NULL`, `gnl_runs_open`; created `CONCURRENTLY` by an
   upgrade step outside a transaction (`migrateSchema` learns to add an index to an existing table).
6. A conformance package `@gnldev/durable/testing` runs the sibling scenarios against any `Journal`; a
   custom KV journal keeps the base contract and states its guarantee ("complete if every writer is
   ≥ this version, otherwise a walk").

## Preconditions (measured before merge)

- Hot row: `touchRunDelta` updates the indexed `gnl_runs.updated_at` on every journal write (no HOT update, a dead tuple and an index entry per step, 12–200 sub-agents queued on one row). The counters and timestamp move to a narrow table or the index goes; measured by `n_tup_hot_upd/n_tup_upd` and step p95 under 200 parallel sub-agents.
- FK `gnl_run_journal.run_id → gnl_runs ON DELETE CASCADE` (Postgres/Sqlite only, never part of the port) is added `NOT VALID` + `VALIDATE` with an index on `run_id`, and kept only if step p95 under 200 parallel sub-agents stays within 10 % of the FK-less run.

- Mixed writers: main @8905dbb2 and this version resume the same run concurrently on real Postgres
  and multi-process Sqlite, ≥1000 runs: every tool runs exactly once; the loser of `putIfAbsent` writes
  no column.
- Write cost: four new indexes raise per-step write cost ≤10 %. Refuted by step p95 >20 % over main
  under 200 parallel sub-agents, or index size growing >2× the journal → hot counters move to a narrow
  `gnl_run_stats` table.
- Conformance: four stores and a custom KV journal pass the same scenarios.

## Consequences

- **Breaking (0.x):** a thread delete takes its runs; `getOrgUsage` strict `runs` = counter + open runs;
  the `subj:` index and the `subject-index` upgrade step go; status is one column.
- A `.catch(() => ({ items: [] }))` on the erasure path (retention.ts:542) is removed: a failed listing
  fails the erasure.
- Redis: no row an older writer must create, so the unplaced range does not exist there. Until a
  watermark/placed-set scheme is measured — or Redis is dropped as a durable store — erasure on Redis
  keeps the full walk and its guarantee is stated as lower.

## What did not change

Who owns a thread (owner record, first write wins). The `Journal` port and `putIfAbsent` semantics.
`:input` stays the source of truth. Organizations stay a key prefix in this round.

## Rejected

- **R, full relational with FK + CASCADE:** no read gain over C; the hot-path tables of the comparable durable-execution engines we surveyed carry no FK, and two of them removed one;
  the port changes and a custom journal becomes a slow facade; the bridge release moves the claim
  authority; pg-mem cannot test it. No read gain over C.
- **H, hybrid document:** gains come from the columns, not the document; cross-run claims (`xreq`,
  `xrun`, `xthr`) leave the aggregate and bring back a hand-kept list; `listKeys` routing touches 59 files.
- **B, engine-written index keys:** 2/5 — an index the engine writes does not see an older process.
- **D, FK added to the KV table:** leaves 3444 rows and refuses BasicMemory runs.

## Prediction

A new single-valued run relation touches ≤6 files (journal.ts, run-cursor.ts, storage.ts, 3 adapters).
A third multi-valued relation → re-measure the generic-table candidate.
