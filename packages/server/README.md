# @gnldev/server

Exposes the `createGnl` registry as **auto-REST + OpenAPI + SSE**. Every endpoint bottoms out in `runDurable` → the journal, replay and the [at-most-once side-effect guarantee](../durable/README.md#what-never-charged-twice-actually-means) are inherited for free. (The durable counterpart to the common auto-REST pattern.)

> Install: `pnpm add @gnldev/server` — or use it from a [repo clone](https://github.com/gnlhq/gnldev): `pnpm install && pnpm -r build`.

```bash
npm i @gnldev/server   # peer: @gnldev/durable  ·  dep: hono
```

```ts
import { createRestApi } from '@gnldev/server';
import { serve } from '@hono/node-server';
import { SqliteStorage } from '@gnldev/durable/sqlite';

const api = createRestApi({
  journal: new SqliteStorage('runs.db').runs,
  agents: { support: { model: 'anthropic/claude-opus-4-8', tools, guard, maxSteps: 8 } },
});
serve({ fetch: api.fetch, port: 3000 });        // on its own port
// app.mount('/api', api)                      // inside a Hono app
```

## Binding it to a Node server

`createRestApi` returns a fetch handler — callable, and carrying `.fetch`. On Node, bind it with the
bridge on this package's own subpath:

```ts
import { createServer } from 'node:http';
import { toNodeHandler } from '@gnldev/server/node';

express().use('/api', toNodeHandler(api));                            // Express
await fastify.register(middie); fastify.use('/api', toNodeHandler(api));   // Fastify + @fastify/middie
koa.use(c2k((req, res, _next) => toNodeHandler(api)(req, res)));      // Koa + koa-connect
createServer(toNodeHandler(api)).listen(3000);                        // node:http
nestApp.use('/api', toNodeHandler(api));                              // Nest (Express or Fastify)
```

Three rules, all measured on live servers rather than reasoned about — and held there by a test that
boots Express 5, Fastify 5 and Koa 3 on a socket (`a-node-framework-serves-the-api.test.ts`):

**Bind at the middleware layer, not as a route.** On Fastify the difference is the whole story:
middleware runs before body parsing, a route runs after it. `fastify.all('/api/*', …)` looks correct,
passes every GET, and refuses a perfectly good POST — Fastify's built-in JSON parser has already
drained the stream, and the bridge answers 500 `body_consumed_upstream`.

**On Koa, declare the third parameter.** `koa-connect` switches on `fn.length`: a middleware with
fewer than three parameters is assumed not to terminate the response, so it calls `next()` straight
after and Koa sends its own 404 first — measured, 404 on every route (Koa 3.2; Koa 2 also logged
`ERR_HTTP_HEADERS_SENT`). Naming `next` without calling it selects the branch that waits, which is what a
handler that owns the response needs. `koa-connect` takes no path, so bound as above the API answers
every request, 404 included: to keep routes of your own, put it behind a check on `ctx.path` that calls
`next()` for anything outside the API's prefix (and strips the prefix from `ctx.req.url`), as the test does.

**Mount before whatever parses request bodies.** A parser that runs first reads the stream to the end
and hands the result to the framework, not to us. Get it wrong and the bridge says so
(`body_consumed_upstream`) instead of blaming your request. Your own routes keep the parser: it still
runs for everything mounted after.

## Next.js (App Router)

No bridge: a route handler takes a `Request` and returns a `Response`, which is what the API is. One
catch-all route hands it every request under its folder, with that folder's prefix cut, since the API's
routes start at `/agents`:

```ts
// app/api/[...path]/route.ts
import { createRestApi } from '@gnldev/server';
import { PostgresStorage } from '@gnldev/durable/postgres';

const api = createRestApi({ storage: new PostgresStorage({ connectionString: process.env.DATABASE_URL }), agents: {} });

function handle(req: Request): Response | Promise<Response> {
  const url = new URL(req.url);
  url.pathname = url.pathname.replace(/^\/api(?=\/|$)/, '') || '/';
  return api.fetch(new Request(url, req));
}
export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE, handle as OPTIONS };
```

Measured on Next.js 16.4 with `next build` and `next start`, no `next.config` entry: the agent list, a
run, and a `/stream` read as server-sent events, on memory and on Postgres (raporlar/2026-10-21-frameworks).
That is the Node runtime, a route handler's default; the Edge runtime was not tried, and the stores need
Node (a process liveness, a driver). As everywhere, production refuses to start
without `auth` (or a deliberate `allowOpenAccess: true`).

## Endpoints (per agent)
| Method | Path | Description |
|---|---|---|
| GET | `/agents` | List of registered agent metadata (client/playground selector) |
| POST | `/agents/:name/run` | Durable run `{runId, prompt\|messages, threadId?, approvals?}` → `{ok, runId, text, interrupts}` |
| POST | `/agents/:name/stream` | **SSE** streaming run (schema below) |
| POST | `/agents/:name/resume` | `{runId, approvals?}` — the input is read from the journal |
| GET | `/runs` · `/runs/:id` | Run summaries / journal timeline |
| GET | `/runs/:id/events` | **SSE** — follow a run already started, by any process, from `Last-Event-ID` (or `?after=`) |
| POST | `/runs/:id/cancel` | Cancel a run, in whichever process executes it |
| GET | `/openapi.json` | Generated schema |
| GET | `/health` | Liveness — process is alive. No storage access. **Unauthenticated** |
| GET | `/ready` | Readiness — can serve traffic; 503 if the journal is unreachable. **Unauthenticated** |

### Health checks

`/health` and `/ready` answer two different questions, and pointing the wrong probe at the wrong one
causes the wrong action:

- **`/health`** — is the process alive? It touches nothing. A failing *dependency* must not make an
  orchestrator kill and restart a healthy process: restarting it does not reconnect your database, it
  only discards whatever the process still had in flight. Use this for liveness probes.
- **`/ready`** — can it serve? It reads from the journal, with a 2s budget because an unreachable
  database usually *hangs* rather than refusing. On failure the instance leaves the load balancer while
  staying alive to recover. Use this for readiness/traffic probes.

Both are deliberately unauthenticated — probes run before any credential exists, and usually never get
one. For the same reason they report reachability and nothing else: no agent names, no counts, no
configuration, and never the underlying error, which for a database failure routinely carries the host,
database and user. That detail goes to your logs.

```yaml
# Kubernetes
livenessProbe:  { httpGet: { path: /health, port: 3000 } }
readinessProbe: { httpGet: { path: /ready,  port: 3000 } }
```

### SSE schema (`/stream`)
`event` + JSON `data`: `text-delta {text}` · `tool-call {toolCallId,toolName,input}` · `tool-result {...}` · `error {error}` · `interrupt {interrupts[]}` (when the stream ends) · `done {runId,finishReason,usage}`. The same schema is also used in the `@gnldev/studio` playground → [`@gnldev/client`](../client) connects to both ends.

### A run outlives its connection; a reader resumes where it left off
A run executes apart from the request that started it, on the process's executor. A closed tab, a
dropped connection or a proxy timeout stops the reading, never the run; only `POST /runs/:id/cancel`
(or an `abortSignal` your own code passes) stops it. A second request for a run in flight follows the
same execution — one effect, both get the answer.

Every SSE event's `id:` is its place in the run's event log: the event's `seq`, or `seq.offset` in the
middle of an answer (how much of the next segment's text the reader already holds). The browser's
`EventSource` sends the last `id:` it saw as `Last-Event-ID` when it reconnects; `/stream` (also
`lastEventId` in the body) and `GET /runs/:id/events` (also `?after=`) continue right after it — from
any process, with no gap and nothing sent twice. A reader on the executing process gets each delta as
it is produced; the store gets the text in segments of about one second, which is what a reader on
another process reads.

## Other wire formats and browsers (`surfaces`, `cors`)

`surfaces` mounts another wire format on the agent stream: `chatSurface()` from
`@gnldev/chat-adapter` (useChat) at `/agents/:name/chat`, `aguiSurface()` from `@gnldev/agui` at
`/agents/:name/agui`. A surface only translates the format. Auth, organization, ownership, budget
and cancel are this API's, the same as `/agents/:name/stream`. A surface may not take a REST path.

`cors` lets a browser on another origin call this API, which is what an end user holding their own
token needs. It is off by default. Name the origins, or `'*'`:

```ts
import { createRestApi } from '@gnldev/server';
import type { CreateGnlConfig } from '@gnldev/durable';

declare const config: CreateGnlConfig;

export const api = createRestApi(config, { cors: { origins: ['https://app.example.com'], maxAge: 600 } });
```

A preflight is answered before any gate. No `Access-Control-Allow-Credentials` is sent: credentials
here are bearer tokens. `X-Gnl-Run-Id`, `X-Gnl-Idempotency-Status` and `Retry-After` are exposed.

## Frontend
For type-safe calls use [`@gnldev/client`](../client) (core) + `@gnldev/client/react` (hooks). For REST + Studio Playground in one command use [`@gnldev/cli`](../cli) `gnl dev`.

## How it works
Every call to `/run` and `/stream` names one of two things, and exactly one:

- **`workKey`** — your name for a unit of work, not for a conversation. The engine derives the run's
  id from it and returns that id in the `X-Gnl-Run-Id` header. Calling again with the same `workKey`
  is routed to the same run: durable replay, side effects once. A `workKey` is a *business name* (the
  invoice being issued, tonight's reconciliation batch) — keep sensitive data out of it, because it
  is reflected in error details and shown on Studio screens. Coming from `thread_id`? There the same
  key means *continue this conversation*; here it means *this is the same job*. A conversation is
  `threadId`, a separate field you can send at the same time.
- **`runId`** — a raw id you already hold (a resume, a fork, an id you stored).

Sending both is a 400: two identities for one call is a question with no honest answer. Sending
neither is also a 400. `Idempotency-Key` is accepted as a `workKey` alias — it names the work, which
is what that header has always meant — and it is read only when the body named nothing itself.

A `workKey` in the default `resource` scope needs a subject to be unique *within*: name the end user
(`resourceId`, or an authenticated principal), or the call is refused rather than run for nobody.

**How long a `workKey` stays unique:** as long as the run record lives — not a minute longer. Your
retention window should not be shorter than the longest retry your clients can produce.

**Was this call new work, or an answer you already had?** Every response to `/run` and `/stream`
carries `X-Gnl-Idempotency-Status`: `new` when this call started the run, `replay` when the run had
already been driven and the answer came from the journal. Nothing re-ran in the `replay` case — no
model call, no tool, no charge. It is the header to log if you want to know how much of your traffic
is retries, and the one to assert on if you are verifying that your client's retry logic is actually
deduplicating.

**A concurrent second call for an agent run follows it.** A double-click, two tabs, a retry racing
its original: the second call attaches to the execution in flight — in this process or another — and
gets the same answer; nothing executes twice. A run that has already **finished** replays (see the
header above). Workflow runs still answer a concurrent duplicate `409 run_busy` + `Retry-After`: the
same request is correct, only early.

**On SIGTERM the process drains.** `drainOnSignal()` from `@gnldev/durable` (or `api.drain()`): a new run gets `503 draining`
with `Retry-After`, the tool a run is executing finishes and is recorded, then the process exits and
another one continues the run. Give your process manager more time than the drain's 25 s.

**Auth (opt-in, but no silent openness in production):** `createRestApi(config, { auth })` accepts an `AuthProvider` (the free `@gnldev/auth` `roleAuth`, or the paid `@gnldev/auth-ee`) or a backward-compatible `{read, write}` pair. If `auth` is not given, endpoints are open; but under `NODE_ENV=production` this is only possible DELIBERATELY, via `allowOpenAccess: true` — without the flag, setup throws a clear error ("auth required in production"). Outside production, a setup without auth works, with a one-time `console.warn` on the first request, so a silent fail-open cannot survive unnoticed.

Without auth (or with only a `{read, write}` pair, which has no identity), the API answers only requests addressed to it as `localhost`, a `*.localhost` name or an IP address; any other `Host` gets 403 [`host_not_allowed`](../../docs/errors/host_not_allowed.md), reads included — a DNS-rebinding page's requests are same-origin to the browser, so only the name it used gives it away. List your own names with `allowedHosts: ['mybox.test', '.ngrok-free.app']` (leading dot: every name under it; `true`: every name), or `GNL_ALLOWED_HOSTS=mybox.test` in the environment. With an identity-binding provider, a request it resolves to a caller is answered under any name; one that resolved to nobody and that the provider allowed anyway is held to the same rule. A state-changing request from a page on another site that carries no identity is refused 403 [`cross_site_refused`](../../docs/errors/cross_site_refused.md); `allowCrossSite: true` lifts that check alone, for a public widget.

**This server is not for browsers.** It is a backend service your own backend calls; your users reach
your application, and your application reaches this. Nothing here authenticates an end user, and no
credential below is safe to ship to a client device.

**Which credential your application carries:** `client`, not `admin` — see
[@gnldev/auth](../auth/README.md) for the four classes. `admin` cancels runs, reads the whole
organization's history and reads `/usage`; an application that runs agents needs none of that. A
`client` credential is a whitelist (`agents:run`, `workflow:run`, `run:cancel`, plus reads), so routes
added in later versions are refused rather than silently granted.

**Every `client` request names the end user it acts for.** One application credential serves many
users, so `resourceId` in the body (or `?resourceId=` on a read) says which one:

```
POST /agents/:name/run   { runId, prompt, threadId, resourceId }   → 400 without resourceId
GET  /runs?resourceId=u-ayse                                       → only that user's runs
GET  /threads?resourceId=u-ayse                                    → only that user's conversations
GET  /runs/:id?resourceId=u-mehmet                                 → 404 if the run is someone else's
```

That id is what keeps two of your users' conversations, memories and runs apart — the memory layer
scopes on it. Operator credentials may omit it; they work across the organization by design.

**If your end users carry their OWN credentials, they are bound to themselves.** A principal minted
as `kind: 'subject'` (the default for @gnldev/auth-ee's user stores and SSO logins) speaks only for
itself. Its own name wins over any `resourceId` in the request:

```
GET  /runs                              → only its own runs
GET  /runs/:id                          → 404 if the run is someone else's, even with ?resourceId=<owner>
GET  /threads/:id/messages              → 404 if the thread is someone else's
POST /agents/:name/run { resourceId }   → filed under its own name, whatever the body says
GET  /usage                             → 403: organization-wide, staff only
```

Staff (`kind: 'operator'`) works across the organization and may name any end user, or none. A caller
that is not staff and carries no name is refused. See [@gnldev/auth](../auth/README.md) for how the
kind is set.

**How a request becomes the engine's caller.** `auth.authenticate(req)` is the one place a request
is identified — it has the shape of `@gnldev/auth`'s `Identify`, the same function chat-adapter,
agui and mcp take. The server then maps the principal the ONE way every door does,
`engineCallerOf(principal, named)`, where `named` is the `resourceId` the request carries (body on a
write, `?resourceId=` on a read):

| principal `kind` | names a user? | engine caller | a run it starts belongs to |
|---|---|---|---|
| `subject` | ignored | that user | that user |
| `application` | yes | the named user | the named user |
| `application` | no | `unknown` (the agent routes and the reads answer 400 first) | nobody it can reach again |
| `operator` | no | staff | nobody (staff's own work) |
| `operator` | yes | the named user: staff speaks for her on this request | the named user |
| none, or no principal model (`{read, write}`, no `auth`) | — | staff (single-operator mode) | nobody |

A name no user can have (over 200 characters, a control character, a line separator, or a reserved
prefix such as `operator:`) is a 400, not a run filed under nobody. Staff that names a user is held to
that user's runs (a run of someone else's answers 403), and still reaches staff's own runs. Whose a run
is, is read one way everywhere — `@gnldev/durable` `runOwnerOf` + `decideRunAccess` — including the
lists: `GET /workflows/runs?resourceId=u-ayse` holds exactly the runs the gates would let Ayşe open.

**Replay and budget read the same "work".** `X-Gnl-Idempotency-Status: replay` and the budget gate's
exemption for a continuation both ask whether work exists under the run: a frozen input, a workflow
step or registry row, or rows with no owner record. An owner record alone (a run born and failed
before it froze its input) is `new`, and over budget its retry is a 402 like any new run.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
