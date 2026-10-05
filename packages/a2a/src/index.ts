// @gnldev/a2a — remote agent-to-agent. createAgentTool is in-process; this one calls a REMOTE agent as an AI SDK
// tool: a @gnldev/server REST endpoint (protocol 'gnl', the default) or any Agent2Agent agent (protocol 'a2a':
// agent card + JSON-RPC message/send). The serving half — GNL agents as A2A agents — is `@gnldev/a2a/server`. **Exactly-once across the network:** runId is deterministic
// (`a2a:<idempotencyKey ?? toolCallId>`) → the remote runDurable replays the same runId (a second POST has no
// side effect). When wrapped in durableTool inside a parent runDurable, the parent also journals it → on parent
// resume, the remote call is SKIPPED.
import { tool } from 'ai';
import type { Tool } from 'ai';
import { z } from 'zod';
import { signA2ARequest } from './signature.js';
import { refuseUnknownNames, optionNames } from '@gnldev/options';

export { a2aSigningInput, signA2ARequest, verifyA2ARequest, A2A_SIGNATURE_WINDOW_MS, type A2ASignedRequest, type A2ASignatureVerdict } from './signature.js';

export interface A2AToolOptions {
  /**
   * `'gnl'` (default): the remote is a @gnldev/server; `endpoint` is its base URL and the call is
   * `POST <endpoint>/agents/<agentName>/run`.
   * `'a2a'`: the remote is any Agent2Agent agent; `endpoint` is the agent's base URL — the card is read
   * from `<endpoint>/.well-known/agent.json` (then `agent-card.json`) and the call is a JSON-RPC
   * `message/send` to the card's `url`. The messageId is the same deterministic key the GNL mode uses,
   * so a GNL agent behind `createA2AServer` replays a re-sent call instead of running it again.
   */
  protocol?: 'gnl' | 'a2a';
  /** `'gnl'`: the remote @gnldev/server base URL (e.g. 'https://host'). `'a2a'`: the agent's base URL. */
  endpoint: string;
  /** Remote agent name (REST: POST /agents/<name>/run). In `'a2a'` mode, a label for the tool and its errors. */
  agentName: string;
  description?: string;
  /** Inject fetch for test/custom transport (e.g. hono app.request). Otherwise global fetch. */
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
  /** Remote call timeout (ms). Default 30_000. On timeout a StepTimeoutError-shaped error is
   *  thrown — the wrapping durableTool writes a 'failed' record, the model sees the real error. */
  timeoutMs?: number;
  /**
   * TASK (audit: A2A unsigned) — opt-in HMAC-SHA256 signing. When provided, the request body is
   * sent with a hex signature in the `x-gnl-signature` header over the timestamp, the method, the route and
   * the body (`signA2ARequest`); `x-gnl-timestamp` (epoch-ms) is also included to be part of the replay window. Verified on the
   * remote `@gnldev/server` side via `createRestApi({ a2aSecret })`. If not provided, behavior is
   * UNCHANGED (unsigned request, current behavior).
   */
  secret?: string;
  /**
   * 1.4 — optional budget/quota hook: called BEFORE the remote call (before fetch). On overage
   * it throws (typically `@gnldev/durable`'s `assertBudget` — the caller side's/LOCAL quota; a2a
   * does not know/enforce the remote endpoint's own quota, it only gates the call made FROM this process).
   * The thrown error propagates upward as-is (same pattern as K3 — durableTool writes 'failed',
   * the model sees the real error). IF NOT PROVIDED (default), behavior is UNCHANGED — NO quota check.
   * Kept simple: a2a does NOT embed the quota itself, the host injects it. Example:
   *   budgetGuard: () => assertBudget(journal, { orgId, fallback })
   */
  budgetGuard?: (ctx: { agentName: string; task: string; runId: string }) => Promise<unknown> | unknown;
}

