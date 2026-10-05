import { childIdentity, identityOf, requestOf, type RunIdentity } from './run-identity.js';
import { nestedAgentRunId } from './journal.js';
import { tool, stepCountIs } from 'ai';
import type { Tool } from 'ai';
import { z } from 'zod';
import { runDurable } from './run.js';
import { readRunTaint, markRunTainted } from './taint.js';
import type { Journal } from './journal.js';
import type { Guard, Interrupt } from './guard.js';
import { addressedInterrupt as addressed, approvalsForChild } from './guard.js';
import type { ModelInput, ToolSet } from './types.js';
import type { RunLimits } from './limits.js';
import { registerSubRun } from './limits.js';
import { refuseUnknownNames } from '@gnldev/options';
import { AGENT_TOOL_NAMES, REMOVED_AGENT_TOOL_NAMES, refuseRunLimitNames, AGENT_TOOL_OPTS_NAMES } from './option-names.js';

/**
 * carry taint across the sub-agent runId boundary. Taint is keyed per-run, so a nested run
 * (`agent:${toolCallId}`) starts CLEAN even when its parent is tainted — a side effect inside the
 * sub-agent would then bypass the parent's `taintedSideEffects` ladder. If the parent is tainted at the
 * moment it spawns the sub-agent, mark the nested run tainted BEFORE it executes any tools, preserving
 * the ORIGINAL provenance and noting it was inherited. Only-stricter / fail-safe: an un-tainted parent
 * (or an unknown parentRunId) changes nothing. First-wins/idempotent, so a resume re-marks harmlessly.
 */
async function inheritParentTaint(journal: Journal, parentRunId: string | undefined, nestedRunId: string): Promise<void> {
  if (!parentRunId) return;
  const parentTaint = await readRunTaint(journal, parentRunId);
  if (!parentTaint) return;
  await markRunTainted(journal, nestedRunId, {
    toolCallId: parentTaint.toolCallId,
    toolName: parentTaint.toolName,
    source: parentTaint.source,
    reason: `inherited from tainted parent run '${parentRunId}'${parentTaint.reason ? `: ${parentTaint.reason}` : ''}`,
  });
}

export interface AgentToolConfig {
  journal: Journal;
  /** A model OR a factory that produces a model from the nested runId (to freeze the registry fallback chain onto the nested run). */
  model: ModelInput | ((nestedRunId: string) => unknown | Promise<unknown>);
  tools?: ToolSet;
  system?: string;
  guard?: Guard;
  maxSteps?: number;
  /**
   * TASK W1 fan-out inheritance: the parent's `limits` is passed to the sub-agent AS-IS → the sub-agent
   * independently bounds its own execution against this same ceiling too (prevents a single sub-agent
   * from spending without limit on its own). Also, the parent's OWN limit check (`limits.ts`
   * `scopedUsage`) RECURSIVELY sums this sub-agent's (nested `runId = agent:${toolCallId}`) usage in the
   * journal too → the total (parent + all sub-agents) can NEVER bypass the parent's ceiling.
   */
  limits?: RunLimits;
  /**
   * WHOSE work the delegation is is NOT configured here: the nested run takes the caller of the
   * run that called it — `options.gnl` for agent-as-tool, the delegation frame (`ChildFrame`) for a
   * network. A sub-agent is the same request, one frame deeper; a static owner here was how a tool
   * built once at startup ran every user's delegation as nobody.
   */
  /** The verified caller identity (ownership lock). Inherited, never invented. */
  actor?: string;
  /** Where the work came in from — kept so a nested run's channel is not silently 'unknown'. */
  channel?: string;
  /** FAZ-4 K12: the parent's tool policy, inherited AS-IS — registry.ts's JSDoc promised this for
   *  Years while nothing forwarded it; under 'strict-critical' a delegated sub-agent's undeclared
   *  Side-effect tool must not be the hole in the fence. */
  toolPolicy?: 'strict' | 'strict-critical';
  /** require-approval decisions (passed to the nested run) — approvals flow from here during a network resume. */
  approvals?: Record<string, boolean>;
  /**
   * The runId of the parent that spawned this sub-agent. When the parent is tainted, its taint
   * is carried into the nested run so the sub-agent's side effects go through the SAME `taintedSideEffects`
   * ladder. The agent-as-tool path (`createAgentTool`) reads this per-call from `options.parentRunId`; the
   * network path (`runNetwork`, registry.ts) passes the router's runId in the frame.
   */
  parentRunId?: string;
}

