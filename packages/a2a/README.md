# @gnldev/a2a

> Part of [GNL](https://github.com/gnlhq/gnldev), a full agent framework for TypeScript — works with the rest of it, or on its own.

**Agent-to-agent, both ways.** Serve your GNL agents to any [Agent2Agent (A2A)](https://a2a-protocol.org)
client with `createA2AServer` (`@gnldev/a2a/server`), and call a remote agent — another GNL server or any
A2A agent — as an AI SDK tool with `createA2ATool`.

## Serve agents over A2A

```ts
import { createA2AServer } from '@gnldev/a2a/server';
import { InMemoryJournal } from '@gnldev/durable';

const a2a = createA2AServer(
  { journal: new InMemoryJournal(), agents: { researcher: { model, description: 'Finds sources' } } },
  { identify: (req) => auth.authenticate(req), authorize: (p, req, ctx) => auth.authorize(p, req, ctx) },
);
// a2a is a fetch handler: (request) => Promise<Response>. Mount it with your host, e.g. Hono's app.mount('/a2a', a2a).
```

What a client sees (A2A JSON-RPC binding; the card says `protocolVersion: '0.3.0'`):

| Request | Answer |
| --- | --- |
| `GET /agents/<name>/.well-known/agent.json` (or `agent-card.json`) | the Agent Card: name, description, `url`, one skill, `capabilities.streaming: false` |
| `POST /agents/<name>` `message/send` | a `Task` — `completed` with the answer as an artifact, or `input-required` |
| `POST /agents/<name>` `tasks/get` `{ id }` | the task, read from the journal (no model call) |
| `POST /agents/<name>` `tasks/cancel` `{ id }` | the task, `canceled` |

**A task is a GNL run**, so the engine's guarantees carry over:
- **The message id names the work.** For a user it is a `workKey` (unique within that user); for an
  anonymous caller the run id is `a2a:<messageId>`. A client that re-sends a message after a lost reply
  gets the same task back, replayed from the journal — the model and the tools do not run again.
- **`input-required` is a run suspended for approval.** The status message carries the interrupts in a
  data part (`{ interrupts: [{ toolCallId, toolName, args, reason }] }`). Reply on the task
  (`message.taskId`) with a data part `{ approvals: { <toolCallId>: true | false } }`; the run continues
  as its recorded owner, from its frozen input.
- **`tasks/cancel` is `cancelAgentRun`**: terminal, and a generation running in this process is aborted.
  A completed or failed task answers `-32002`.
- **A task is its owner's.** Identity goes through @gnldev/auth's `doorGate` (the same as the AG-UI, chat
  and MCP doors); ownership through @gnldev/durable's `runOwnerOf` + `decideRunAccess`. Another user's or
  another organization's task answers `-32001 Task not found`, the same as an id that does not exist.

Errors are JSON-RPC errors: `-32700` parse error, `-32600` invalid request (and an unknown agent, with HTTP
404 and `data.code: 'agent_not_found'`), `-32601` method not found, `-32602` invalid params, `-32001` task
not found, `-32002` task not cancelable, `-32004` unsupported operation (`message/stream`, push
notifications), `-32040` the door refused the caller (`data.status` is the HTTP status: 400, 401, 403).

### Options
- `identify` — who is calling (@gnldev/auth `Identify`, the function you hand every door). An
  **application** credential names the end user it acts for in `params.metadata.resourceId`; naming
  nobody is refused. Without `identify` every caller is anonymous: an anonymous task is reachable by
  every anonymous caller who knows its id, and the host rule below applies.
- `authorize` — the provider's `authorize`, asked for `agents:run` (`message/send`), `runs:read`
  (`tasks/get`, and `catalog:read` for the card) and `run:cancel` (`tasks/cancel`).
- `onDecision` — each request's outcome, to your provider's hook (`auth.onDecision`).
- `allowedHosts` / `allowCrossSite` — the open-surface rules for a request with no identity, with the same
  meaning as on `createRestApi`.
- `baseUrl` — the public URL the handler is mounted at; the card's `url` is `<baseUrl>/agents/<name>`.
  Default: read from the card request, which is right unless your host strips a mount prefix.
- `agentVersion` — the `version` the card advertises (default `'1.0.0'`).

**Its protections, printed when it is built.** `createA2AServer` prints a short block — whether callers are named
(`identify`), which hosts an anonymous caller may use (`allowedHosts`), whether other sites may call it
(`allowCrossSite`) — as `createRestApi` prints its own matrix — to standard error, never standard output; `protectionsBanner: false` silences it.
An option given in the config (first argument) instead of the options is refused by name, not ignored.

**Not here:** `message/stream` and `tasks/resubscribe` (SSE), push notifications, `tasks/get`'s
`historyLength`, file parts. The REST API's own gates — the budget gate, the agent approval registry and
the paid resource gate — belong to `createRestApi`, as they do for the AG-UI and chat doors.

## Call a remote agent

`createA2ATool` calls a remote agent on a `@gnldev/server` REST endpoint (`protocol: 'gnl'`, the default)
or any A2A agent (`protocol: 'a2a'`) as an AI SDK tool. **Deduped across the network when the remote is GNL:** runId is deterministic — `` a2a:${idempotencyKey ?? toolCallId} `` → a GNL remote's `runDurable` replays the same runId, so a second POST has no side effect (a standard A2A remote decides for itself what a repeated messageId does) ([at-most-once for the remote effect](../durable/README.md#what-never-charged-twice-actually-means)).

> **A runId has two shapes, and this one is deliberate.** Most runIds are opaque `run1_…` digests the engine mints from a caller's `workKey`. Engine-issued runs keep **readable composite ids** on purpose (`sched:`, `job:`, `a2a:`, `eval:`, `wf:`, `batch:`): the engine writes them itself, they are already deterministic, and nothing is stored that a hash would protect. `a2a:` in particular *must* stay readable — hashing it would make the two deployments derive different ids for the same call, and cross-network dedup is precisely what that would break. `idempotencyKey` is what `durableTool` injects (parent-run-scoped, so it is globally unique); the bare `toolCallId` is only the fallback for a plain AI SDK loop, where two different parent runs can emit the same short id (`call_1`) and collide. When wrapped in durableTool inside a parent `runDurable`, the remote call is skipped on parent resume.

> Install: `pnpm add @gnldev/a2a` on **both ends** of the call — or run both from a [repo clone](https://github.com/gnlhq/gnldev) (`pnpm install && pnpm -r build`).

```bash
npm i @gnldev/a2a   # peer: ai, zod
```

```ts
import { createA2ATool } from '@gnldev/a2a';

const tools = {
  research: createA2ATool({ endpoint: 'https://agents.internal', agentName: 'researcher' }),
};

// Router/parent agent calls the 'research' tool → POSTs to remote /agents/researcher/run.
await runDurable({ runId: 'parent-1', journal, model, tools, prompt: 'Research X' });
```

```ts
import { createA2ATool } from '@gnldev/a2a';

// Any A2A agent: the card is read from <endpoint>/.well-known/agent.json, then message/send.
const translate = createA2ATool({ protocol: 'a2a', endpoint: 'https://agents.example.com/agents/translator', agentName: 'translator' });
```

## API
- `createA2ATool({ protocol?, endpoint, agentName, description?, headers?, fetchImpl?, timeoutMs?, secret?, budgetGuard? })` → AI SDK tool
  - `protocol`: `'gnl'` (default) — `POST <endpoint>/agents/<agentName>/run` on a @gnldev/server.
    `'a2a'` — `endpoint` is the agent's base URL; the card is read once (`agent.json`, then
    `agent-card.json`) and each call is a JSON-RPC `message/send` to the card's `url`, with the same
    deterministic key as the messageId. A `Task`'s answer is its artifacts' text; `input-required` comes
    back as `interrupts`; `failed`, `canceled`, `rejected`, a state that is not an answer yet (`submitted`,
    `working`, `auth-required`, `unknown`) and a JSON-RPC error throw — a tool result is journaled as done,
    so only an answer may become one. `runId` in the result is the remote task id. The messageId is
    deterministic, but whether a retry runs again is the remote's: a GNL server answers it from its journal;
    measured, a standard A2A server ran the same key twice. `secret` is refused in this mode — send the agent's credential in `headers`.
  - `fetchImpl`: for test/custom transport (e.g. Hono `app.request`).
  - `timeoutMs`: remote-call timeout, default `30_000`. On expiry a `StepTimeoutError` is thrown, so the
    wrapping `durableTool` journals a `failed` record and the model sees the real error — never a silent hang.
  - `secret`: opt-in HMAC-SHA256 request signing. The request goes out with `x-gnl-timestamp` and
    `x-gnl-signature` over the timestamp, the method, the route and the body
    (`HMAC(secret, timestamp + '.' + 'POST /agents/<name>/run' + '.' + body)`), so a signed request is
    accepted only by the route it was made for. The remote verifies it via `createRestApi({}, { a2aSecret })`.
    Omit it and requests are unsigned. Both sides use one definition, exported here: `signA2ARequest`,
    `verifyA2ARequest`, `a2aSigningInput`.
  - `a2aSecret` requires a signature on every agent and workflow route of that API, so your own users'
    unsigned calls are refused there too. To serve both from one process, mount two APIs: one with
    `a2aSecret` for signed peers (e.g. under `/a2a`) and one without, behind your auth, for your users. The
    host strips the prefix before handing the request on; the signature covers the route without it.
  - `budgetGuard`: called *before* the fetch — typically `@gnldev/durable`'s `assertBudget`. It gates the
    call made **from this process** only; a2a cannot see or enforce the remote endpoint's own quota. Throwing
    propagates as-is. Omit it and no quota check happens.

## How it works
The tool POSTs to the remote REST endpoint with a deterministic runId. Since both the remote and parent are durable, there's no double-execution even across the network — deterministic for distributed agent calls.

## Whose run the remote run is
Inside a GNL run, the tool names the calling run's end user to the remote as `resourceId` — read from
the run's identity (`identityOf(options)`), never from the tool's input, so the model cannot name
someone else. Give the remote a credential that may act for your users:
- an **application** credential (`roleAuth`'s `client`): the remote run belongs to that user. Without a
  user (a staff or `unknown` run, or a call outside a GNL run) the remote refuses with 400, as it refuses
  any application that names nobody;
- an **operator** credential: the remote run belongs to the named user; with no user named, it is staff's.

A user credential ignores the name: a user speaks only for itself.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
