# @gnldev/upgrade-tests (private)

Opens databases written by an earlier release with the current code, and checks the upgrade
contract on every run instead of leaving it to a reviewer:

- the schema migrates, and a second open (a restart, another process) changes nothing;
- nothing the old release left pending is skipped, and nothing it finished runs again;
- no side effect repeats (a charge, a tool call, a workflow step);
- old data is still reachable through a documented API — or the documented refusal holds, and the
  documented way through works;
- erasure and retention leave nothing behind (or name what they could not reach).

Not published, and not part of the root `pnpm test`: it holds known failures that the fixes after it
turn green, so a red root suite still means a new regression. Run it with `pnpm test:legacy`.

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

## Run

```sh
pnpm -r build
pnpm test:legacy                      # SQLite fixtures; the real-backend and mixed files skip themselves

# + Postgres (the variable the other real-backend tests use; the URL must allow CREATE DATABASE)
GNL_INTEGRATION=1 GNL_PG_URL=postgres://postgres:postgres@localhost:5432/postgres pnpm test:legacy

# + the rolling-deploy tests, which need the 0.9.0 code
node packages/upgrade-tests/generate/load-0.9.0.mjs /tmp/gnl-090    # npm install of the published 0.9.0, ~8 s
GNL_090_ROOT=/tmp/gnl-090 pnpm test:legacy
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

The clock, `Math.random` and `randomUUID` are fixed, and reset before each fixture
(`generate/deterministic.mjs`), so a regeneration writes the same bytes: the SQLite files and the
Postgres dump compare equal under `--check`, from a 0.9.0 checkout and from the npm packages alike.

## A failing test here

Read its name: each one states a promise of the upgrade. A failure means the current code breaks it
for data 0.9.0 wrote. Fix the code, not the fixture. A test that pins what 0.9.0 itself does (in
`test/mixed-0.9.0/`) is not a promise of this release; its comment says so.