/** What a delegation hands its child run: whom it runs for, what can stop it, which decisions came with it. */
export interface ChildFrame {
  /** The caller of the run that delegated, one frame deeper (`childIdentity`). */
  identity: RunIdentity;
  /** The delegating run — taint crosses to and from it. */
  parentRunId?: string;
  /** The delegating run's cancellation: aborting the parent stops the child. */
  abortSignal?: AbortSignal;
  /** require-approval decisions that came down with the delegation (a resume of a suspended child). */
  approvals?: Record<string, boolean>;
}

/** Runs one child: the engine's own agent run for a registered agent, runDurable for a host-built one. */
export type RunChild = (task: string, nestedRunId: string, frame: ChildFrame) => Promise<{ text: string; interrupts: Interrupt[]; steps?: readonly unknown[] }>;

/**
 * What a delegation returns to the parent's model. `status` is read from the child's tool outcomes, not
 * from its prose: the same agent run directly would have seen each failed call as a failed call, and a
 * parent must be able to branch on it the same way.
 *  - 'suspended': the child waits for a human (`interrupts`, addressed `<delegation call>/<child call>`).
 *  - 'failed': at least one tool's LAST call in the child failed, was blocked, or was refused (`failed`).
 *  - 'completed': every tool the child called ended in a result.
 */
export interface DelegationResult {
  status: 'completed' | 'failed' | 'suspended';
  text: string;
  interrupts: Interrupt[];
  failed?: Array<{ tool: string; kind: 'error' | 'blocked' | 'denied'; message: string }>;
}

/**
 * A finished child's outcome, read from its tool outcomes — the agent-as-tool result and a network step
 * both carry it, so a parent and a router branch on the same facts.
 */
export function childOutcome(steps: readonly unknown[] | undefined): { status: 'completed' | 'failed'; failed?: DelegationResult['failed'] } {
  const failed = failedCalls(steps);
  return { status: failed.length ? 'failed' : 'completed', ...(failed.length ? { failed } : {}) };
}

/** The child's failed calls: per tool, its last outcome — a failure followed by a success of the same tool is not one. */
function failedCalls(steps: readonly unknown[] | undefined): NonNullable<DelegationResult['failed']> {
  const last = new Map<string, { tool: string; kind: 'error' | 'blocked' | 'denied'; message: string } | null>();
  for (const step of steps ?? []) {
    for (const part of ((step as { content?: unknown[] }).content ?? []) as Array<Record<string, any>>) {
      if (part.type === 'tool-error') {
        last.set(part.toolName, { tool: part.toolName, kind: 'error', message: String(part.error?.message ?? part.error).slice(0, 300) });
      } else if (part.type === 'tool-result') {
        const out = part.output as Record<string, any> | undefined;
        const block = out?.__gnl_blocked ?? out?.__gnl_limit_exceeded;
        if (block) last.set(part.toolName, { tool: part.toolName, kind: 'blocked', message: String(block.message ?? block.code ?? 'blocked').slice(0, 300) });
        else if (out?.__denied) last.set(part.toolName, { tool: part.toolName, kind: 'denied', message: String(out.reason ?? 'denied').slice(0, 300) });
        else last.set(part.toolName, null);
      }
    }
  }
  return [...last.values()].filter((f): f is NonNullable<typeof f> => f !== null);
}


/**
 * Taint across the delegation boundary, both ways, around one child run. Down: a tainted parent's child
 * starts tainted, so its side effects meet the same `taintedSideEffects` ladder. Up: content the child
 * read taints the parent too — otherwise the parent acting on what the child brought back (a payment
 * after the child read a web page) skipped the ladder (measured: the payment ran).
 */
export async function runDelegated<R>(journal: Journal, parentRunId: string | undefined, nestedRunId: string, requestRunId: string, run: () => Promise<R>): Promise<R> {
  // The child's work is the request's work from its first step: the parent's budget sees it in flight.
  if (parentRunId) await registerSubRun(journal, parentRunId, nestedRunId, requestRunId);
  await inheritParentTaint(journal, parentRunId, nestedRunId);
  try {
    return await run();
  } finally {
    // A child that read untrusted content and then failed still read it.
    await raiseChildTaint(journal, nestedRunId, parentRunId);
  }
}

async function raiseChildTaint(journal: Journal, childRunId: string, parentRunId: string | undefined): Promise<void> {
  if (!parentRunId) return;
  const t = await readRunTaint(journal, childRunId);
  if (!t) return;
  await markRunTainted(journal, parentRunId, {
    toolCallId: t.toolCallId,
    toolName: t.toolName,
    source: t.source,
    reason: `raised by sub-agent run '${childRunId}'${t.reason ? `: ${t.reason}` : ''}`,
  });
}

/**
 * The agent-as-tool contract, written once: the nested runId, the child's identity, taint both ways,
 * the parent's cancellation, and a suspended child surfacing as the parent's question. What RUNS the
 * child is the caller's: the engine hands its own agent run (every protection a direct run has), a host
 * building a sub-agent from parts hands runDurable.
 */
