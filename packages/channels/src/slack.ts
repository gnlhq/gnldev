import { createHmac, timingSafeEqual } from 'node:crypto';
import { refuseConfigNames, type CreateGnlConfig } from '@gnldev/durable';
import { channelRuntime, runFor, postOnce, type ReplyTool } from './core.js';
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
  /** Where a run waiting for an approval can also be opened (`<studioUrl>/runs/<runId>`). */
  studioUrl?: string;
  /**
   * Who may answer an approval button. Default: only the person whose message started the run. Return
   * true to let someone else decide — a team lead, an on-call channel's members. Asked with the Slack ids
   * of the workspace, the person who clicked and the person who asked.
   */
  approvers?: (who: { teamId: string; userId: string; requesterId: string; toolName: string }) => boolean | Promise<boolean>;
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

const SLACK_CHANNEL_NAMES = optionNames<SlackChannelOptions>()(['signingSecret', 'botToken', 'agent', 'workspaces', 'studioUrl', 'approvers', 'worker', 'workerOptions', 'apiUrl', 'fetch', 'now']);
/** The queue job type an approval button's click becomes. */
export const SLACK_DECISION_JOB = 'gnl-slack-decision';
const APPROVE = 'gnl_approve';
const DENY = 'gnl_deny';
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

/** What an approval button carries back: the run's message, the call, and a MAC over both, so a value nobody signed decides nothing. */
interface Decision {
  teamId: string;
  eventId: string;
  channel: string;
  user: string;
  ts: string;
  threadTs?: string;
  toolCallId: string;
  toolName: string;
}
interface DecisionJob extends Decision { approve: boolean; by: string }

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
  const rt = channelRuntime('slackChannel', config, opts.agent);
  const now = opts.now ?? Date.now;
  const doFetch = opts.fetch ?? fetch;
  const api = (opts.apiUrl ?? 'https://slack.com/api').replace(/\/+$/, '');

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
  const replyTool = (channel: string, thread: string): ReplyTool => ({
    description: 'post the reply to Slack',
    execute: async (args: { text: string; blocks?: unknown[] }, options: Record<string, unknown>) => {
      const key = (options as { idempotencyKey?: string }).idempotencyKey ?? '';
      const out = await slack('chat.postMessage', {
        channel, thread_ts: thread, text: args.text, ...(args.blocks ? { blocks: args.blocks } : {}),
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

  const mac = (d: Decision) => createHmac('sha256', opts.signingSecret).update(JSON.stringify(['gnl-slack-decision', d.teamId, d.eventId, d.channel, d.user, d.ts, d.threadTs ?? null, d.toolCallId, d.toolName])).digest('base64url');

  /**
   * Runs (or continues) the message's run and posts what came of it: the answer, or — when it stopped for
   * an approval — one message per stop with an Approve and a Deny button for each call. The run is named
   * by the message's event id, so a decision continues the same run.
   */
  async function runAndAnswer(m: SlackJob | Decision, ctx: JobCtx, approvals?: Record<string, boolean>, prompt?: string): Promise<unknown> {
    const workspace = opts.workspaces[m.teamId];
    if (!workspace) return { ignored: 'workspace no longer listed' };
    const thread = m.threadTs ?? m.ts;
    const result = await runFor(rt, opts.agent, {
      workKey: `slack:${m.teamId}:${m.eventId}`,
      threadId: `slack:${m.teamId}:${m.channel}:${thread}:${m.user}`,
      subject: `slack:${m.teamId}:${m.user}`,
      ...(workspace.orgId ? { org: workspace.orgId } : {}),
      ...(prompt !== undefined ? { prompt } : {}),
      ...(approvals ? { approvals } : {}),
    });
    const asks = result.interrupts;
    const tool = replyTool(m.channel, thread);
    if (asks.length === 0) {
      await postOnce(ctx, tool, `slack-reply:${result.runId}`, { text: result.text?.trim() || '(no answer)' });
      return { runId: result.runId };
    }
    const studio = opts.studioUrl ? ` (or in Studio: ${opts.studioUrl.replace(/\/+$/, '')}/runs/${result.runId})` : '';
    const blocks: unknown[] = [{ type: 'section', text: { type: 'mrkdwn', text: `This needs an approval before I go on${studio}.` } }];
    for (const a of asks) {
      const d: Decision = { teamId: m.teamId, eventId: m.eventId, channel: m.channel, user: m.user, ts: m.ts, ...(m.threadTs ? { threadTs: m.threadTs } : {}), toolCallId: a.toolCallId, toolName: a.toolName };
      const value = JSON.stringify({ d, mac: mac(d) });
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*${a.toolName}* ${'`'}${JSON.stringify(a.args ?? {}).slice(0, 300)}${'`'}${a.reason ? `\n${a.reason}` : ''}` } });
      blocks.push({ type: 'actions', elements: [
        { type: 'button', style: 'primary', text: { type: 'plain_text', text: 'Approve' }, action_id: APPROVE, value },
        { type: 'button', style: 'danger', text: { type: 'plain_text', text: 'Deny' }, action_id: DENY, value },
      ] });
    }
    await postOnce(ctx, tool, `slack-ask:${result.runId}:${asks.map((a) => a.toolCallId).join(',')}`, { text: `This needs an approval before I go on${studio}.`, blocks });
    return { runId: result.runId, waiting: asks.map((a) => a.toolCallId) };
  }

  const runMessage = (payload: SlackJob, ctx: JobCtx) => runAndAnswer(payload, ctx, undefined, payload.text);
  const runDecision = (payload: DecisionJob, ctx: JobCtx) => runAndAnswer(payload, ctx, { [payload.toolCallId]: payload.approve });

  /** A click on an approval button: checked, then queued once per call — the first decision on a call is the one. */
  async function decide(raw: string): Promise<Response> {
    let p: { type?: string; team?: { id?: string }; user?: { id?: string }; actions?: Array<{ action_id?: string; value?: string }> };
    try { p = JSON.parse(new URLSearchParams(raw).get('payload') ?? ''); } catch { return new Response('not a payload', { status: 400 }); }
    const action = p.actions?.[0];
    if (p.type !== 'block_actions' || !action || (action.action_id !== APPROVE && action.action_id !== DENY)) return new Response(null, { status: 200 });
    let d: Decision;
    try {
      const v = JSON.parse(action.value ?? '') as { d: Decision; mac: string };
      const want = Buffer.from(mac(v.d)), got = Buffer.from(String(v.mac));
      if (got.length !== want.length || !timingSafeEqual(got, want)) return new Response('invalid decision', { status: 401 });
      d = v.d;
    } catch { return new Response('invalid decision', { status: 401 }); }
    const by = p.user?.id;
    const workspace = opts.workspaces[d.teamId];
    if (!by || !workspace || p.team?.id !== d.teamId) return new Response(null, { status: 200 });
    const allowed = by === d.user || (opts.approvers ? await opts.approvers({ teamId: d.teamId, userId: by, requesterId: d.user, toolName: d.toolName }) : false);
    if (!allowed) return Response.json({ response_type: 'ephemeral', replace_original: false, text: `Only <@${d.user}>${opts.approvers ? ' or an approver' : ''} can answer this.` });
    const job: DecisionJob = { ...d, approve: action.action_id === APPROVE, by };
    await enqueue(rt.work, SLACK_DECISION_JOB, job, {
      id: `slack:${d.teamId}:decide:${d.eventId}:${d.toolCallId}`,
      resourceId: `slack:${d.teamId}:${d.user}`,
      ...(workspace.orgId ? { orgId: workspace.orgId } : {}),
    });
    return new Response(null, { status: 200 });
  }

  let worker: Worker | undefined;
  const ensureWorker = () => (worker ??= createWorker(rt.storage, { [SLACK_JOB]: runMessage as never, [SLACK_DECISION_JOB]: runDecision as never }, opts.workerOptions));
  if (opts.worker !== false) ensureWorker().start();

  return {
    async handle(req: Request): Promise<Response> {
      const raw = await req.text();
      if (!verifySlackSignature(raw, req.headers, opts.signingSecret, now())) return new Response('invalid signature', { status: 401 });
      // A button click arrives form-encoded (Interactivity), an event as JSON (Event Subscriptions).
      if ((req.headers.get('content-type') ?? '').startsWith('application/x-www-form-urlencoded')) return decide(raw);
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
      await enqueue(rt.work, SLACK_JOB, job, {
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
