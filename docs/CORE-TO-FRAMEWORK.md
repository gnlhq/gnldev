# From the core to the whole framework

**English** · [Türkçe](./CORE-TO-FRAMEWORK.tr.md)

GNL is a full agent framework, and every part of it stands on one durable core. You can start with the
core alone, inside an agent you already have, and take the rest one step at a time. Each step below
keeps what the step before it gave you and adds to it; none of them asks you to rewrite your agent.

| Step | You add | You get |
|---|---|---|
| 1. The core | `runDurable` instead of `generateText` | a tool call never fired twice; a crashed run resumes where it stopped |
| 2. A registry | `createGnl` | agents by name, work named by your id (`workKey`), runs that outlive their caller, approvals |
| 3. A server | `createRestApi` | REST + OpenAPI + SSE for every agent, auth, limits, budgets |
| 4. Studio | `createStudioApp` | every run on a timeline, time-travel and fork, the approval queue, a playground |
| 5. The packages | what you need | memory, workflows, RAG, evals, MCP, queue, scheduler, channels — each with the core's guarantees |

## 1. The core — inside the agent you already have

The arguments are `generateText`'s; the additions are an id for this piece of work and a journal.

```ts
import { runDurable, gnlTool } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { openai } from '@ai-sdk/openai';
import { tool } from 'ai';
import { z } from 'zod';

const storage = new SqliteStorage('runs.db');

const refund = gnlTool(
  tool({
    description: 'Refund an order',
    inputSchema: z.object({ orderId: z.string() }),
    execute: async ({ orderId }) => ({ refunded: orderId }),
  }),
  { sideEffect: true, idempotency: 'args' },
);

const res = await runDurable({
  runId: 'refund-order-42',          // the id of THIS work — call again with it after a crash
  journal: storage.runs,
  model: openai('gpt-4o'),
  tools: { refund },
  prompt: 'Refund order 42',
});
console.log(res.text);
```

What it guarantees, exactly — and where it stops: [what "never charged twice" means](../packages/durable/README.md#what-never-charged-twice-actually-means).

## 2. A registry — agents by name, work by your id

Name the agent once; name each piece of work with your own id (an order, a ticket) and the engine
derives the run from it. A run now executes apart from the call that started it: a closed tab or a
dropped connection ends the reading, not the run.

```ts
import { createGnl } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { openai } from '@ai-sdk/openai';

const storage = new SqliteStorage('runs.db');
const config = {
  storage,
  agents: {
    support: { model: openai('gpt-4o'), system: 'You handle refunds. Ask before you refund.', tools: {} },
  },
};
const gnl = createGnl(config);

const r = await gnl.run('support', { workKey: 'order-42', prompt: 'Refund order 42', resourceId: 'customer-7' });
console.log(r.text);
```

More: [work identity](../packages/durable/README.md#work-identity-workkey) ·
[a run outlives its caller](../packages/durable/README.md#a-run-outlives-its-caller-creategnl).

## 3. A server — every agent over HTTP

The same `config` becomes a REST API with OpenAPI and server-sent events. In production it refuses to
start without auth.

```ts
import { createRestApi } from '@gnldev/server';
import { roleAuth } from '@gnldev/auth';
import { serve } from '@hono/node-server';

declare const config: Parameters<typeof createRestApi>[0]; // the object from step 2

const api = createRestApi(config, {
  title: 'Support agents',
  auth: roleAuth({ client: { token: process.env.GNL_CLIENT_TOKEN } }),
});
serve({ fetch: api.fetch, port: 3000 }); // POST /agents/support/run, /agents/support/stream, /openapi.json
```

On Express, Fastify, Koa or Next.js: [binding it to a Node server](../packages/server/README.md#binding-it-to-a-node-server).

## 4. Studio — watch, approve, go back in time

Studio reads the same journal: every run on a timeline, the calls waiting for approval, time-travel and
fork, and a playground that runs your registered agents.

```bash
npx gnl studio --config gnl.config.ts   # Studio + the playground for the agents in your config
```

To mount it inside your own server: [`@gnldev/studio`](../packages/studio/README.md).

## 5. The packages — take what you need

Each package works with the rest and on its own, and a tool or a step it adds is journaled like the
core's: replayed after a crash, never fired twice.

| Need | Package |
|---|---|
| Conversation history, working memory, recall | [`@gnldev/memory`](../packages/memory/README.md) |
| Multi-step processes with retries | [`@gnldev/workflow`](../packages/workflow/README.md) |
| Answers from your documents | [`@gnldev/rag`](../packages/rag/README.md) |
| Quality measured, a gate in CI | [`@gnldev/evals`](../packages/evals/README.md) |
| External tools over MCP | [`@gnldev/mcp`](../packages/mcp/README.md) |
| Background jobs, schedules, events | [`@gnldev/queue`](../packages/queue/README.md) · [`@gnldev/scheduler`](../packages/scheduler/README.md) · [`@gnldev/events`](../packages/events/README.md) |
| Agents on Slack and Telegram | [`@gnldev/channels`](../packages/channels/README.md) |
| A typed client and React hooks | [`@gnldev/client`](../packages/client/README.md) |

Starting from nothing instead: `npm create gnl@latest my-agent` scaffolds steps 2 to 4 in one go.
