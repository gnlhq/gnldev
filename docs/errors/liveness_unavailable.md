# liveness_unavailable

**HTTP 503 · `Retry-After: 1`**

## What happened

The process that received the request has lost the database session that proves it is alive, and does
not hold a new one yet. Your request was **not started**. Nothing was written for it.

On Postgres, each process holds one advisory lock on its own session for as long as it exists; the
other processes ask for that lock to know whether it is still running what it holds. The session ended
under it: the database restarted or failed over, an operator terminated the backend
(`pg_terminate_backend`), or the network between the two was cut long enough for the server to give up
on it (~25 s).

## Why

Until it holds its lock again this process can tell neither that a run is still its own, nor whether
another process is alive. Starting the run anyway could let two processes execute it at once; answering
"dead" for another process would let this one take a run over beside a live holder. So it refuses, and
asks for a retry.

It comes back by itself: it opens a new session and takes its lock back under the **same** process id,
usually within a fraction of a second. The other processes read it as dead only once its lock has been
gone for `reconnectGraceMs` (5 s by default), so when it is back within that, nothing it held was taken
over. When it is not — a partition, a long failover — the others take it for dead and may take over the
runs and calls it held. Half a grace after the loss, the tool bodies it is running get an aborted
`abortSignal` with this error as the reason.

A body that was **already running keeps running** unless it honours that signal: its effect can then
happen twice — once here, once in the process that took the call over. The defence is the provider's
idempotency key (`idempotencyKey`, passed to every side-effect tool): the provider folds the two into
one. Whichever finishes second does not change the call's record; its caller gets that record (or busy
while the other attempt still holds it), and its own result is kept as a late report.

## What to do

**Retry the same request.** A client that already retries on 503 needs no change.

**If you see it often**, look at what ends the sessions: database restarts or failovers, a pooler in
transaction mode between the process and the database (a liveness session must be direct or
session-mode — see `postgresLiveness`; one is refused at open with `TransactionPoolerError`, and one that
is found out later, when the heartbeat sees its statements leave the lock's backend, logs that error and
answers this code until it is given a direct URL), or network timeouts on long-idle connections.