export function delegationTool(
  description: string,
  journal: Journal,
  runChild: RunChild,
  base: { parentRunId?: string; approvals?: Record<string, boolean>; agent?: string } = {},
): Tool<{ task: string }, DelegationResult> & { idempotent: boolean; delegation: true } {
  return Object.assign(tool({
    description,
    inputSchema: z.object({ task: z.string().describe('the task/question to give the sub-agent') }),
    execute: async ({ task }, options: any) => {
      const approvals = { ...approvalsForChild(options?.toolCallId, base.approvals), ...(options?.gnlApprovals ?? {}) };
      const parentRunId = base.parentRunId ?? options?.parentRunId;
      const nestedRunId = nestedAgentRunId(parentRunId, options?.toolCallId);
      const identity = childIdentity(identityOf(options), nestedRunId);
      const res = await runDelegated(journal, parentRunId, nestedRunId, requestOf(identity), () =>
        runChild(task, nestedRunId, { identity, ...(parentRunId ? { parentRunId } : {}), ...(options?.abortSignal ? { abortSignal: options.abortSignal } : {}), approvals }));
      const interrupts = (res.interrupts ?? []).map((i) => addressed(options?.toolCallId, i));
      if (interrupts.length) {
        const first = interrupts[0]!;
        return {
          status: 'suspended',
          text: res.text,
          interrupts,
          __gnl_suspend: {
            toolCallId: options?.toolCallId,
            toolName: 'agent',
            args: { task },
            kind: 'nested',
            reason:
              `The ${base.agent ? `'${base.agent}' ` : ''}sub-agent stopped for a human: ${first.reason ?? 'approval required'}` +
              `${interrupts.length > 1 ? ` (${interrupts.length} questions)` : ''}. Answer with the addressed toolCallId(s).`,
            // The child's interrupts are kept WHOLE (`args`/`semPair` included): run.ts builds the
            // surfaced question from this list, and a human must see what they approve. The same list
            // is the suspend arm's only source of truth (durable-tool `nestedAnswered`) and bounds what
            // may come down from the parent's approval map.
            nested: { runId: nestedRunId, ...(base.agent ? { agent: base.agent } : {}), interrupts: interrupts.map((i) => ({ toolCallId: i.toolCallId, toolName: i.toolName, args: i.args, reason: i.reason, ...(i.semPair ? { semPair: i.semPair } : {}), ...(i.delegatedTo ? { delegatedTo: i.delegatedTo } : {}) })) },
          },
        } as any;
      }
      return { ...childOutcome(res.steps), text: res.text, interrupts: [] };
    },
    // Idempotent because the child replays from its own journal; a suspended child is re-run by
    // durable-tool's suspend arm when the approval arrives.
  }), { idempotent: true, delegation: true as const });
}

/**
 * A sub-agent a host builds from parts, without createGnl. It runs through runDurable with what the
 * config gives it; a registered agent's sub-agents run through the engine instead (registry.ts), with
 * every protection of a direct run.
 */
export function createAgentTool(
  config: AgentToolConfig,
  opts?: { description?: string },
): Tool<{ task: string }, DelegationResult> & { idempotent: boolean; delegation: true } {
  refuseUnknownNames('createAgentTool', config, AGENT_TOOL_NAMES, REMOVED_AGENT_TOOL_NAMES);
  refuseUnknownNames('createAgentTool', opts, AGENT_TOOL_OPTS_NAMES);
  refuseRunLimitNames('createAgentTool: limits', config.limits);
  return delegationTool(opts?.description ?? 'Delegate a task to an expert sub-agent', config.journal, async (task, nestedRunId, frame) => {
    const model = typeof config.model === 'function' ? await config.model(nestedRunId) : config.model;
    const res = await runDurable({
      runId: nestedRunId,
      journal: config.journal,
      model,
      tools: config.tools,
      system: config.system,
      guard: config.guard,
      prompt: task,
      stopWhen: stepCountIs(config.maxSteps ?? 8),
      limits: config.limits,
      approvals: frame.approvals,
      caller: frame.identity,
      ...(frame.identity.threadId ? { threadId: frame.identity.threadId } : {}),
      ...(frame.abortSignal ? { abortSignal: frame.abortSignal } : {}),
      ...(config.actor ? { actor: config.actor } : {}),
      ...(config.channel ? { channel: config.channel } : {}),
      ...(config.toolPolicy ? { toolPolicy: config.toolPolicy } : {}),
    } as any);
    return { text: res.text, interrupts: res.interrupts, steps: res.steps };
  }, { ...(config.parentRunId ? { parentRunId: config.parentRunId } : {}), ...(config.approvals ? { approvals: config.approvals } : {}) });
}
