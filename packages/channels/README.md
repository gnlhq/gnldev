# @gnldev/channels

Agents on chat platforms. Slack today; Telegram next.

A message comes in through the platform's signed webhook and becomes a durable job in your store; the
job runs the agent once and posts the reply once. A platform that redelivers a message — Slack does,
when an answer is slow or fails — finds the same job. No Redis: the queue is the store.

> Install: `pnpm add @gnldev/channels` — or use it from a [repo clone](https://github.com/gnlhq/gnldev): `pnpm install && pnpm -r build`.

```bash
npm i @gnldev/channels   # with @gnldev/durable and @gnldev/queue
```

## Slack

```ts
import { slackChannel } from '@gnldev/channels';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import type { CreateGnlConfig } from '@gnldev/durable';

declare const agents: CreateGnlConfig['agents'];

const slack = slackChannel({ storage: new SqliteStorage('runs.db'), agents }, {
  signingSecret: process.env.SLACK_SIGNING_SECRET!,
  botToken: process.env.SLACK_BOT_TOKEN!,           // xoxb-…, never in an error message
  agent: 'support',
  workspaces: { T0123ABCD: { orgId: 'acme' } },      // which workspace runs in which organization
  studioUrl: 'https://studio.acme.example',          // where a run waiting for an approval is opened
});

// Mount it where the Slack app's Event Subscriptions point, in any server:
export const handleSlack = (req: Request) => slack.handle(req);
```

Set up the Slack app: **Event Subscriptions** on, the request URL your mount (Slack checks it with a
challenge the channel answers), bot events `app_mention` and `message.im`; **OAuth scopes**
`app_mentions:read`, `chat:write`, `im:history`, and `channels:history` / `groups:history` for the
channels the bot is mentioned in (the reply is looked up there after a lost connection — below).

### What it promises

- **Only Slack is heard.** A request without Slack's signature for its body, or older than five
  minutes, is 401.
- **A workspace you did not list is not run.** Its messages are acknowledged (so Slack stops sending
  them) and dropped. The organization a workspace runs in comes from `workspaces`, never from a message.
- **A message is run once.** It becomes a queue job named by Slack's event id; a redelivery finds the
  same job. The job runs the agent under a `workKey` from the same id, so a job retried after a crash
  lands on the same run, and its tools do not run twice.
- **The reply is posted once.** The post is a tool call recorded in the job's journal. It carries its
  idempotency key in Slack's message metadata, so a post whose connection was cut is settled by reading
  the thread: found, it was posted; not found, it is posted now. Never twice, and not lost to a cut
  connection (a Slack that keeps failing past the job's retries leaves the job in the dead letters).
- **Each person's conversation is their own.** The GNL thread is the Slack thread and the person, and
  the run is theirs (`slack:<team>:<user>`): in a thread two people share, neither run reads the other's
  messages.
- **Slack gets its answer at once.** Slack wants one within 3 seconds; the agent runs in the queue's
  worker afterwards. That needs a process that stays up — a server, a container — not a function that
  freezes once the response is sent. With `worker: false` the worker runs elsewhere: call
  `slack.worker().start()` in that process (`workerOptions` takes `@gnldev/queue`'s worker options).
  `apiUrl`, `fetch` and `now` exist for tests: Slack's Web API address, the fetch used, the clock.
- **A run waiting for an approval says so** in the thread, once, with the run to open in Studio
  (`studioUrl`). It goes on when it is approved there, but its answer is then in Studio only: the
  channel does not yet post an answer that comes after an approval.

Not yet: approving from Slack itself (buttons) and posting the answer that follows an approval, a
thread shared by everyone in it, Telegram.

## License

Apache-2.0
