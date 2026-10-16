# adoption_conflict

**HTTP 409**

`AdoptionConflictError` — thrown by `storage.adoptIntoOrg(orgId)` and so by `gnl adopt-org`. An
operator's migration, not a request: no door answers it today, and 409 is what one would.

## What happened

Adoption moves the root's data into an organization, under `org:<orgId>:…`. The organization already
held entries under some of those ids — the same thread's owner record, the same run id, the same
memory thread, a meta or work-store key, a work-log record id. Adoption refused **before anything
moved**: the store is exactly as it was. `detail.keys` names the colliding organization ids (at most
20, sorted), `detail.count` how many there are, `detail.orgId` the organization.

## Why

Adoption never replaces what the organization holds. The case that decided it is a thread's owner
record: the root's `thread:T:owner` moved onto the organization's made the root's person the owner of
the organization's thread `T` — her messages included — an owner nobody chose. Before this refusal the
stores did not even agree: the in-memory store overwrote silently (measured: `orgUser` replaced by
`rootUser`, an organization's usage total replaced by the root's), Sqlite and Postgres failed on a raw
UNIQUE / `23505` error. Neither copy may silently win, so every store refuses, by name.

Two kinds of entry are not conflicts and are never reported here:

- **counters** (`incrBy`: usage, metrics, a run's counters) are totals — the root's is **added** to
  the organization's, in the same transaction as the move;
- **cache entries** are content-addressed — the organization's is kept and the root's copy dropped.

## What to do

- Look at each id in `detail.keys` (`count` may be larger than the list) and decide which side keeps
  it: delete or rename the other — on the root for data the organization should keep, in the
  organization (through its own view) for data the root should bring. A thread both scopes use is two
  conversations: move the root's to a new id first.
- Run `gnl adopt-org <orgId>` (a preview; or `adoptIntoOrg(orgId, { dryRun: true })`) until it reports
  no conflict — the preview refuses with the same error — then adopt with `--yes`.
- Same thread id, same run id across scopes usually means the root and the organization were written
  by the same clients before the organization existed; stop those writers before adopting.
