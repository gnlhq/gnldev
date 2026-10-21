import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  createGnl, scopeConfigToOrg, sealRequestContext, sealFieldsOf, user, withIdempotency, refuseConfigNames,
  type CreateGnlConfig, type Storage,
} from '@gnldev/durable';
import { enqueue, createWorker, type JobCtx, type Worker, type QueueWorkerOptions } from '@gnldev/queue';
import { refuseUnknownNames, optionNames } from '@gnldev/options';

/** Which organization a Slack workspace's messages run in. `{}` is the root partition (no organization). */
export interface SlackWorkspace {
  orgId?: string;
}

export interface SlackChannelOptions {
  /** The app's Signing Secret (Slack app → Basic Information). Every request is checked against it. */
  signingSecret: string;
  /** The bot token (`xoxb-…`), sent as `Authorization: Bearer` to `chat.postMessage`. Never in an error message. */
  botToken: string;
  /** The agent that answers, by its name in the config's `agents`. */
  agent: string;
  /**
   * The workspaces this channel answers, by team id (`T…`), and the organization each runs in. A
   * workspace not listed is ignored: its messages are acknowledged and never run — a mapping you did
   * not write cannot put a stranger's workspace into one of your organizations.
   */
  workspaces: Record<string, SlackWorkspace>;
  /** Where a run waiting for an approval can be opened (`<studioUrl>/runs/<runId>`); without it the reply names the run id. */
  studioUrl?: string;
  /** Start a queue worker in this process (default true). `false` when workers run elsewhere — then call `worker()` there. */
  worker?: boolean;
  /** The worker's options (retries, delays, concurrency) — `@gnldev/queue`'s `QueueWorkerOptions`. */
  workerOptions?: QueueWorkerOptions;
  /** Test/DI: Slack's Web API base (default `https://slack.com/api`). */
  apiUrl?: string;
  /** Test/DI: the fetch used for the Web API. */
  fetch?: typeof fetch;
  /** Test/DI: the clock, in ms, for the request-age check. */
  now?: () => number;
}

const SLACK_CHANNEL_NAMES = optionNames<SlackChannelOptions>()(['signingSecret', 'botToken', 'agent', 'workspaces', 'studioUrl', 'worker', 'workerOptions', 'apiUrl', 'fetch', 'now']);
/** The metadata event type a reply carries, with its idempotency key: how a cut-off post is found again. */
export const SLACK_REPLY_EVENT = 'gnl_reply';
/** A request older (or newer) than this is refused: Slack's own replay bound. */
export const SLACK_MAX_AGE_SEC = 5 * 60;
/** The queue job type every Slack message becomes. */
export const SLACK_JOB = 'gnl-slack-message';

/** A Slack message as the worker needs it. */
interface SlackJob {
  teamId: string;
  eventId: string;
  channel: string;
  user: string;
  text: string;
  ts: string;
  threadTs?: string;
}

/**
 * Whether a request carries Slack's signature for this body: `v0=` HMAC-SHA256 of `v0:<timestamp>:<raw
 * body>` under the signing secret, the timestamp within `SLACK_MAX_AGE_SEC` of now. Compared in
 * constant time. https://api.slack.com/authentication/verifying-requests-from-slack
 */