/**
 * K3/timeout — an ALIGNED but INDEPENDENT local definition matching `@gnldev/durable`'s `StepTimeoutError`
 * contract (name='StepTimeoutError', detail:{label,timeoutMs}): @gnldev/durable is an OPTIONAL peer of
 * @gnldev/a2a, needed only by the `./server` entry — this client entry must import nothing from it.
 * Hence, instead of importing it, this class with the same
 * name/shape is defined here: when wrapped (with durableTool) inside runDurable, the H9 recovery
 * ladder recognizes it the same way via `err.name === 'StepTimeoutError'`, but the a2a package has
 * no runtime dependency on durable.
 */
export class StepTimeoutError extends Error {
  constructor(
    message: string,
    public readonly detail: { label: string; timeoutMs: number },
  ) {
    super(message);
    this.name = 'StepTimeoutError';
  }
}

/**
 * WHOSE WORK THIS IS, for the remote: the end user of the calling run, read from @gnldev/durable's
 * identity channel — `options.gnl.identity`, what `identityOf(options)` reads. Read structurally, so
 * this package keeps depending on no @gnldev package.
 *
 * Only a user is named. Staff, `unknown`, or a call outside a GNL run (no channel) names nobody, and
 * the remote runs the call as the credential's own, as before. The user comes from the channel and
 * never from the tool's input: the model cannot make the remote run someone else's.
 *
 * Measured before this (ADR-0002 open point): with an application credential the remote answered
 * 400 "resourceId is required"; with an operator credential the remote run was staff's, not the user's.
 */
function endUserOf(options: unknown): string | undefined {
  const id = (options as { gnl?: { identity?: { kind?: unknown; id?: unknown } } } | undefined)?.gnl?.identity;
  return id && typeof id === 'object' && id.kind === 'user' && typeof id.id === 'string' && id.id !== '' ? id.id : undefined;
}

/**
 * Exposes a remote agent as a tool. The router/parent agent calls it with `task`; the tool POSTs to the
 * remote `/agents/:name/run` (with deterministic runId) and returns the result. Durable when used within
 * `@gnldev/durable`'s `runDurable`.
 */
/** What the remote agent answered, as this tool reports it. */
export interface A2AResult {
  text: string;
  interrupts: unknown;
  /** The deterministic runId the remote ran under — a GNL server answers a retry from its journal under it. */
  runId: string;
  remoteAgent: string;
}

const A2A_TOOL_NAMES = optionNames<A2AToolOptions>()(['protocol', 'endpoint', 'agentName', 'description', 'fetchImpl', 'headers', 'timeoutMs', 'secret', 'budgetGuard']);

