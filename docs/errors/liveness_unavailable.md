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

From the moment its session ended, the other processes read this one as dead, and may already have
taken over the runs and calls it held. Until it holds a lock again it can tell neither that a run is
still its own, nor whether another process is alive. Starting the run anyway would let two processes
execute it at once; answering "dead" for another process would let this one take a run over beside a
live holder. So it refuses, and asks for a retry.

It comes back by itself: it opens a new session under a **new** process id (the old id stays dead —
others may have acted on it) and serves again, usually within a fraction of a second. What it was
executing under the old id is no longer its own: a tool body it had not started does not start, and
another process continues the run.

## What to do

**Retry the same request.** A client that already retries on 503 needs no change.

**If you see it often**, look at what ends the sessions: database restarts or failovers, a pooler in
transaction mode between the process and the database (a liveness session must be direct or
session-mode — see `postgresLiveness`), or network timeouts on long-idle connections.
