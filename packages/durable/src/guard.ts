// Governance: general policy that gates tool EXECUTION. Does not cage the LLM's
// reasoning (it sees all tools); it only gates the side effect.

import type { RunTaint } from './taint.js';

export type GuardDecision =
  | { action: 'allow' }
  | { action: 'deny'; reason?: string }
  | { action: 'require-approval'; reason?: string }; // Phase 3b: suspend/resume

export interface GuardCall {
  toolName: string;
  args: unknown;
  toolCallId: string;
  runId: string;
  /** TAINT PHASE 2 (taint-aware guard): the run's taint mark, populated by the runtime at the guard
   *  call site (durable-tool.ts) — undefined on a clean run. Lets a guard make content-provenance-aware
   *  decisions (see `taintGuardian`). Additive/optional: existing guards that ignore it are unaffected. */
  tainted?: RunTaint;
}

/** A tool call suspended via require-approval (awaiting human approval). */
export interface Interrupt {
  toolCallId: string;
  toolName: string;
  args: unknown;
  reason?: string;
  /** FAZ-6: set when the suspension came from the semantic dup gate — the approval writes the 'different work' tombstone from this. */
  semPair?: { priorHash: string };
  /**
   * Set when a sub-agent asked: which one (`agent`, when registered by name) and its run. Kept out of
   * `reason`, which a person reads: the question said "nested run 'agent:<id>:call-<uuid>'" to a nurse
   * approving a dose (measured, in a chat UI). `via` is the next hop when that sub-agent delegated too.
   */
  delegatedTo?: { runId: string; agent?: string; via?: Interrupt['delegatedTo'] };
}

/**
 * A child's interrupt, addressed from the parent: `<delegation toolCallId>/<child toolCallId>`. Two children
 * number their calls independently (`call_0` each), so the child's own id names nothing at the parent —
 * one approval for `call_0` approved both (measured). Deeper levels prefix again on the way up.
 */
export const addressedId = (delegationCallId: string | undefined, id: string): string =>
  delegationCallId === undefined || id.startsWith(`${delegationCallId}/`) ? id : `${delegationCallId}/${id}`;

export const addressedInterrupt = (delegationCallId: string | undefined, i: Interrupt): Interrupt =>
  delegationCallId === undefined ? i : { ...i, toolCallId: addressedId(delegationCallId, i.toolCallId) };

/** The decisions meant for one delegation, in its child's own id space (the inverse of `addressed`). */
export function approvalsForChild(delegationCallId: string | undefined, approvals: Record<string, boolean> | undefined): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (!approvals || delegationCallId === undefined) return out;
  const prefix = `${delegationCallId}/`;
  for (const [id, v] of Object.entries(approvals)) if (id.startsWith(prefix)) out[id.slice(prefix.length)] = v;
  return out;
}

/** Suspend signal returned in place of tool execute (the loop stops via stopWhen). */
export interface SuspendSentinel {
  __gnl_suspend: Interrupt;
}

/** General policy hook that runs before every tool call (after the exactly-once check). */
export type Guard = (call: GuardCall) => GuardDecision | Promise<GuardDecision>;

/**
 * TAINT PHASE 2 — ready-made Guard factory: "put a guardian in front of sensitive tools that inspects
 * context when they're called." Routes ONLY the taint × sensitive-tool INTERSECTION to `onTainted`
 * (the developer's decision — a plain `{ action: 'require-approval' }`, or an expensive LLM-judge over
 * `call.args`/`call.tainted` that runs exactly at this intersection and nowhere else). Everything else
 * (clean runs, non-sensitive tools) goes to `otherwise` (default: allow) — so the guardian costs
 * nothing until untrusted content has actually entered AND a sensitive tool is being called.
 * Works with plain single-run taint (an `untrusted: true` tool in THIS run marks it) — the Phase 1
 * `taintScope: 'thread'` opt-in is NOT required, it just widens where the taint can come from.
 */
export function taintGuardian(opts: {
  /** Which tools are sensitive — an explicit list, or a predicate over the tool name. */
  sensitiveTools: string[] | ((toolName: string) => boolean);
  /** Decides the intersection case. `call.tainted` is guaranteed set (narrowed) here. */
  onTainted: (call: GuardCall & { tainted: RunTaint }) => GuardDecision | Promise<GuardDecision>;
  /** Policy for everything else (clean OR non-sensitive) — compose an existing Guard. Default: allow. */
  otherwise?: Guard;
}): Guard {
  const sel = opts.sensitiveTools;
  const isSensitive = typeof sel === 'function' ? sel : (name: string) => sel.includes(name);
  return async (call) => {
    if (call.tainted !== undefined && isSensitive(call.toolName)) {
      return opts.onTainted(call as GuardCall & { tainted: RunTaint });
    }
    return opts.otherwise ? opts.otherwise(call) : { action: 'allow' };
  };
}
