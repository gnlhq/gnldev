# draining

**HTTP 503 · `Retry-After: 1`**

## What happened

The process that received the request is shutting down. A process manager (pm2, Kubernetes,
systemd) sent it SIGTERM, and it is draining: it finishes the work it already holds and takes none.
Your request was **not started**. Nothing was written for it.

## Why

A process that took new work in its last seconds would either be killed in the middle of it or keep
the shutdown waiting. Answering 503 instead hands the request back while it is still untouched, at
the one moment a retry is safe without any bookkeeping.

What the process holds keeps going: the tool that is running finishes and is recorded, the queue job
in its handler finishes, and a run that has more steps is released for another process to continue.
Nothing is written to the store to say "shutting down" — the flag belongs to the process.

## What to do

**Retry the same request.** Another process answers it; with a load balancer in front, the retry
lands elsewhere as soon as this instance leaves the pool. `Retry-After` says how long to wait. A
client that already retries on 503 needs no change.

**If you see it outside a deploy or a restart**, something is sending your processes SIGTERM:
an autoscaler, a liveness probe that fails, a host that is being drained.

**If a shutdown takes too long**, see how long your process manager waits before it kills. The drain
waits up to `DRAIN_DEADLINE_MS` (25 s) by default; pm2's own default `kill_timeout` is 1.6 s, which
kills the process mid-drain. The `ecosystem.config.cjs` that `gnl init` writes sets it above the
deadline.
