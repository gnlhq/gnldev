# @gnldev/scheduler

> Part of [GNL](https://github.com/gnlhq/gnldev), a full agent framework for TypeScript — works with the rest of it, or on its own.

Cron, interval and one-shot triggers for durable workflows. Several workers can poll the same
schedule: a run-lock picks one winner per fire and every write to the trigger's state is CAS-fenced,
so a slot is never double-advanced or rolled back — see [the lock section](#lock-ttl-and-what-once-covers)
for what that does and does not promise about the workflow body.

## Install

> Install: `pnpm add @gnldev/scheduler` — or use it from a [repo clone](https://github.com/gnlhq/gnldev): `pnpm install && pnpm -r build`.

```bash
npm i @gnldev/scheduler
```

## Schedule something

```ts
import { scheduleWorkflow, createScheduler, pollScheduler } from '@gnldev/scheduler';

await scheduleWorkflow(journal, {
  id: 'nightly-invoices',
  cron: '0 3 * * *',
  name: 'invoices',          // the workflow name handed to runner.runWorkflow
});

// in your worker loop. The runner is an object with runWorkflow — createGnl() is one.
setInterval(() => pollScheduler(journal, gnl), 30_000);
```

Give exactly one of `at` (epoch ms), `every` (ms, greater than 0) or `cron` (5 fields, UTC unless you
give `tz` — see [Time zones](#time-zones)). A spec that
could not fire — a cron with hour 25, `every: 0`, two of the three, `0 0 30 2 *` (there is no 30
February) — is refused before anything is written. Whether a cron can fire does not depend on the date
you ask: `0 0 29 2 *` fires on every leap day, four (across 2100, eight) years apart.

Calling `scheduleWorkflow` again with the same spec for the same id is a no-op, so every boot can call
it. A different spec for an id that already exists is refused, naming both, until you say which one you
want:

```ts
import { scheduleWorkflow } from '@gnldev/scheduler';
import { InMemoryJournal } from '@gnldev/durable';
const journal = new InMemoryJournal();

await scheduleWorkflow(journal, { id: 'nightly', name: 'report', cron: '0 4 * * *', ifExists: 'replace' });
```

`'replace'` applies the new spec (next time from it, attempts reset, a fire count no run has used);
`'keep'` leaves the stored trigger as it is; or use a new id. A stored definition that cannot fire (left
by 0.9.0) is replaced by the next valid registration whatever `ifExists` says, and the poller fails it
instead of firing it.

## Time zones

`cron` is read in UTC unless the spec names an IANA zone in `tz`:

```ts
import { scheduleWorkflow } from '@gnldev/scheduler';
import { InMemoryJournal } from '@gnldev/durable';
const journal = new InMemoryJournal();

await scheduleWorkflow(journal, { id: 'berlin-standup', name: 'standup', cron: '0 9 * * 1-5', tz: 'Europe/Berlin' });
```

That is 09:00 in Berlin all year. A UTC cron cannot say it: `0 8 * * *` UTC is 09:00 in Berlin on 155
days of 2026 and 10:00 on the other 210. On the two DST days a year:

- a wall time that does not exist (02:30 when clocks go 02:00 → 03:00) fires once, shifted forward by
  the gap — 03:30. A daily job still runs that day.
- a wall time that happens twice (02:30 when clocks go 03:00 → 02:00) fires once, at the first 02:30 —
  unless the hour field is `*`. Then every real hour is its own occurrence: an hourly cron runs 25 times
  on a 25-hour day.

`tz` is only for `cron` (an `every` period and an `at` instant have no zone) and must be a zone the
runtime knows; anything else is refused before a write. The canonical name is stored, so
`'europe/berlin'` and `'Europe/Berlin'` are the same spec. Zone rules come from Node's own `Intl`.

## Stop, pause, resume

```ts
import { unscheduleWorkflow, pauseTrigger, resumeTrigger } from '@gnldev/scheduler';
import { InMemoryJournal } from '@gnldev/durable';
const journal = new InMemoryJournal();

await pauseTrigger(journal, { id: 'nightly-invoices' });        // kept, not fired
await resumeTrigger(journal, { id: 'nightly-invoices' });       // fires again from the next slot
await unscheduleWorkflow(journal, { id: 'nightly-invoices' });  // gone
await unscheduleWorkflow(journal, { id: 'ayse-weekly', resourceId: 'ayse', orgId: 'acme' }); // an owned one
```

Name the trigger as you scheduled it: the `id` (or the workflow name, if you gave no id) and the same
owner. Each returns `true` when the trigger is in the asked-for state and `false` when there was nothing
to act on (no such trigger; or, for pause and resume, one that is removed, `done` or `failed`).

- **Removing** makes the trigger never fire again and drops it from `listTriggers`. A fire already in
  flight finishes (the run is not aborted), and its result is discarded, so it cannot bring the trigger
  back. Scheduling the id again later is a new trigger, with run ids the old one never used. If your boot
  code registers the trigger, remove that call too, or the next boot schedules it again.
- **Pausing** keeps everything (schedule, fire count, attempts) and shows `status: 'paused'`. The
  boot-time `scheduleWorkflow` call does not lift it, and neither does `ifExists: 'replace'`. A fire in
  flight when you pause is recorded under the pause, so resuming never runs that occurrence again.
- **Resuming does not catch up.** Occurrences that fell inside the pause are not run, whatever `misfire`
  says: the pause was the decision not to run them (`misfire` is for occurrences missed because no
  poller ran). The next fire is the first slot after the resume, on the same grid. A one-shot `at` whose
  time passed during the pause fires once, right away: skipping its only occurrence would delete it.

Each is a single write to the trigger's state, compared against the state it read, so it never
overwrites a fire it did not see.

## Triggers for an end user

A trigger can work for one user in one organization. Each fire's run belongs to that user: they can see
it and approve it.

```ts
import { scheduleWorkflow, createScheduler } from '@gnldev/scheduler';
import { createGnl, scopeConfigToOrg } from '@gnldev/durable';

await scheduleWorkflow(journal, {
  id: 'ayse-weekly', every: 7 * 24 * 3600_000, name: 'weekly-summary',
  resourceId: 'ayse', orgId: 'acme',
});

// Each organization's runner. Cache it; building it per fire is wasteful.
const gnlFor = (orgId: string) => createGnl(scopeConfigToOrg(config, orgId).config);
createScheduler(journal, gnl, { runnerForOrg: gnlFor }).start();
```

- **Each fire runs as the trigger's recorded owner.** The scheduler hands the runner `{ runId, caller }`,
  with `caller` read from the trigger (`user(id, org)`), so the runner has nothing to pass on and
  nothing to forget. `caller: user('ayse', 'acme')` is the same as `resourceId` + `orgId`.
- An operator or system trigger says so: `caller: staff()` (or `staff('acme')`). Leave the owner out
  and the fires run as `unknown`: never staff by omission, never visible to an end user.
- A trigger with an `orgId` never runs on the organization-less runner. Without `runnerForOrg` it fails
  with a clear error (`listTriggers` → `lastError`), because a run written there is invisible to the
  organization.
- A bad `orgId` or an empty `resourceId` is refused by `scheduleWorkflow` itself.
- A trigger id (or the workflow name, when no id is given) is a name **within its owner**. Two users
  scheduling the same workflow get two triggers. `scheduleWorkflow` returns the stored id.
- `budgetGuard` receives `orgId` and `resourceId`, so one scheduler can charge each organization.
- Triggers live in the **root** journal, which the poller reads. `scheduleWorkflow`, `pollScheduler`,
  `listTriggers`, `createScheduler` and `createWorkflowWaker` refuse an organization's journal
  (`withOrg`) or an end user's view — a trigger filed there would never fire. Pass the root journal and
  the trigger's `orgId`.
- Sleeping workflows inside organizations: give the waker their ids. It scans each partition and tells
  `resume` which organization the run is in.
- The waker resumes as staff (`caller: STAFF`). A resume that names nobody is refused on a user's run
  (`RunOwnerMismatchError`), and the waker only logs it, so that workflow never wakes. Staff re-entering a
  run continues it as its recorded owner: a user's workflow stays that user's.

```ts
import { createWorkflowWaker } from '@gnldev/scheduler';
import { STAFF, toJournal } from '@gnldev/durable';
declare const storage: import('@gnldev/durable').Storage;
declare const gnl: { runWorkflow(n: string, i: unknown, o?: { runId?: string; caller?: typeof STAFF }): Promise<unknown> };
declare const gnlFor: (orgId: string) => typeof gnl;

createWorkflowWaker({
  journal: toJournal(storage),
  orgs: ['acme', 'globex'], // or a function, asked on every tick
  resume: async (runId, status, where) => {
    if (!status.workflowName) return; // recorded without its workflow's name: nothing to rebuild it from
    return (where ? gnlFor(where.orgId) : gnl).runWorkflow(status.workflowName, undefined, { runId, caller: STAFF });
  },
}).start();
```

### Upgrading a trigger that already exists

A trigger scheduled before it had an owner keeps its old id. Adding `orgId` (or a user) to the spec
would schedule a second trigger on the next boot, and both would fire. Move it once, before that boot:

```ts
import { moveTrigger, scheduleWorkflow } from '@gnldev/scheduler';
import { InMemoryJournal } from '@gnldev/durable';
const journal = new InMemoryJournal();

await moveTrigger(journal, 'nightly', { orgId: 'acme' });          // once, during the upgrade
await scheduleWorkflow(journal, { name: 'nightly', every: 86_400_000, orgId: 'acme' }); // every boot: a no-op now
```

The owned trigger keeps the old one's next time, attempts and fire count. The old one is retired
(`status: 'done'`, `movedTo` in `listTriggers`).

### Erasing a person

`triggerEraser(journal)` removes one person's triggers: definitions (with their `input`), state,
failure and skip records, and fire locks. Pass it to `eraseSubject` from `@gnldev/durable`, with the
queue's and the events bus's erasers — see [@gnldev/queue](../queue/README.md#erasing-a-person). The
fires' runs carry their owner record, so `eraseSubject` erases them with the person's other runs.

## Lock TTL and what "once" covers

Two workers polling at the same moment do not both fire the trigger: `acquireRunLock` picks one
winner on `<runId>:fire`, and every write to the trigger's state is a CAS against the record that
winner read when the fire began. `fireCount`, `nextRunAt` and `attempts` can therefore only be advanced by the poller that
actually owns the fire — a poller that lost the lock cannot roll them back or resurrect a stale
attempt count. The property comes from the journal rather than from careful timing.

`lockTtlMs` (default **60 s**, on both `pollScheduler` and `createScheduler`) is how long that lock is
held. It is renewed every `lockTtlMs / 3` for as long as the workflow is in flight, so a run that
takes longer than the TTL keeps its lock. That renewal is not cosmetic: the TTL used to be fixed and
never renewed, so *any* workflow running longer than 60 s let its lock expire and a second poller
re-fired the same trigger. Raise `lockTtlMs` if your triggers are long and your journal is slow;
lowering it makes a genuinely dead worker's fire reclaimable sooner.

**A stored trigger that cannot fire is answered on the first poll that sees it.** An invalid definition
(only 0.9.0 could store one) is marked `failed` with the reason, shown as `lastError` in `listTriggers`
and Studio. So is a valid one whose stored `nextRunAt` is not a number (a foreign writer, a hand edit):
it is never fired from there, and calling `scheduleWorkflow` with the same spec — which a host does on
every boot — sets its time from the definition. `onInvalidTime: 'repair'` (on `createScheduler` and
`pollScheduler`; default `'fail'`) sets the time on the poll instead, logs it, and fires at that time.

**Known limit — the fencing covers the state write, not the execution.** A `renew` that fails is
logged and nothing else; `pollScheduler` does not abort the workflow it already started. So if the
lock does expire anyway — a stalled or paused process, a clock jump, a journal outage that outlasts
the TTL — a second poller can take the fire over and call `runner.runWorkflow` with the **same**
`runId` while the first is still inside it. The CAS then discards the loser's state write, so the
schedule stays correct; it does not undo what the loser's workflow did. This is measured, not
theoretical: in `test/scheduler-lock-fence.test.ts` both pollers run `sched:<id>:<fireCount>`.

What keeps that from becoming a duplicated side effect is the run, not the scheduler. Because both
attempts share one `runId`, each workflow step reads its output from the journal first and only the
first writer's result is kept (`claim`), so the two attempts converge on one recorded result — and a
step built on `runDurable`/`durableTool` gets the real [at-most-once guarantee](../durable/README.md#what-never-charged-twice-actually-means). A plain step's body, however, still
executes in both pollers. Read the guarantee as *"the schedule advances once and the journal records
one result"*, not as *"two workers can never run the same job at the same time"*, and write steps that
touch the outside world to be idempotent — the same rule `@gnldev/queue` and `@gnldev/events` state.

### The fire lock is not the run's lock

`<runId>:fire`, not `<runId>`, and the distinction is load-bearing. The two locks answer different
questions — *"is another poller firing this occurrence?"* versus *"is this run executing anywhere?"* —
and for a while they were the same key. That was invisible until a run started taking its own lock:
under `preset: 'critical'`, `runWorkflow` locks `<runId>` too, so the poller was refusing its own run.
Measured in production on a five-minute health trigger — five polls, five `RunBusyError`s, `status:
'failed'`, and not one step ever executed. Nothing raced; it simply could not work. The two locks now
nest instead of competing.

One upgrade note: during a rolling deploy across this change, an old poller and a new one hold
*different* fire-lock keys for the same occurrence, so both can start the fire. Under the `critical`
preset the run's own lock refuses the second executor; without it, a side-effecting workflow can run
once per poller in that window. If that matters to the workflow, drain the pollers over the upgrade.

### A busy run is a deferral, not an attempt — and a drain is a release

A fire this process gave up is not an attempt either: a drain (`RunDrainedError`) or a lost liveness
session (`LivenessUnavailableError`) writes nothing — the trigger stays due, `attempts` as it was — and a
process that is not leaving fires it, continuing the same run. One function answers what counts, for the
queue too: `attemptEndOf` in `@gnldev/durable`. A fire under way is held by its process: a drain waits for
it, and `gnl pending` lists it as running.

If `runWorkflow` refuses at lock acquisition (`RunBusyError` with `atLockAcquisition` — somebody else
is already running this exact `runId`), the trigger is **deferred by `retryMs`**: `attempts` is not
incremented, `status` stays `'pending'`, nothing is written to `sched:fail:<id>`, and `PollResult.skipped`
counts it. Nothing was tried and nothing went wrong, so spending retry budget on it is how a busy
minute turns into a permanently dead trigger.

Deferrals are counted in `sched:busy-skip:<id>` and surfaced on `listTriggers()` as `deferrals` /
`lastDeferralAt`, because a deferred trigger otherwise reads exactly like a healthy one. If that
number climbs while `fireCount` does not, the trigger is being refused, not waiting. A **mid-flight**
`RunBusyError` (this poller got in and was fenced out later) is still an ordinary failure — something
did happen there.

## Time is data

A trigger's next fire time is **resolved and then frozen** into the journal, not recomputed on each
poll. A worker that wakes up late fires the run it owed rather than silently skipping it, and a
replay sees the same schedule the original run saw.

## Exports

| Export | What it is |
|---|---|
| `scheduleWorkflow` | Registers a cron / interval / `at` trigger |
| `pollScheduler` | Fires whatever is due; call it from a loop or a cron container |
| `listTriggers` | Everything currently registered |
| `unscheduleWorkflow` | Removes a trigger |
| `pauseTrigger`, `resumeTrigger` | Stops a trigger firing, and lets it fire again (no catch-up) |
| `createScheduler` | The stateful wrapper, if you would rather hold an object than call functions |
| `nextCronTime`, `parseField` | The cron arithmetic, exported for testing and for building your own UI |
| `createWorkflowWaker` | Wakes a suspended workflow when its sleep or wait elapses |
| `moveTrigger` | Gives a pre-upgrade system trigger its owner, without doubling it |
| `triggerEraser` | One person's triggers, for `eraseSubject` |

## License

Apache-2.0 — see [LICENSE](./LICENSE).