export function verifySlackSignature(rawBody: string, headers: Headers, signingSecret: string, nowMs: number): boolean {
  const ts = headers.get('x-slack-request-timestamp');
  const sig = headers.get('x-slack-signature');
  if (!ts || !sig || !/^\d+$/.test(ts)) return false;
  if (Math.abs(nowMs / 1000 - Number(ts)) > SLACK_MAX_AGE_SEC) return false;
  const expected = Buffer.from(`v0=${createHmac('sha256', signingSecret).update(`v0:${ts}:${rawBody}`).digest('hex')}`);
  const given = Buffer.from(sig);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** What a Slack message's text asks, without the mention of the bot that opens it. */
const askedText = (text: string) => text.replace(/^\s*<@[A-Z0-9]+>\s*/, '').trim();

/**
 * A Slack channel for one agent: `handle(request)` is the Events API endpoint (mount it at the URL the
 * Slack app's Event Subscriptions point to), and a queue worker runs the messages.
 *
 * What it promises, and how:
 * - Only Slack is heard: a request without a valid signature, or older than five minutes, is 401.
 * - A message is run once: it becomes a queue job named by Slack's event id, so Slack redelivering it
 *   (it retries when an answer is slow or fails) finds the same job; the job runs the agent under a
 *   `workKey` from the same id, so a job retried after a crash lands on the same run and its tools do
 *   not run twice.
 * - The reply is sent at most once: the post to Slack is a tool call recorded in the job's journal
 *   under the run's id. A post cut off mid-flight is left in doubt, never sent again blindly.
 * - Each person's conversation is their own: the GNL thread is the Slack thread AND the person
 *   (`slack:<team>:<channel>:<thread>:<user>`), the run is theirs (`slack:<team>:<user>`), in the
 *   organization their workspace maps to.
 * - Slack gets its answer at once (it wants one within 3 s); the run goes on in the worker, which needs a
 *   process that stays up (not a function that freezes when the response is sent).
 */
export function slackChannel(config: CreateGnlConfig, opts: SlackChannelOptions): {
  handle(req: Request): Promise<Response>;
  /** The queue worker running this channel's messages (started unless `worker: false`). */
  worker(): Worker;
  close(): Promise<void>;
} {
  refuseConfigNames('slackChannel: config', config);
  refuseUnknownNames('slackChannel', opts, SLACK_CHANNEL_NAMES);
  for (const k of ['signingSecret', 'botToken', 'agent'] as const) {
    if (typeof opts[k] !== 'string' || opts[k] === '') throw new TypeError(`@gnldev/channels: slackChannel needs \`${k}\``);
  }
  if (!config.agents?.[opts.agent]) throw new TypeError(`@gnldev/channels: slackChannel's agent '${opts.agent}' is not in the config's \`agents\``);
  const storage = (config as { storage?: Storage }).storage;
  if (!storage?.work) throw new TypeError('@gnldev/channels: slackChannel needs a config with `storage` — its messages are queue jobs in the store');
  const now = opts.now ?? Date.now;
  const doFetch = opts.fetch ?? fetch;
  const api = (opts.apiUrl ?? 'https://slack.com/api').replace(/\/+$/, '');

  // One instance per organization, over that organization's partition — as every door does.
  const gnls = new Map<string, ReturnType<typeof createGnl>>();
  const gnlFor = (org: string | undefined) => {
    const key = org ?? '';
    let g = gnls.get(key);
    if (!g) gnls.set(key, (g = createGnl(org ? scopeConfigToOrg(config, org).config : config)));
    return g;
  };

  async function slack(method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await doFetch(`${api}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${opts.botToken}` },
      body: JSON.stringify(body),
    });
    const out = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || !out.ok) throw new Error(`@gnldev/channels: Slack ${method} failed: ${res.status} ${out.error ?? ''}`.trim());
    return out;
  }

  /**
   * The reply as a side-effecting tool. `recover` is how a post cut off mid-flight is settled without
   * guessing: the reply carries its idempotency key in Slack's message metadata, so the thread is read
   * for it — there: it was posted, record it; not there: it never was, post it. A post is never sent
   * twice, and a lost connection does not lose the reply.
   */
  const replyTool = (channel: string, thread: string) => ({
    description: 'post the reply to Slack',
    execute: async (args: { text: string }, options: { gnl?: { idempotencyKey?: string } } & Record<string, unknown>) => {
      const key = (options as { idempotencyKey?: string }).idempotencyKey ?? '';
      const out = await slack('chat.postMessage', {
        channel, thread_ts: thread, text: args.text,
        metadata: { event_type: SLACK_REPLY_EVENT, event_payload: { key } },
      });
      return { ts: out.ts };
    },
    recover: async (_input: unknown, o: { idempotencyKey: string }) => {
      const out = await slack('conversations.replies', { channel, ts: thread, include_all_metadata: true, limit: 200 });
      const found = ((out.messages ?? []) as Array<{ ts?: string; metadata?: { event_type?: string; event_payload?: { key?: string } } }>)
        .find((m) => m.metadata?.event_type === SLACK_REPLY_EVENT && m.metadata.event_payload?.key === o.idempotencyKey);
      return found ? { done: true as const, output: { ts: found.ts } } : { done: false as const };
    },
  });

  async function runMessage(payload: SlackJob, ctx: JobCtx): Promise<unknown> {
    const workspace = opts.workspaces[payload.teamId];
    if (!workspace) return { ignored: 'workspace no longer listed' };
    const org = workspace.orgId;
    const subject = `slack:${payload.teamId}:${payload.user}`;
    const caller = user(subject, org);
    const thread = payload.threadTs ?? payload.ts;
    const result = await gnlFor(org).run(opts.agent, {
      workKey: `slack:${payload.teamId}:${payload.eventId}`,
      prompt: payload.text,
      threadId: `slack:${payload.teamId}:${payload.channel}:${thread}:${payload.user}`,
      caller,
      context: sealRequestContext({}, sealFieldsOf(caller, org)),
    }) as { runId: string; text?: string; status?: string; interrupts?: unknown[] };
    const waiting = (result.interrupts?.length ?? 0) > 0 || result.status === 'suspended';
    const text = waiting
      ? `This needs an approval before I go on — ${opts.studioUrl ? `${opts.studioUrl.replace(/\/+$/, '')}/runs/${result.runId}` : `run ${result.runId}`}`
      : result.text?.trim() || '(no answer)';
    // The post, once: a tool call recorded in this job's journal under the run's id.
    const { reply } = withIdempotency({ reply: replyTool(payload.channel, thread) } as never, {
      journal: ctx.journal, window: 'run', runId: ctx.runId, key: () => `slack-reply:${result.runId}`, caller: ctx.caller,
    });
    await (reply as { execute: (a: unknown, o: unknown) => Promise<unknown> }).execute({ text }, { toolCallId: `slack-reply:${result.runId}`, messages: [] });
    return { runId: result.runId, waiting };
  }

  let worker: Worker | undefined;
  const ensureWorker = () => (worker ??= createWorker(storage, { [SLACK_JOB]: runMessage as never }, opts.workerOptions));
  if (opts.worker !== false) ensureWorker().start();

  return {
    async handle(req: Request): Promise<Response> {
      const raw = await req.text();
      if (!verifySlackSignature(raw, req.headers, opts.signingSecret, now())) return new Response('invalid signature', { status: 401 });
      let body: { type?: string; challenge?: string; team_id?: string; event_id?: string; event?: Record<string, unknown> };
      try { body = JSON.parse(raw); } catch { return new Response('not JSON', { status: 400 }); }
      if (body.type === 'url_verification') return Response.json({ challenge: body.challenge });
      if (body.type !== 'event_callback' || !body.event || !body.team_id || !body.event_id) return new Response(null, { status: 200 });
      const e = body.event as { type?: string; channel_type?: string; subtype?: string; bot_id?: string; user?: string; text?: string; channel?: string; ts?: string; thread_ts?: string };
      // What is asked of the bot: a mention, or a direct message. Not its own messages, not edits or joins.
      const asked = e.type === 'app_mention' || (e.type === 'message' && e.channel_type === 'im');
      if (!asked || e.subtype || e.bot_id || !e.user || !e.channel || !e.ts || typeof e.text !== 'string') return new Response(null, { status: 200 });
      const workspace = opts.workspaces[body.team_id];
      // Acknowledged either way — a non-2xx would only make Slack send it again.
      if (!workspace) return new Response(null, { status: 200 });
      const job: SlackJob = {
        teamId: body.team_id, eventId: body.event_id, channel: e.channel, user: e.user, text: askedText(e.text), ts: e.ts,
        ...(e.thread_ts ? { threadTs: e.thread_ts } : {}),
      };
      await enqueue(storage.work!, SLACK_JOB, job, {
        id: `slack:${body.team_id}:${body.event_id}`,
        resourceId: `slack:${body.team_id}:${e.user}`,
        ...(workspace.orgId ? { orgId: workspace.orgId } : {}),
      });
      return new Response(null, { status: 200 });
    },
    worker: ensureWorker,
    async close() { await worker?.close(); },
  };
}
