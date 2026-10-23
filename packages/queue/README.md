# @gnldev/queue

> Part of [GNL](https://github.com/gnlhq/gnldev), a full agent framework for TypeScript — works with the rest of it, or on its own.

**Durable background-task queue + worker** on top of the journal. Each job runs as a durable run → if the process crashes mid-job it resumes from the journal, and a side effect already recorded as done is not run again ([at-most-once](../durable/README.md#what-never-charged-twice-actually-means)). `acquireRunLock` keeps two workers off the same job at once: a worker whose process is frozen (a GC pause, a VM migration, `SIGSTOP`) keeps its job however long, and a worker whose process died loses it at once. The process is asked through the storage's process liveness (`SqliteStorage`/`PostgresStorage` answer for themselves); without one, the lease's TTL decides.

> Install: `pnpm add @gnldev/queue` — or use it from a [repo clone](https://github.com/gnlhq/gnldev): `pnpm install && pnpm -r build`.

```bash
npm i @gnldev/queue   # peer: @gnldev/durable
```

```ts
import { enqueue, createWorker } from '@gnldev/queue';
import { SqliteStorage } from '@gnldev/durable/sqlite';

const storage = new SqliteStorage('runs.db');

// Producer: idempotent enqueue (same id → single job). Takes the WORK store, not the run journal.
await enqueue(storage.work, 'send-email', { to: 'a@x.com' }, { id: 'email:order-1' });

// Consumer: retried on handler crashes (dead-letter after maxAttempts). Takes the whole storage —
// it needs the work store to lock jobs and the run journal to keep the side effect at-most-once.
const worker = createWorker(storage, {
  // A bare `await sendEmail(...)` here is AT-LEAST-once: a crash after the send but before the
  // job is acked reclaims the lock and calls the handler again. Route it through the job's durable
  // run (`ctx.run`, a runDurable on a stable runId), and the send happens once.
  'send-email': async (payload, ctx) => ctx.run({ model, tools, prompt: '...' }),
});
await worker.runOnce();   // or worker.start() (poll loop)
```

### One queue: enqueue here, run here

`createQueue` is the two calls above in one: the handlers, and a worker that runs them, started in this process. Pass `worker: false` when the workers run elsewhere.

```ts
import { createQueue } from '@gnldev/queue';
import { SqliteStorage } from '@gnldev/durable/sqlite';
const storage = new SqliteStorage('runs.db');

const queue = createQueue(storage, { 'send-email': async (payload, ctx) => { /* ... */ } });
await queue.enqueue('send-email', { to: 'a@x.com' }, { id: 'email:order-1' });
// on shutdown: await queue.close();
```

A job still waiting after `NO_WORKER_NOTICE_MS` (10 s) with no worker polling its store is reported once per type (`console.warn`): enqueued where nothing consumes it, it would otherwise wait without a word.

## Delays, retries, cancelling, concurrency

```ts
import { enqueue, createWorker, cancelJob } from '@gnldev/queue';
import { InMemoryStorage } from '@gnldev/durable';
declare function sendReminder(p: unknown, signal: AbortSignal): Promise<void>;
const storage = new InMemoryStorage();

// Not before a time (epoch ms or a Date). Stored in the job record, so it survives restarts.
const id = await enqueue(storage.work!, 'remind', { to: 'a' }, { runAt: Date.now() + 60 * 60_000 });

// Changed your mind: no worker starts it after this returns true.
await cancelJob(storage.work!, id);

createWorker(storage, { remind: async (p, ctx) => sendReminder(p, ctx.signal) }, {
  retryDelayMs: (attempt) => 1_000 * 2 ** (attempt - 1), // 1s, 2s, 4s… between failed attempts
  concurrency: 4, // this worker runs up to 4 jobs at once
  typeConcurrency: { remind: 2 }, // at most 2 `remind` jobs at once across ALL workers
});
```

- **`retryDelayMs`** (number or `(attempt, err) => ms`, default 0): after a failed attempt the job may
  not run again before `now + delay`. The time is stored with the job (`qtry:<id>`), so every worker
  honours it, also after a restart. The last attempt dead-letters without waiting.
- **Attempts are counted when they start**, so an attempt the process died in counts too: a handler that
  takes its worker down every time is dead-lettered after `maxAttempts` starts, not started forever.
  `listJobs()` reports attempts started (a job done on its first try shows 1).
- **`runAt`**: compared with the run journal's clock when it has one (`now()`), else the worker's. A
  waiting job does not hold up the jobs behind it. Re-enqueuing the same id keeps the first `runAt`.
- **`cancelJob(work, id)`** → `true` if it cancelled the job, `false` for an unknown or already finished
  one. A job that is running is not killed: its `ctx.signal` aborts on the worker's next heartbeat tick
  (`ttlMs/3`; never with `heartbeat: false`), and `ctx.run` passes that signal on. If the handler
  finishes anyway the job shows `done`; otherwise `cancelled`. `retryJob` does not take a cancelled job.
- **`concurrency`** (default 1): that many independent poll loops in one worker, after `start()`.
  `runOnce`/`drain` still run one job per call, and `drain` runs only what is eligible now.
- **`typeConcurrency`**: a per-type limit for the whole fleet, kept as that many leases in the run
  journal. A dead worker's slot frees after `ttlMs`. Give every worker the same numbers.
- `listJobs` shows `status: 'cancelled'` and, for a job that is waiting, `notBefore`.
- During a rolling deploy, a 0.9 worker on the same storage ignores `runAt`, retry delays and cancels.

## Jobs for an end user

A job can say whose it is. The job's run belongs to that owner, and the handler does not pass it on:
`ctx.run` starts the run as the owner.

```ts
import { enqueue, createWorker } from '@gnldev/queue';
import { InMemoryStorage, user } from '@gnldev/durable';
declare const model: import('@ai-sdk/provider').LanguageModelV4;

const storage = new InMemoryStorage();
await enqueue(storage.work!, 'weekly-summary', { week: 39 }, { caller: user('ayse', 'acme') });
// the same job, in the shorthand: { resourceId: 'ayse', orgId: 'acme' }

createWorker(storage, {
  // ctx.run = runDurable on the job's journal and runId, as the job's owner. Nothing to forget.
  'weekly-summary': async (payload, ctx) => ctx.run({ model, prompt: `Summarise week ${payload.week}` }),
});
```

- **Who the run is.** `ctx.caller` is read once from the owner recorded at `enqueue`: `user(id, org)`,
  `staff(org?)` when you enqueued with `caller: staff()`, else `unknown`. A job with no owner is never
  staff by omission — the same rule as `runDurable`.
- **Forgetting cannot give an ownerless run.** Before the handler runs, the worker records the job's
  owner as the owner of `ctx.runId`. A handler that still calls `runDurable({ runId: ctx.runId, … })`
  without the user, or with another user, is refused (`RunOwnerMismatchError`) — the job fails
  loudly instead of producing a run only staff can see.
- **A workflow instead of an agent:** `gnl.runWorkflow(name, input, { runId: ctx.runId, caller: ctx.caller })`.
- `ctx.journal` and `ctx.storage` are scoped to the job's organization. Build the organization's
  `createGnl` from `ctx.storage`.
- `retryJob` and `ctx.enqueue(type, payload)` keep the owner and the organization.
- `retryJob(work, id)` adds a new job record (the dead letter stays, for audit) that **continues the dead
  letter's run**: `ctx.runId` is the original `job:<id>`, so a side effect the run already recorded as done
  is replayed, not fired again. For a fresh run on purpose: `retryJob(work, id, { newRun: true })`.
  Passing `ctx.storage.work` to `enqueue` is refused, since no worker polls that store.
- An explicit `id` is a name **within its owner**: two organizations (or two users) using `weekly-report`
  get two jobs. `enqueue` returns the stored id; use that one with `retryJob` and `listJobs`. A system
  job's id is kept as given.
- `maxDepth` is counted per organization, from a small per-organization index: its cost is
  `min(depth, maxDepth)` records of your own organization, not the whole shared queue.

### Upgrading a job that already exists

A job enqueued before it had an owner keeps its old id. Enqueuing it again with an owner would add a
second job, and both would run. Move it once, with the workers stopped:

```ts
import { moveJob } from '@gnldev/queue';
import { InMemoryStorage } from '@gnldev/durable';
const storage = new InMemoryStorage();

await moveJob(storage.work!, 'weekly-report', { orgId: 'acme' }); // → the owned id
```

The owned job takes over the old one's state (finished stays finished, a dead letter stays dead) and
the old one is marked done with `movedTo`. After that, `enqueue(…, { id: 'weekly-report', orgId: 'acme' })`
finds the moved job.

### Erasing a person

`jobEraser(storage)` removes one person's jobs: the records, the `qdone`/`qfail`/`qcancel`/`qtry`/`qatt`/`qown` markers
(`qfail` holds the handler's error text), the worker's lease locks, and the job runs. Hand it to
`eraseSubject` from `@gnldev/durable` together with the other packages' erasers. `eraseSubject` takes
the storage itself and erases every store it holds (runs, threads, working memory, documents, owned
jobs and events); the erasers add what each package keeps in its own format:

```ts
import { jobEraser } from '@gnldev/queue';
import { triggerEraser } from '@gnldev/scheduler';
import { eventEraser } from '@gnldev/events';
import { InMemoryStorage, eraseSubject, toJournal } from '@gnldev/durable';

const storage = new InMemoryStorage();
const journal = toJournal(storage);
await eraseSubject(storage, 'ayse', {
  orgId: 'acme',
  erasers: [jobEraser(storage), triggerEraser(journal), eventEraser(storage.work!)],
});
```

The work store needs `deleteIdPrefix` and `deletePrefix`. A store without them makes the eraser throw,
rather than report a partial erasure as done.

## API
- `enqueue(work, type, payload, { id?, maxDepth?, caller?, resourceId?, orgId?, runAt? }) → jobId` — `work` is `storage.work`.
  `caller` is an engine `Caller` (`user(id, org)`, `staff(org?)`); `resourceId`/`orgId` are its shorthand.
- `createQueue(storage, handlers, opts?) → { enqueue, worker?, close }` — a worker over `handlers` started in this process; `opts` are `createWorker`'s plus `worker: false` (run nothing here).
- `createWorker(storage, handlers, opts?) → { runOnce, drain, start, stop }` — `opts`: `owner`, `liveness` (default: the process's, or the storage's own; a shared store with none is refused), `ttlMs` (lease reclaim when no process can be asked), `pollMs`, `maxAttempts`, `onError`, `backoff`, `maxPollMs`, `heartbeat`, `maxRenewFailures` (after this many heartbeat renewals fail in a row — default 3 — the worker treats the lock as lost rather than risk running the job twice), `retryDelayMs`, `concurrency`, `typeConcurrency`
- `JobCtx` gives the handler `{ journal, jobId, runId, caller, run, storage, orgId?, enqueue, signal }`. `ctx.run(args)` is
  `runDurable` on `journal`/`runId` as `caller` — it keeps the side effect at-most-once and the run the owner's.
- `listJobs(work)` shows each job's `resourceId`/`orgId` next to its status.
- `retryJob(work, id)` re-enqueues a dead letter for the same owner.
- `cancelJob(work, id)` cancels a job that has not finished (see above).
- `moveJob(work, id, owner)` gives a pre-upgrade system job its owner, without doubling it.
- `jobEraser(storage)` erases one person's jobs (see above).

## How it works
Jobs are written to an append-only log; the worker leases a job and runs it. The lease names the worker's process, and another worker asks THAT process — through the store's liveness, a Postgres session lock or a Sqlite file lock — whether the lease is held, not how old it is: a frozen worker keeps its job, a dead one releases it at once (measured: taken over in ~1 s, was 30 s). Crash → the process is gone → reclaim → handler runs again → `runDurable` resumes from the journal → **a side effect already recorded as done is not repeated**; one caught in the crash window blocks and asks rather than re-firing ([at-most-once](../durable/README.md#what-never-charged-twice-actually-means)).

The worker's lock is a **lease on the job** (`<runId>:lease`), not a lock on the run. That is why the
example above works: your handler is free to take its own run lock on `ctx.runId` — a `lock` option, or
a `runWorkflow` under `preset: 'critical'` — and the two nest instead of colliding. They were once the
same key, and a handler that locked its own `ctx.runId` was refused by the worker that had just called
it, on every attempt, until the job dead-lettered without ever running.

## A job whose last attempt never reported (`in-doubt`)
A job that reaches `maxAttempts` while its last attempt never reported — its worker cut off from the store, not crashed in the handler — is `in-doubt`, not `failed`: that attempt may still finish. It is not started again. A handler that finishes after its worker lost the job records the job `done` (`late: true`), over an `in-doubt` or `failed` dead letter. `retryJob` retries an `in-doubt` job like a dead letter. A job whose handler threw is still `failed`.

## Shutting down
`drainProcess()` / `drainOnSignal()` from `@gnldev/durable` stop the worker taking new jobs and wait for the one in a handler to end, then the process exits. Give the process manager more time than the drain (pm2 `kill_timeout: 30000`). A job whose run the drain released at its next step (`RunDrainedError`) did not fail: its attempt is given back and it stays pending for another process, which continues the same run. The same holds for a lost liveness session (`LivenessUnavailableError`) and a run refused because it executes elsewhere — none of them is an attempt or reaches `onError` (`attemptEndOf` in `@gnldev/durable` decides it, for the scheduler too). While a worker holds a job, `gnl pending` lists it as running.

## Heartbeat + empty-poll backoff (both on by default)
`heartbeat`: a lease written without a process (a store with no liveness) is judged by its age; if a job's handler runs longer than `ttlMs`, that lease could expire before the handler finishes, letting a second worker take over the same job and run it twice — `createWorker` prevents this by `renew`ing the lease every `ttlMs/3` while the handler runs. If a real takeover is detected (fencing token mismatch), this worker does NOT WRITE `qdone`/`qfail`/`qtry`, so it doesn't clobber the result of the worker that took over. Can be disabled with `heartbeat: false` (recommended only for test/debug).
`backoff`: if `runOnce()` claims no job, the next poll interval starts at `pollMs` and grows ×2 (cap `maxPollMs ?? pollMs*32`); it resets to `pollMs` once a job is claimed — prevents a poll storm on an empty queue. `backoff: false` reverts to the old constant-interval behavior.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
