import {
  createGnl, scopeConfigToOrg, sealRequestContext, sealFieldsOf, user, withIdempotency,
  type CreateGnlConfig, type Storage, type Interrupt,
} from '@gnldev/durable';
import type { JobCtx } from '@gnldev/queue';

/** A tool the reply is posted through: `execute` posts; `recover`, when the platform can tell, settles a post cut off mid-flight. */
export interface ReplyTool {
  description: string;
  execute(args: { text: string; blocks?: unknown; markup?: unknown }, options: Record<string, unknown>): Promise<unknown>;
  recover?(input: unknown, o: { idempotencyKey: string; toolCallId: string }): Promise<{ done: true; output: unknown } | { done: false }>;
}

/** What every channel shares: the config it runs, a GNL instance per organization, and the store its jobs live in. */
export interface ChannelRuntime {
  storage: Storage;
  work: NonNullable<Storage['work']>;
  /** One instance per organization, over that organization's partition — as every door does. */
  gnlFor(org: string | undefined): ReturnType<typeof createGnl>;
}

/** Checks a channel's agent and store (its config's names are checked by the channel), and builds what every channel shares. @internal — channel plumbing. */
export function channelRuntime(where: string, config: CreateGnlConfig, agent: string): ChannelRuntime {
  if (!config.agents?.[agent]) throw new TypeError(`@gnldev/channels: ${where}'s agent '${agent}' is not in the config's \`agents\``);
  const storage = (config as { storage?: Storage }).storage;
  if (!storage?.work) throw new TypeError(`@gnldev/channels: ${where} needs a config with \`storage\` — its messages are queue jobs in the store`);
  const gnls = new Map<string, ReturnType<typeof createGnl>>();
  return {
    storage,
    work: storage.work,
    gnlFor(org) {
      const key = org ?? '';
      let g = gnls.get(key);
      if (!g) gnls.set(key, (g = createGnl(org ? scopeConfigToOrg(config, org).config : config)));
      return g;
    },
  };
}

/**
 * Runs — or, with `approvals`, continues — a message's run for its sender, in their organization. The run
 * is named by the platform's id for the message (`workKey`), so a job retried after a crash, or a
 * decision on an approval, lands on the same run. @internal — channel plumbing.
 */
export async function runFor(rt: ChannelRuntime, agent: string, m: {
  workKey: string; threadId: string; subject: string; org?: string; prompt?: string; approvals?: Record<string, boolean>;
}): Promise<{ runId: string; text?: string; interrupts: Interrupt[] }> {
  const caller = user(m.subject, m.org);
  const result = await rt.gnlFor(m.org).run(agent, {
    workKey: m.workKey,
    ...(m.prompt !== undefined ? { prompt: m.prompt } : {}),
    threadId: m.threadId,
    caller,
    context: sealRequestContext({}, sealFieldsOf(caller, m.org)),
    ...(m.approvals ? { approvals: m.approvals } : {}),
  }) as { runId: string; text?: string; interrupts?: Interrupt[] };
  return { runId: result.runId, text: result.text, interrupts: result.interrupts ?? [] };
}

/**
 * Posts once, under `key`: a recorded tool call in the job's journal. A post cut off mid-flight is settled
 * by the tool's `recover` when it has one, and left in doubt when it has not — never sent twice.
 * @internal — channel plumbing.
 */
export async function postOnce(ctx: JobCtx, tool: ReplyTool, key: string, message: { text: string; blocks?: unknown; markup?: unknown }): Promise<void> {
  const { reply } = withIdempotency({ reply: tool } as never, { journal: ctx.journal, window: 'run', runId: ctx.runId, key: () => key, caller: ctx.caller });
  await (reply as { execute: (a: unknown, o: unknown) => Promise<unknown> }).execute(message, { toolCallId: key, messages: [] });
}