// Declared, not inferred (TS2742): inference would name a pnpm-internal provider-utils path in the
// emitted .d.ts. `Tool` comes from `ai`, which this package already requires as a peer.
export function createA2ATool(opts: A2AToolOptions): Tool<{ task: string }, A2AResult> & { idempotent: boolean } {
  refuseUnknownNames('createA2ATool', opts, A2A_TOOL_NAMES);
  const doFetch = opts.fetchImpl ?? fetch;
  // The HMAC signature is @gnldev/server's REST contract (it signs the REST route); an A2A agent states
  // its own auth in its card and takes credentials as headers.
  if (opts.protocol === 'a2a' && opts.secret) {
    throw new TypeError("[gnl a2a] `secret` signs @gnldev/server's REST route and has no meaning for protocol 'a2a' — pass the agent's credential in `headers`.");
  }
  const call = opts.protocol === 'a2a' ? a2aCaller(opts, doFetch) : undefined;
  // H7: a GNL remote replays the same deterministic runId (a retry is answered from its journal) →
  // a repeat POST has no side effect → idempotent. The runId is derived from
  // `options.idempotencyKey` (parent-run-scoped, globally unique — see durableTool) when available,
  // falling back to the raw `toolCallId` otherwise, which is only unique WITHIN a single run: if this
  // tool is called from a bare AI SDK loop (no durableTool/idempotencyKey) AND two different runs
  // happen to reuse the same toolCallId, their remote runIds would collide and the second call would
  // incorrectly replay the first call's journaled result.
  return Object.assign(tool({
    description: opts.description ?? `Delegate a task to remote '${opts.agentName}' agent (A2A)`,
    inputSchema: z.object({ task: z.string().describe('task/question to give to the remote agent') }),
    execute: async ({ task }, options: any) => {
      // runId collision fix: raw `toolCallId` is only unique WITHIN its own run — two DIFFERENT
      // parent runs can produce the SAME toolCallId (some providers use short ids like 'call_1'),
      // which would make the remote side replay the FIRST run's journaled result for the SECOND
      // call (wrong result leaking across runs). @gnldev/durable's durableTool injects
      // `options.idempotencyKey` (`${parentRunId}:${toolCallId}` in 'call' mode,
      // `${parentRunId}:${toolName}:${hash}` in 'args' mode) — parent-run-scoped and globally
      // unique — so prefer it when present (always the case when reached via runDurable).
      // Fallback to raw toolCallId ONLY when the tool is used directly in a bare AI SDK loop
      // (no durableTool wrapper, no idempotencyKey) — in that case the collision risk above still
      // applies and is the caller's responsibility to avoid (e.g. by ensuring toolCallId uniqueness).
      const runId = `a2a:${options?.idempotencyKey ?? options?.toolCallId}`; // deterministic → remote idempotent
      // 1.4: budget/quota hook (optional) — checked BEFORE the remote fetch is called; on overage
      // the thrown error passes upward as-is (K3: no silent failure).
      if (opts.budgetGuard) await opts.budgetGuard({ agentName: opts.agentName, task, runId });
      const timeoutMs = opts.timeoutMs ?? 30_000;
      if (call) return call(task, runId.slice('a2a:'.length), endUserOf(options), timeoutMs);
      // The remote reads `resourceId` for an application credential (the user it acts for) and for an
      // operator (staff naming a user speaks for that user); a user credential ignores it.
      const user = endUserOf(options);
      const bodyStr = JSON.stringify({ runId, prompt: task, ...(user !== undefined ? { resourceId: user } : {}) });
      const headers: Record<string, string> = { 'content-type': 'application/json', ...(opts.headers ?? {}) };
      const path = `/agents/${opts.agentName}/run`;
      // Signed with the one definition the server verifies with (signature.ts): the route is in it.
      if (opts.secret) Object.assign(headers, signA2ARequest(opts.secret, { method: 'POST', path, body: bodyStr }));
      // K3: no silent failure — a timeout reads as @gnldev/durable's StepTimeoutError (timedFetch).
      const res = await timedFetch(doFetch, opts.agentName, `${opts.endpoint}/agents/${encodeURIComponent(opts.agentName)}/run`, {
        method: 'POST',
        headers,
        body: bodyStr,
      }, timeoutMs);
      if (!res.ok) {
        // K3: non-2xx response → throw an error (durableTool writes 'failed', the model sees the real error).
        const bodyText = await res.text().catch(() => '');
        let detail = bodyText;
        try { detail = String(JSON.parse(bodyText)?.error ?? bodyText); } catch { /* if not JSON, keep as text */ }
        throw new Error(`Remote agent '${opts.agentName}' returned an error (HTTP ${res.status}): ${detail.slice(0, 200)}`);
      }
      const json: any = await res.json().catch(() => null);
      // Shape check: 'text' must be a string; in an interrupted run text may be empty but 'interrupts' comes populated.
      if (!json || (typeof json.text !== 'string' && !(Array.isArray(json.interrupts) && json.interrupts.length > 0)))
        throw new Error(`Remote agent '${opts.agentName}' response does not match expected shape (no 'text' field)`);
      return { text: json.text, interrupts: json.interrupts, runId, remoteAgent: opts.agentName };
    },
  }), { idempotent: true });
}

type Fetch = typeof fetch;

/** A fetch whose timeout reads as `StepTimeoutError` (name='StepTimeoutError'); anything else is rethrown as it is. Both modes call through it. */
async function timedFetch(doFetch: Fetch, agentName: string, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    return await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e: any) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError')
      throw new StepTimeoutError(`A2A call timed out (${timeoutMs}ms): remote '${agentName}' agent did not respond`, { label: `a2a:${agentName}`, timeoutMs });
    throw e;
  }
}

