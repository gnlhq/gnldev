import { timingSafeEqual } from 'node:crypto';
import { refuseConfigNames, type CreateGnlConfig } from '@gnldev/durable';
import { enqueue, createWorker, type JobCtx, type Worker, type QueueWorkerOptions } from '@gnldev/queue';
import { refuseUnknownNames, optionNames } from '@gnldev/options';
import { channelRuntime, runFor, postOnce, type ReplyTool } from './core.js';

export interface TelegramChannelOptions {
  /** The bot's token from @BotFather (`123456:ABC…`). Telegram puts it in every call's URL; it is never in an error message. */
  botToken: string;
  /**
   * The webhook's `secret_token` (set with `setWebhook`): Telegram sends it on every update, and an update
   * without it is 401. 1–256 characters of `A-Z a-z 0-9 _ -`.
   */
  secretToken: string;
  /** The agent that answers, by its name in the config's `agents`. */
  agent: string;
  /**
   * Which chats this bot answers, and the organization each runs in: `{}` for the root partition,
   * `{ orgId }` for an organization, `undefined` to ignore the chat. Asked with the chat and the sender
   * Telegram reports — a bot is reachable by anyone who finds it, so this is where you say who is served.
   */
  chats: (chat: { id: number; type: string }, from: { id: number }) => { orgId?: string } | undefined | Promise<{ orgId?: string } | undefined>;
  /** Where a run waiting for an approval can be opened (`<studioUrl>/runs/<runId>`). */
  studioUrl?: string;
  /** Start a queue worker in this process (default true). `false` when workers run elsewhere — then call `worker()` there. */
  worker?: boolean;
  /** The worker's options (retries, delays, concurrency) — `@gnldev/queue`'s `QueueWorkerOptions`. */
  workerOptions?: QueueWorkerOptions;
  /** Test/DI: the Bot API base (default `https://api.telegram.org`). */
  apiUrl?: string;
  /** Test/DI: the fetch used for the Bot API. */
  fetch?: typeof fetch;
}

const TELEGRAM_CHANNEL_NAMES = optionNames<TelegramChannelOptions>()(['botToken', 'secretToken', 'agent', 'chats', 'studioUrl', 'worker', 'workerOptions', 'apiUrl', 'fetch']);
/** The queue job type every Telegram message becomes. */
export const TELEGRAM_JOB = 'gnl-telegram-message';

interface TelegramJob {
  updateId: number;
  chatId: number;
  chatType: string;
  userId: number;
  messageId: number;
  threadId?: number;
  text: string;
  orgId?: string;
}

/**
 * A Telegram channel for one agent: `handle(request)` is the bot's webhook (`setWebhook` with
 * `secret_token`), and a queue worker runs the messages.
 *
 * What it promises — Slack's, with one difference:
 * - Only Telegram is heard: an update without the webhook's secret token is 401.
 * - A chat `chats` does not answer is not run; the organization comes from `chats`, never a message.
 * - A message is run once: it becomes a queue job named by Telegram's `update_id`, so Telegram
 *   redelivering it (it retries until it gets a 2xx) finds the same job, and the run is named the same.
 * - Each person's conversation is their own: the GNL thread is the chat (and forum topic) and the person.
 * - The reply is posted AT MOST once — the difference: a bot cannot read a chat's history, so a post
 *   whose connection was cut cannot be looked up, and it is left in doubt rather than sent again.
 */
