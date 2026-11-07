# @gnldev/upgrade-tests (private)

Opens databases written by an earlier release with the current code, and checks the upgrade
contract on every run instead of leaving it to a reviewer:

- the schema migrates, and a second open (a restart, another process) changes nothing;
- nothing the old release left pending is skipped, and nothing it finished runs again;
- no side effect repeats (a charge, a tool call, a workflow step);
- old data is still reachable through a documented API — or the documented refusal holds, and the
  documented way through works;
- erasure and retention leave nothing behind (or name what they could not reach).

Not published, and not part of the root `pnpm test` (it needs the published older releases and a Postgres to
be complete). CI runs it in full, in the `upgrade-from-0-9-0` job, and a red there stops a release. Run it
with `pnpm test:legacy`.

## Layout

| Path | What |
| --- | --- |
| `fixtures/0.9.0/*.db` | SQLite files exactly as 0.9.0 left them, one per area. |
| `fixtures/0.9.0/postgres-work*.sql` | Postgres dumps (plain SQL) of the queue and events scenarios. |
| `fixtures/0.9.0/notes-*.json` | What 0.9.0 did while writing them (what ran, its cursors, its errors). Tests read these. |
| `generate/0.9.0.mjs` | Writes the fixtures, with the 0.9.0 code. |
| `generate/shapes.mjs` | The workflows, models, documents and ids both sides build: the generator from 0.9.0, the tests from the workspace. |
| `test/from-0.9.0/` | One file per area: queue, events, workflow, scheduler, memory, rag, evals, PII tool results; `work-real-backends` for Postgres. |
| `test/mixed-0.9.0/` | A rolling deploy: a 0.9.0 process (a child, `run-0.9.0.mjs`) and the current code on one file. |
| `fixtures/0.10.0/runs.db`, `postgres-runs.sql` | A store as 0.10.0 left it: runs of every kind (completed, suspended, failed, canceled, one left running, sub-agents, staff, approved), a person erased on 0.10.0, an organization. |
| `fixtures/0.10.0/notes-*.json` | What each call answered on 0.10.0 while writing them, and the side effects in order. |
| `generate/0.10.0.mjs` | Writes the 0.10.0 fixtures, with the 0.10.0 code. |
| `generate/runs.mjs` | The run history and the questions asked of it: the generator writes it with 0.10.0, the tests write it again with the current code and compare every answer. |
| `test/from-0.10.0/` | 0.10.0 → this version (the `run-status` upgrade): opening and listing change nothing; after `gnl upgrade`, and after `--only run-status,schema` alone, every answer equals a store this version wrote with the same history; what a user does next repeats no side effect. |
| `fixtures/0.16.0/queue*.db`, `postgres-queue*.sql`, `mysql-queue*.sql`, `mongo-queue*.ejson` | A queue as 0.16.0 left it, on each backend: every job in the one `qjob` log, the first few run by a 0.16.0 worker (one dead-lettered); `queue-many` also has 0.16.0's `qcursor`. MongoDB's is canonical Extended JSON (per collection a line with its index specs, then its documents sorted by `_id`), not a `mongodump` archive, which is not byte-for-byte reproducible. |
| `fixtures/0.16.0/notes-*.json` | What 0.16.0's writer printed: ids, names, what ran, what finished, the dead letter, `qcursor`. |
| `fixtures/0.16.0/runs.db`, `postgres-runs.sql` | A store as 0.16.0 left it outside the queue: a completed run (with a thread's messages), two runs stopped inside a tool (one whose tool declares `recover()`, one whose does not), a run waiting for an approval. The process is left as a crash leaves it: not closed, claims held. |
| `fixtures/0.16.0/notes-runs-*.json` | What each call answered on 0.16.0 while writing them, and the tool bodies that ran, in order. |
| `generate/0.16.0-runs.mjs`, `generate/crash-runs.mjs` | Write those with the published 0.16.0 and the fixed clock; `crash-runs.mjs` holds the agents and tools, which the tests build again with the current code. |
| `test/from-0.16.0/` | R1 to R8: opening changes no record; the completed run reads and runs nothing again; `pendingWork` names the calls in doubt; the crash ladder (`recover()`, then a person) runs no tool blindly; the approval waits and runs once; no record is lost; a process that merely starts takes the dead one's runs over by itself. |
| `generate/load-0.16.0.mjs` | Installs the published 0.16.0 (`@gnldev/durable`, `@gnldev/queue`, `pg`) outside the workspace: `GNL_016_ROOT` for the queue's deploy window, which runs 0.16.0's worker and producer beside this version's. |
| `generate/0.16.0.mjs` | Writes the 0.16.0 fixtures by running the queue's own 0.16.0 writer (`packages/queue/test/fixtures/k5-q016-writer.mjs`) with the fixed clock. Read by `packages/queue/test/k5-queue-upgrade.test.ts` (the `queue/lanes` and `queue/lanes-cleanup` steps), which runs in the root `pnpm test`. |

## Run

```sh
pnpm -r build
pnpm test:legacy                      # SQLite fixtures; the real-backend and mixed files skip themselves

# + Postgres (the variable the other real-backend tests use; the URL must allow CREATE DATABASE)
GNL_INTEGRATION=1 GNL_PG_URL=postgres://postgres:postgres@localhost:5432/postgres pnpm test:legacy

# + the rolling-deploy tests, which need the 0.9.0 code
node packages/upgrade-tests/generate/load-0.9.0.mjs /tmp/gnl-090    # npm install of the published 0.9.0, ~8 s
GNL_090_ROOT=/tmp/gnl-090 pnpm test:legacy

# + the queue's deploy window: 0.16.0's worker and producer beside this version's (the test lives in the queue package)
node packages/upgrade-tests/generate/load-0.16.0.mjs /tmp/gnl-016   # ~6 s
GNL_016_ROOT=/tmp/gnl-016 GNL_INTEGRATION=1 GNL_PG_URL=… pnpm exec vitest run packages/queue/test/k5-queue-upgrade.test.ts packages/queue/test/upgrade-due-notes.test.ts   # ~1 min
```

The 0.9.0 code comes from outside the workspace on purpose. The repository sets
`link-workspace-packages=true`, and while the workspace version is 0.9.0, pnpm links even an alias
such as `"gnl-090-durable": "npm:@gnldev/durable@0.9.0"` to the current source (measured: the
lockfile records `version: link:../durable`). A test written that way would compare the current code
with itself.

## Regenerate

Only when a scenario is added or changed: a fixture records what a released version wrote, and that
does not change.

```sh
cd packages/upgrade-tests
node generate/0.9.0.mjs                                  # installs @gnldev/*@0.9.0 from npm into a temp dir
GNL_090_ROOT=/path/to/0.9.0 node generate/0.9.0.mjs      # or a built checkout of the 0.9.0 tag
node generate/0.9.0.mjs --check                          # regenerate into a temp dir and compare: exit 1 on any difference

GNL_PG_URL=postgres://postgres:pw@localhost:5432/postgres GNL_PG_DUMP='docker exec -i <container> pg_dump' \
  node generate/0.9.0.mjs --backend postgres
```

For 0.10.0 (`GNL_0100_ROOT`: a built checkout of the 0.10.0 tag, or an install of the published packages;
without it the generator installs them from npm):

```sh
node generate/0.10.0.mjs                                 # fixtures/0.10.0/runs.db
node generate/0.10.0.mjs --check
GNL_PG_URL=… GNL_PG_DUMP='docker exec -i <container> pg_dump' node generate/0.10.0.mjs --backend postgres [--db <name>]
```

For 0.16.0 (`GNL_016_ROOT`: an install of the published packages; without it the generator installs them from npm):

```sh
node generate/0.16.0.mjs                                 # fixtures/0.16.0/queue.db, queue-many.db
node generate/0.16.0.mjs --check
GNL_PG_URL=… GNL_PG_DUMP='docker exec -i <container> pg_dump' node generate/0.16.0.mjs --backend postgres [--check]
GNL_MYSQL_URL=mysql://root:pw@localhost:3306/mysql GNL_MYSQL_DUMP='docker exec -i <container> mysqldump' node generate/0.16.0.mjs --backend mysql [--check]
GNL_MONGO_URL='mongodb://root:pw@localhost:27017/admin?authSource=admin' node generate/0.16.0.mjs --backend mongo [--check]
```

Every 0.16.0 fixture is reproducible (measured with `--check`). For MongoDB, `generate/deterministic-bson.mjs`
also fixes the driver's ObjectIds and keeps the driver's own clock reads (pool events, handshakes on its
timers) from moving the fixed clock: without it two runs differed by a few milliseconds from one write on.
`k5-queue-upgrade.test.ts` loads the MySQL and MongoDB fixtures when `GNL_MYSQL_URL` / `GNL_MONGO_URL` is set.

For the 0.16.0 runs (`GNL_016_ROOT` must also hold `ai` and `zod`; without it the generator installs them):

```sh
node generate/0.16.0-runs.mjs                            # fixtures/0.16.0/runs.db
node generate/0.16.0-runs.mjs --check
GNL_PG_URL=… GNL_PG_DUMP='docker exec -i <container> pg_dump' node generate/0.16.0-runs.mjs --backend postgres
```

The Sqlite file is reproducible (measured: five regenerations, one hash). The Postgres dump is not, for the
reason below: the journal's claim and outcome times come from the database's own clock. MySQL and MongoDB
fixtures for the runs do not exist.

The 0.10.0 Postgres dump is not byte-for-byte reproducible: 0.10.0's metrics counters read the database's
own clock (`now()`), and the dump's row order is the heap's. The Sqlite file is.

The clock, `Math.random` and `randomUUID` are fixed, and reset before each fixture
(`generate/deterministic.mjs`), so a regeneration writes the same bytes: the SQLite files and the
Postgres dump compare equal under `--check`, from a 0.9.0 checkout and from the npm packages alike.

## A failing test here

Read its name: each one states a promise of the upgrade. A failure means the current code breaks it
for data 0.9.0 wrote. Fix the code, not the fixture. A test that pins what 0.9.0 itself does (in
`test/mixed-0.9.0/`) is not a promise of this release; its comment says so.