/**
 * The standard A2A half of `createA2ATool`: read the Agent Card once, then JSON-RPC `message/send`.
 * A Task's answer is its artifacts' text (else its status message's); a Message's is its text parts.
 * `input-required` comes back as `interrupts` (the data part a GNL agent attaches), like a suspended
 * GNL run; `failed`, `canceled` and `rejected` throw, as a non-2xx does in the GNL mode.
 */
function a2aCaller(opts: A2AToolOptions, doFetch: Fetch) {
  const base = opts.endpoint.replace(/\/$/, '');
  let cardUrl: Promise<string> | undefined;
  const headers = { 'content-type': 'application/json', ...(opts.headers ?? {}) };
  const readCard = async (timeoutMs: number): Promise<string> => {
    for (const path of ['/.well-known/agent.json', '/.well-known/agent-card.json']) {
      const res = await timedFetch(doFetch, opts.agentName, `${base}${path}`, { method: 'GET', headers: opts.headers ?? {} }, timeoutMs);
      if (!res.ok) continue;
      const card: any = await res.json().catch(() => null);
      if (card && typeof card.url === 'string' && card.url !== '') return card.url;
      throw new Error(`Remote agent '${opts.agentName}' card at ${base}${path} has no 'url'`);
    }
    throw new Error(`Remote agent '${opts.agentName}' has no agent card at ${base}/.well-known/agent.json or agent-card.json`);
  };
  const textOf = (parts: unknown): string =>
    Array.isArray(parts) ? parts.filter((p: any) => p?.kind === 'text' && typeof p.text === 'string').map((p: any) => p.text).join('') : '';
  return async (task: string, key: string, user: string | undefined, timeoutMs: number): Promise<A2AResult> => {
    // A card that could not be read is not cached: the next call reads it again.
    const url = await (cardUrl ??= readCard(timeoutMs).catch((e) => { cardUrl = undefined; throw e; }));
    const body = JSON.stringify({
      jsonrpc: '2.0', id: key, method: 'message/send',
      params: {
        message: { kind: 'message', role: 'user', messageId: key, parts: [{ kind: 'text', text: task }] },
        configuration: { blocking: true, acceptedOutputModes: ['text/plain', 'application/json'] },
        ...(user !== undefined ? { metadata: { resourceId: user } } : {}),
      },
    });
    const res = await timedFetch(doFetch, opts.agentName, url, { method: 'POST', headers, body }, timeoutMs);
    const json: any = await res.json().catch(() => null);
    if (json?.error) throw new Error(`Remote agent '${opts.agentName}' returned a JSON-RPC error ${json.error.code}: ${String(json.error.message).slice(0, 200)}`);
    if (!res.ok || !json?.result) throw new Error(`Remote agent '${opts.agentName}' returned an error (HTTP ${res.status}) with no JSON-RPC result`);
    const r = json.result;
    if (r.kind === 'message') return { text: textOf(r.parts), interrupts: undefined, runId: `a2a:${key}`, remoteAgent: opts.agentName };
    const state = r.status?.state;
    // Only `completed` is an answer and only `input-required` is a GNL suspension. Every other state —
    // terminal (`failed`, `canceled`, `rejected`) or not final (`submitted`, `working`, `auth-required`,
    // `unknown`) — throws: a durableTool would journal a resolved call as done and never ask again.
    if (state !== 'completed' && state !== 'input-required') {
      throw new Error(`Remote agent '${opts.agentName}' task ${r.id} is '${state}', not an answer: ${textOf(r.status?.message?.parts).slice(0, 200)}`);
    }
    const artifactText = Array.isArray(r.artifacts) ? r.artifacts.map((a: any) => textOf(a?.parts)).join('') : '';
    const data = (r.status?.message?.parts ?? []).find((p: any) => p?.kind === 'data' && Array.isArray(p.data?.interrupts));
    return {
      text: artifactText || (state === 'input-required' ? '' : textOf(r.status?.message?.parts)),
      interrupts: state === 'input-required' ? (data?.data.interrupts ?? [{ reason: textOf(r.status?.message?.parts) }]) : undefined,
      runId: typeof r.id === 'string' ? r.id : `a2a:${key}`,
      remoteAgent: opts.agentName,
    };
  };
}