export function telegramChannel(config: CreateGnlConfig, opts: TelegramChannelOptions): {
  handle(req: Request): Promise<Response>;
  /** The queue worker running this channel's messages (started unless `worker: false`). */
  worker(): Worker;
  close(): Promise<void>;
} {
  refuseConfigNames('telegramChannel: config', config);
  refuseUnknownNames('telegramChannel', opts, TELEGRAM_CHANNEL_NAMES);
  if (typeof opts.botToken !== 'string' || !/^\d+:[A-Za-z0-9_-]+$/.test(opts.botToken)) throw new TypeError('@gnldev/channels: telegramChannel needs `botToken`, the `<id>:<secret>` @BotFather gave');
  if (typeof opts.secretToken !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(opts.secretToken)) throw new TypeError('@gnldev/channels: telegramChannel needs `secretToken`, 1–256 characters of A-Z a-z 0-9 _ -');
  if (typeof opts.chats !== 'function') throw new TypeError('@gnldev/channels: telegramChannel needs `chats`, which says which chats are answered');
  const rt = channelRuntime('telegramChannel', config, opts.agent);
  const botId = opts.botToken.split(':')[0]!;
  const doFetch = opts.fetch ?? fetch;
  const api = (opts.apiUrl ?? 'https://api.telegram.org').replace(/\/+$/, '');

  async function call(method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await doFetch(`${api}/bot${opts.botToken}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    } catch (e) {
      // The URL carries the token: say what failed without it.
      throw new Error(`@gnldev/channels: Telegram ${method} failed: ${String((e as Error)?.message ?? e).split(opts.botToken).join('<token>')}`);
    }
    const out = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string; result?: Record<string, unknown> };
    if (!res.ok || !out.ok) throw new Error(`@gnldev/channels: Telegram ${method} failed: ${res.status} ${out.description ?? ''}`.trim());
    return out.result ?? {};
  }

  // No `recover`: a bot cannot read back what it sent, so a cut-off post stays in doubt (never resent).
  const replyTool = (job: TelegramJob): ReplyTool => ({
    description: 'send the reply to Telegram',
    execute: async (args) => call('sendMessage', {
      chat_id: job.chatId, text: args.text,
      reply_parameters: { message_id: job.messageId, allow_sending_without_reply: true },
      ...(job.threadId !== undefined ? { message_thread_id: job.threadId } : {}),
    }),
  });

  async function runMessage(job: TelegramJob, ctx: JobCtx): Promise<unknown> {
    const result = await runFor(rt, opts.agent, {
      workKey: `telegram:${botId}:${job.updateId}`,
      threadId: `telegram:${botId}:${job.chatId}:${job.threadId ?? 0}:${job.userId}`,
      subject: `telegram:${botId}:${job.userId}`,
      ...(job.orgId ? { org: job.orgId } : {}),
      prompt: job.text,
    });
    const text = result.interrupts.length > 0
      ? `This needs an approval before I go on — ${opts.studioUrl ? `${opts.studioUrl.replace(/\/+$/, '')}/runs/${result.runId}` : `run ${result.runId}`}`
      : result.text?.trim() || '(no answer)';
    await postOnce(ctx, replyTool(job), `telegram-reply:${result.runId}`, { text });
    return { runId: result.runId };
  }

  let worker: Worker | undefined;
  const ensureWorker = () => (worker ??= createWorker(rt.storage, { [TELEGRAM_JOB]: runMessage as never }, opts.workerOptions));
  if (opts.worker !== false) ensureWorker().start();
  const secret = Buffer.from(opts.secretToken);

  return {
    async handle(req: Request): Promise<Response> {
      const given = Buffer.from(req.headers.get('x-telegram-bot-api-secret-token') ?? '');
      if (given.length !== secret.length || !timingSafeEqual(given, secret)) return new Response('invalid secret token', { status: 401 });
      let u: { update_id?: number; message?: { message_id?: number; message_thread_id?: number; from?: { id?: number; is_bot?: boolean }; chat?: { id?: number; type?: string }; text?: string } };
      try { u = (await req.json()) as typeof u; } catch { return new Response('not JSON', { status: 400 }); }
      const m = u.message;
      // A person's text message. Not a bot's, not an edit (`edited_message` is another field), not media.
      if (typeof u.update_id !== 'number' || !m || typeof m.text !== 'string' || m.from?.is_bot || typeof m.from?.id !== 'number'
        || typeof m.chat?.id !== 'number' || typeof m.message_id !== 'number') return new Response(null, { status: 200 });
      const served = await opts.chats({ id: m.chat.id, type: m.chat.type ?? 'private' }, { id: m.from.id });
      // Acknowledged either way — a non-2xx would only make Telegram send it again.
      if (!served) return new Response(null, { status: 200 });
      const job: TelegramJob = {
        updateId: u.update_id, chatId: m.chat.id, chatType: m.chat.type ?? 'private', userId: m.from.id, messageId: m.message_id, text: m.text,
        ...(m.message_thread_id !== undefined ? { threadId: m.message_thread_id } : {}),
        ...(served.orgId ? { orgId: served.orgId } : {}),
      };
      await enqueue(rt.work, TELEGRAM_JOB, job, {
        id: `telegram:${botId}:${u.update_id}`,
        resourceId: `telegram:${botId}:${m.from.id}`,
        ...(served.orgId ? { orgId: served.orgId } : {}),
      });
      return new Response(null, { status: 200 });
    },
    worker: ensureWorker,
    async close() { await worker?.close(); },
  };
}
