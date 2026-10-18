# ADR-0009: A store states its guarantees, and is measured against them

- **Status:** Accepted, 2026-10-18
- **Builds on:** ADR-0007 (a run's person and thread are columns), ADR-0008 (a run executes apart from its caller).

## Context

Every promise gnl makes about a run — once, owned, erased, truthfully reported — rests on a few store operations being atomic: compare-and-set, claim, an all-or-nothing batch, a counter, a shared clock. None of them is in the typed store contract. The run store port requires six methods; the guarantees are forwarded "if present" and the engine branches on their presence at ~190 sites, falling back to a non-atomic path when one is missing.

Measured on 0.11.1 (raporlar/2026-10-18-db-mod2, -mod3):
- A store with none of the guarantees type-checks, is accepted by `createGnl`, and passes 20 of the 21 exported conformance scenarios. On it, 20 workers taking over one expired run lock all won, in 10 of 10 rounds (1 with the guarantee).
- The fallbacks hide defects: studio's hand-written reader forwards none of the guarantees, so its replay and fork writes take the non-atomic path even on Postgres; and on Postgres a stale `failed` verdict written after a success wins, because the verdict is dated by the store's clock at write time.
- Of 8 deliberately broken stores (each breaks one guarantee), the exported kit catches 4.

## Decision

1. **The contract names the guarantees.** The run store requires `putIfAbsent`, `putIfMatch`, `applyBatch`, `incrBy`, `getCounters`, `listKeys`, `deletePrefix`, `now` (a store on one host may declare its host clock). Accelerators stay optional (`getMany`, `readRange`, `listOwnerRecords`, `listRunsChangedSince`).
2. **A store missing a guarantee is refused where it enters**, naming what is missing — not run on a fallback. The fallback branches for guaranteed methods are removed.
3. **One exported conformance kit, derived from the contract**, that any backend is pointed at with one `make()`: a scenario group per guarantee including races and partial batches; run, work, vector, memory, liveness and upgrade stores. A missing guarantee fails a scenario; nothing passes vacuously. Every shipped backend runs it in CI, on real Postgres too.
4. **A verdict from an attempt that no longer holds the run is not written** (the root of the stale-`failed` defect), the same rule as a model step's answer.

## Alternatives measured

- **A — grow the kit only.** Catches 8/8 broken stores, small (5 files), breaks nobody — but the engine still accepts a store that skips the kit (20 winners/round), and the fallbacks stay.
- **B — contract first.** Refuses the store with no guarantees, removes ~80 fallback branches (197→117), catches 7/8 (clock skew needs a declared reference clock), surfaced the studio and verdict defects. Breaks any custom store missing a guarantee.
- **Chosen: C = B + A's extra kit coverage** (declared host clock, liveness/memory/upgrade kits, partial-batch failure).

Neither design can make the engine verify atomicity: a non-atomic `putIfMatch` still lets 20 workers win in both. Only the kit's race scenarios catch it — which is why the kit is part of the decision and not a test detail.

## Consequences

- Breaking: a custom store missing one of the guarantees is refused at construction with the missing names (the documented Map example gains them). No shim. Stated in CHANGELOG. No external users today (maturity: R&D).
- New backends (MySQL/MariaDB, MongoDB, Turso/libSQL) are written against the kit; one is done when it passes it.

## This decision is wrong if

A backend that passes the kit violates once/owned/erased/truthful in a two-process test; or adding the next backend needs a change outside its own files and the kit.

## Prediction (premise ledger)

The next backend is added in ≤ 3 new files plus its kit registration, with 0 changes to engine files.
