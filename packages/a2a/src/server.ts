// @gnldev/a2a/server — the A2A (Agent2Agent) door: GNL agents served to any A2A client.
//
// Wire shape: the A2A JSON-RPC binding as of protocol 0.2.x/0.3.0 — an Agent Card per agent at
// `<agent base>/.well-known/agent.json` (and `agent-card.json`, the 0.3 name), and one JSON-RPC 2.0
// endpoint per agent at `<agent base>` (`/agents/<name>`). Methods: `message/send` (blocking),
// `tasks/get`, `tasks/cancel`. Not here: `message/stream`, `tasks/resubscribe`, push notifications.
//
// A door, like @gnldev/agui and @gnldev/chat-adapter (ADR-0002 point 0): it depends on @gnldev/durable
// and @gnldev/auth only, never on @gnldev/server. Nothing below decides identity or ownership on its own:
//   who        → @gnldev/auth `doorGate` (identify → engineCallerOf, authorize, the open-surface rule)
//   whose run  → @gnldev/durable `runOwnerOf` + `decideDoorRunAccess`, the one rule every door asks
//   which run  → @gnldev/durable `resolveWorkIdentity`: a task id IS a run id
//   approval   → a suspended run is an `input-required` task; the reply carries `approvals`
//   cancel     → @gnldev/durable `cancelAgentRun` (durable, terminal) + this process's in-flight abort
import {
  createGnl, scopeConfigToOrg, resolveWorkIdentity, sealRequestContext, sealFieldsOf, runOwnerOf, decideDoorRunAccess,
  cancelAgentRun, readRunOutcome, summarizeRun, settleModelContent, surfacedInterrupts, callerConflictAnswer, agentVisibleToOrg, readJsonObject, assertRunTarget,
} from '@gnldev/durable';
import type { CreateGnlConfig, Journal, JournalReader, RawJournal, Caller, Interrupt, RunOwner } from '@gnldev/durable';
import { doorGate, AGENTS_RUN, markRefusal, settleDecision, decisionNotRecorded, type AccessDecision, type Authorize, type Identify, refuseMisplacedOptions, doorOptionKeys } from '@gnldev/auth';

/** The A2A protocol version this door's card declares. */
export const A2A_PROTOCOL_VERSION = '0.3.0';

/** JSON-RPC 2.0 and A2A error codes this door answers with. */
export const A2A_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  taskNotFound: -32001,
  taskNotCancelable: -32002,
  unsupportedOperation: -32004,
  /** GNL: the door refused the caller (auth, role, host rule). `data.status` is the HTTP status. */
  refused: -32040,
} as const;

/** A2A task states this door produces. */
export type A2ATaskState = 'working' | 'input-required' | 'completed' | 'canceled' | 'failed';

export type A2APart = { kind: 'text'; text: string } | { kind: 'data'; data: Record<string, unknown> };

export interface A2AMessage {
  kind: 'message';
  role: 'user' | 'agent';
  messageId: string;
  parts: A2APart[];
  taskId?: string;
  contextId?: string;
  metadata?: Record<string, unknown>;
}

export interface A2ATask {
  kind: 'task';
  id: string;
  contextId: string;
  status: { state: A2ATaskState; message?: A2AMessage; timestamp: string };
  artifacts?: { artifactId: string; name?: string; parts: A2APart[] }[];
  metadata?: Record<string, unknown>;
}

export interface A2AAgentCard {
  protocolVersion: string;
  name: string;
  description: string;
  url: string;
  preferredTransport: 'JSONRPC';
  version: string;
  capabilities: { streaming: boolean; pushNotifications: boolean; stateTransitionHistory: boolean };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: { id: string; name: string; description: string; tags: string[] }[];
}

export interface A2AServerOptions {
  /**
   * WHO is calling — the application's one answer (@gnldev/auth `Identify`), the same function handed to
   * @gnldev/server, @gnldev/agui, @gnldev/chat-adapter and @gnldev/mcp. An application credential names
   * the end user it acts for in `params.metadata.resourceId` (the REST routes' `resourceId`).
   * Without it every caller is anonymous (`unknown`), which reaches only runs born anonymous.
   */
  identify?: Identify;
  /** The provider's `authorize`: asked for `agents:run`, `runs:read` and `run:cancel`. */
  authorize?: Authorize;
  /** Each request's outcome, to the provider's hook (`auth.onDecision`). */
  onDecision?: (decision: AccessDecision) => void | Promise<void>;
  /** Host names answered for a request with no identity (same meaning as `createRestApi`'s). */
  allowedHosts?: readonly string[] | true;
  /** `true` lifts the cross-site check for a request with no identity. */
  allowCrossSite?: boolean;
  /** Print this door's protections when it is built (default `true`); `false` when something else already prints them. */
  protectionsBanner?: boolean;
  /**
   * The public URL this handler is mounted at, e.g. `'https://agents.example.com/a2a'`. The card's `url`
   * is `<baseUrl>/agents/<name>`. Default: read from the card request itself — right unless the host
   * strips a mount prefix before handing the request on.
   */
  baseUrl?: string;
  /** The `version` the card advertises (your agent's version, not the protocol's). Default `'1.0.0'`. */
  agentVersion?: string;
}

export type A2AFetchHandler = ((request: Request) => Promise<Response>) & { fetch: (request: Request) => Promise<Response> };

type RpcId = string | number | null;
const rpcError = (id: RpcId, code: number, message: string, data?: unknown, status = 200): Response =>
  Response.json({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } }, { status });
const rpcResult = (id: RpcId, result: unknown): Response => Response.json({ jsonrpc: '2.0', id, result });

const CARD_PATH = /^\/agents\/([^/]+)\/\.well-known\/agent(?:-card)?\.json$/;
const RPC_PATH = /^\/agents\/([^/]+)\/?$/;

/** The text of a step's content, as the model answered it. */
function textOf(content: unknown): string {
  return Array.isArray(content) ? content.filter((p: any) => p?.type === 'text' && typeof p.text === 'string').map((p: any) => p.text).join('') : '';
}

/** Every option createA2AServer takes in its SECOND argument, held to `A2AServerOptions` by `pnpm typecheck` below. */
const A2A_SERVER_OPTION_KEYS = doorOptionKeys<A2AServerOptions>()(['identify', 'authorize', 'onDecision', 'allowedHosts', 'allowCrossSite', 'protectionsBanner', 'baseUrl', 'agentVersion']);

/**
 * Serve every agent of a createGnl config over A2A. Returns a fetch handler:
 *   GET  /agents/<name>/.well-known/agent.json   (and agent-card.json)  → the Agent Card
 *   POST /agents/<name>                          JSON-RPC 2.0           → message/send, tasks/get, tasks/cancel
 */
export function createA2AServer(config: CreateGnlConfig, opts: A2AServerOptions = {}): A2AFetchHandler {
  refuseMisplacedOptions('createA2AServer', config, opts, A2A_SERVER_OPTION_KEYS);
  const rootGnl = createGnl(config);
  const rootJournal = (config.storage ? config.storage.runs : config.journal) as Journal;
  // One instance per organization over its own partition — the construction every door uses
  // (`scopeConfigToOrg`), so an org's A2A tasks are where its REST reads look for them.
  const orgs = new Map<string, { gnl: ReturnType<typeof createGnl>; journal: Journal & JournalReader }>();
  const scopeFor = (org: string | undefined): { gnl: ReturnType<typeof createGnl>; journal: Journal } => {
    if (!org) return { gnl: rootGnl, journal: rootJournal };
    let s = orgs.get(org);
    if (!s) {
      const scoped = scopeConfigToOrg(config, org);
      orgs.set(org, (s = { gnl: createGnl(scoped.config), journal: scoped.journal }));
    }
    return s;
  };
  const admit = doorGate({
    door: 'createA2AServer',
    identify: opts.identify,
    authorize: opts.authorize,
    allowedHosts: opts.allowedHosts,
    allowCrossSite: opts.allowCrossSite,
    protectionsBanner: opts.protectionsBanner,
  });
  // Generations running in THIS process, so tasks/cancel stops them now; the durable flag stops the rest.
  const inflight = new Map<string, Set<AbortController>>();
  const agents = (config.agents ?? {}) as Record<string, { description?: string; orgs?: string[] }>;

  const card = (name: string, url: string): A2AAgentCard => {
    const description = agents[name]?.description ?? `GNL agent '${name}'`;
    return {
      protocolVersion: A2A_PROTOCOL_VERSION,
      name,
      description,
      url,
      preferredTransport: 'JSONRPC',
      version: opts.agentVersion ?? '1.0.0',
      capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
      defaultInputModes: ['text/plain', 'application/json'],
      defaultOutputModes: ['text/plain', 'application/json'],
      skills: [{ id: name, name, description, tags: ['gnl'] }],
    };
  };

  /** The task a run is, read from the journal — no model call, no side effect. */
  const taskOf = async (journal: Journal, runId: string, owner: RunOwner & { state: 'owned' }): Promise<A2ATask> => {
    const entries = await (journal as Journal & JournalReader).readRun(runId);
    const status = summarizeRun(runId, entries, await readRunOutcome(journal, runId)).status;
    const record = owner.record as { threadId?: string } | undefined;
    const contextId = record?.threadId ?? runId;
    const models = entries.filter((e) => e.kind === 'model');
    const last = models[models.length - 1]?.value;
    // A suspended tool record keeps the sentinel; `surfacedInterrupts` is the engine's one reading of it.
    const interrupts: Interrupt[] = entries
      .filter((e) => e.kind !== 'model' && (e.value as { status?: string } | undefined)?.status === 'suspended')
      .flatMap((e) => surfacedInterrupts((e.value as { output?: { __gnl_suspend?: unknown } }).output?.__gnl_suspend));
    const state: A2ATaskState = status === 'suspended' ? 'input-required' : status === 'running' ? 'working' : status;
    // Either path's step record (a streamed one keeps parts): the engine's one reading of it.
    return toTask(runId, contextId, state, textOf(settleModelContent(last)), interrupts);
  };

  const toTask = (runId: string, contextId: string, state: A2ATaskState, text: string, interrupts: Interrupt[]): A2ATask => {
    const msg = (parts: A2APart[]): A2AMessage => ({ kind: 'message', role: 'agent', messageId: `${runId}:${state}`, taskId: runId, contextId, parts });
    const task: A2ATask = { kind: 'task', id: runId, contextId, status: { state, timestamp: new Date().toISOString() } };
    if (state === 'input-required') {
      task.status.message = msg([
        { kind: 'text', text: `Approval required for ${interrupts.map((i) => i.toolName).join(', ') || 'a tool call'}. Reply on this task with a data part { approvals: { <toolCallId>: true | false } }.` },
        { kind: 'data', data: { interrupts } },
      ]);
    } else if (state === 'completed') {
      task.status.message = msg([{ kind: 'text', text }]);
      task.artifacts = [{ artifactId: `${runId}:answer`, name: 'answer', parts: [{ kind: 'text', text }] }];
    }
    return task;
  };

  /**
   * Ownership and target through the engine's two rules (`decideRunAccess`, `assertRunTarget`): a task
   * this caller may not see, or one started for another agent than this route's, does not exist here.
   * An ownership refusal is recorded for `onDecision`, as every door records it.
   */
  const ownedTask = async (req: Request, journal: Journal, runId: string, caller: Caller, agent: string): Promise<(RunOwner & { state: 'owned' }) | undefined> => {
    const owner = await runOwnerOf(journal as RawJournal, runId);
    const decision = decideDoorRunAccess(owner, caller, runId);
    if (decision === 'deny') markRefusal(req, 'ownership', { detail: 'run belongs to another caller' });
    if (decision !== 'allow' || owner.state !== 'owned') return undefined;
    try {
      assertRunTarget(owner.record, { kind: 'agent', name: agent }, runId);
    } catch {
      return undefined; // another agent's task: not found on this route
    }
    return owner;
  };

  const handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const cardMatch = CARD_PATH.exec(url.pathname);
    if (cardMatch && req.method === 'GET') {
      const name = decodeURIComponent(cardMatch[1]!);
      const who = await admit(req, { permission: 'catalog:read' });
      if ('refused' in who) return Response.json(who.refused.body, { status: who.refused.status });
      const org = who.caller.kind === 'unknown' ? undefined : who.caller.orgId;
      if (!agents[name] || !agentVisibleToOrg(agents[name]!, org)) return Response.json({ error: `agent '${name}' not found` }, { status: 404 });
      const base = opts.baseUrl ? opts.baseUrl.replace(/\/$/, '') : `${url.origin}${url.pathname.slice(0, url.pathname.length - url.pathname.slice(url.pathname.indexOf('/agents/')).length)}`;
      return Response.json(card(name, `${base}/agents/${encodeURIComponent(name)}`));
    }
    const rpcMatch = RPC_PATH.exec(url.pathname);
    if (!rpcMatch) return Response.json({ error: 'not found' }, { status: 404 });
    if (req.method !== 'POST') return Response.json({ error: 'method not allowed — A2A JSON-RPC is POST' }, { status: 405, headers: { allow: 'POST' } });
    const name = decodeURIComponent(rpcMatch[1]!);

    // JSON-RPC envelope: parse error, invalid request, method not found — before anyone is asked anything.
    // JSON-RPC tells "not JSON" (-32700) from "JSON, but not a request" (-32600): a batch is valid JSON,
    // and answering it "Parse error" told the client its body was broken.
    const bodyText = await req.text();
    const read = readJsonObject(bodyText);
    if (!read.ok) {
      let parsed: unknown;
      try { parsed = JSON.parse(bodyText); } catch { return rpcError(null, A2A_ERROR_CODES.parseError, `Parse error: ${read.error}`); }
      return rpcError(null, A2A_ERROR_CODES.invalidRequest, Array.isArray(parsed)
        ? 'Invalid Request: batch requests are not supported — send one request per call'
        : `Invalid Request: ${read.error}`);
    }
    const rpc = read.value as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
    const id: RpcId = typeof rpc.id === 'string' || typeof rpc.id === 'number' ? rpc.id : null;
    if (rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string' || (rpc.id !== undefined && rpc.id !== null && id === null)) {
      return rpcError(id, A2A_ERROR_CODES.invalidRequest, "Invalid Request: expected { jsonrpc: '2.0', id, method, params }");
    }
    // A notification (no `id`) gets no reply (JSON-RPC 2.0), and it is not run either: every method here
    // answers with its result, and a message/send whose answer nobody can receive would be work done out of
    // sight. Measured before: it ran and was answered.
    if (!('id' in rpc)) return new Response(null, { status: 204 });
    const params = (rpc.params && typeof rpc.params === 'object' && !Array.isArray(rpc.params) ? rpc.params : undefined) as Record<string, any> | undefined;
    const method = rpc.method;
    const permission = method === 'message/send' ? AGENTS_RUN : method === 'tasks/get' ? 'runs:read' : method === 'tasks/cancel' ? 'run:cancel' : undefined;
    if (!permission) {
      return method === 'message/stream' || method.startsWith('tasks/')
        ? rpcError(id, A2A_ERROR_CODES.unsupportedOperation, `Unsupported operation: ${method} (this agent serves message/send, tasks/get, tasks/cancel)`)
        : rpcError(id, A2A_ERROR_CODES.methodNotFound, `Method not found: ${method}`);
    }
    if (!params) return rpcError(id, A2A_ERROR_CODES.invalidParams, 'Invalid params: params must be an object');

    // WHO — the door gate every standalone door runs. An application names its end user in metadata.
    const named = params.metadata?.resourceId ?? params.message?.metadata?.resourceId;
    const who = await admit(req, { named, permission });
    if ('refused' in who) return rpcError(id, A2A_ERROR_CODES.refused, who.refused.body.error, { status: who.refused.status, ...(who.refused.body.code ? { code: who.refused.body.code } : {}) }, who.refused.status);
    const caller = who.caller;
    const org = caller.kind === 'unknown' ? undefined : caller.orgId;
    // An agent this org cannot see is an agent that does not exist (the REST `agentGate` rule).
    if (!agents[name] || !agentVisibleToOrg(agents[name]!, org)) return rpcError(id, A2A_ERROR_CODES.invalidRequest, `agent '${name}' not found`, { code: 'agent_not_found' }, 404);
    const { gnl, journal } = scopeFor(org);

    if (method === 'tasks/get' || method === 'tasks/cancel') {
      if (typeof params.id !== 'string' || params.id === '') return rpcError(id, A2A_ERROR_CODES.invalidParams, 'Invalid params: id (the task id) is required');
      const owner = await ownedTask(req, journal, params.id, caller, name);
      if (!owner || owner.kind !== 'agent') return rpcError(id, A2A_ERROR_CODES.taskNotFound, `Task not found: ${params.id}`);
      if (method === 'tasks/get') return rpcResult(id, await taskOf(journal, params.id, owner));
      const current = await taskOf(journal, params.id, owner);
      // A final state cannot be canceled (canceled included: the SDK reference answers -32002 for it too).
      if (current.status.state === 'completed' || current.status.state === 'failed' || current.status.state === 'canceled') {
        return rpcError(id, A2A_ERROR_CODES.taskNotCancelable, `Task cannot be canceled: it is ${current.status.state}`);
      }
      for (const ctrl of inflight.get(`${org ?? ''}\u0000${params.id}`) ?? []) ctrl.abort();
      await cancelAgentRun(journal, params.id, { reason: 'a2a-cancel' });
      return rpcResult(id, await taskOf(journal, params.id, owner));
    }

    // message/send
    const message = params.message as Partial<A2AMessage> | undefined;
    if (!message || typeof message !== 'object' || typeof message.messageId !== 'string' || message.messageId === '' || !Array.isArray(message.parts)) {
      return rpcError(id, A2A_ERROR_CODES.invalidParams, 'Invalid params: message { messageId, role, parts[] } is required');
    }
    const text = message.parts.filter((p: any) => p?.kind === 'text' && typeof p.text === 'string').map((p: any) => p.text).join('\n');
    const approvals = message.parts.map((p: any) => (p?.kind === 'data' ? p.data?.approvals : undefined)).find((a) => a && typeof a === 'object') as Record<string, boolean> | undefined;

    let runId: string;
    let runAs: Caller = caller;
    let input: { prompt?: string; workKey?: string } = {};
    let threadId: string | undefined;
    if (typeof message.taskId === 'string' && message.taskId !== '') {
      // A reply on an existing task: the run continues as its recorded owner, from its frozen input.
      const owner = await ownedTask(req, journal, message.taskId, caller, name);
      if (!owner || owner.kind !== 'agent') return rpcError(id, A2A_ERROR_CODES.taskNotFound, `Task not found: ${message.taskId}`);
      if (!approvals) return rpcError(id, A2A_ERROR_CODES.invalidParams, 'Invalid params: a reply on a task carries a data part { approvals: { <toolCallId>: boolean } }');
      runId = message.taskId;
      runAs = owner.owner;
      // The prompt is not re-sent: the engine continues the run from its own recorded input.
      const rec = (owner.record ?? {}) as { threadId?: string };
      threadId = rec.threadId;
    } else {
      if (text === '') return rpcError(id, A2A_ERROR_CODES.invalidParams, 'Invalid params: message has no text part');
      // WHICH RUN: the messageId names the work. With a user it is a workKey (unique within that user);
      // without one it is the raw id `a2a:<messageId>` — the same deterministic id the client side uses.
      const subject = caller.kind === 'user' ? caller.id : undefined;
      let identity;
      try {
        identity = resolveWorkIdentity(`agent:${name}`, {
          ...(subject ? { workKey: message.messageId, resourceId: subject } : { runId: `a2a:${message.messageId}` }),
          scopeKind: gnl.agent(name).workScope ?? 'resource',
          ...(org ? { orgId: org } : {}),
          anonymous: 'refuse',
          surface: `A2A message/send ${name}`,
        });
      } catch (e: any) {
        return rpcError(id, A2A_ERROR_CODES.invalidParams, String(e?.message ?? e));
      }
      runId = identity.runId!;
      input = identity.work?.workKey !== undefined ? { workKey: identity.work.workKey, prompt: text } : { prompt: text };
      threadId = typeof message.contextId === 'string' && message.contextId !== '' ? message.contextId : undefined;
      // A re-send of the same message is the same task: the engine replays it below, and a task the
      // caller may not see is refused by the engine as a caller conflict.
    }

    const key = `${org ?? ''}\u0000${runId}`;
    const ctrl = new AbortController();
    let set = inflight.get(key);
    if (!set) inflight.set(key, (set = new Set()));
    set.add(ctrl);
    try {
      const r = await gnl.run(name, {
        ...(input.workKey !== undefined ? { workKey: input.workKey } : { runId }),
        ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
        ...(threadId ? { threadId } : {}),
        ...(approvals ? { approvals } : {}),
        context: sealRequestContext({}, sealFieldsOf(runAs, org)),
        caller: runAs,
        // Only an explicit tasks/cancel (ctrl) stops the run: it executes apart from this request
        // (@gnldev/durable), so a dropped connection leaves it running and a re-send reads its answer.
        abortSignal: ctrl.signal,
      } as never) as { text: string; interrupts?: Interrupt[] };
      const interrupts = r.interrupts ?? [];
      return rpcResult(id, toTask(runId, threadId ?? runId, interrupts.length ? 'input-required' : 'completed', r.text ?? '', interrupts));
    } catch (e: any) {
      if (e?.name === 'RunCanceledError') return rpcResult(id, toTask(runId, threadId ?? runId, 'canceled', '', []));
      // Someone else's run, under an id this caller named: the same answer as an id that does not exist.
      const conflict = callerConflictAnswer(e);
      if (conflict?.ownership) {
        markRefusal(req, 'ownership', { detail: conflict.code });
        return rpcError(id, A2A_ERROR_CODES.taskNotFound, `Task not found: ${runId}`);
      }
      // The rest of the family is the caller's own mistake about its own work: say which.
      if (conflict) return rpcError(id, A2A_ERROR_CODES.invalidParams, conflict.error, { code: conflict.code, detail: conflict.detail });
      return rpcError(id, A2A_ERROR_CODES.internalError, String(e?.message ?? e), e?.code ? { code: e.code } : undefined);
    } finally {
      set.delete(ctrl);
      if (!set.size) inflight.delete(key);
    }
  };

  const serve = async (req: Request): Promise<Response> => {
    if (!opts.onDecision) return handle(req);
    const res = await handle(req);
    try {
      await settleDecision(opts.onDecision, req, res.status);
      return res;
    } catch (err) {
      return decisionNotRecorded(err);
    }
  };
  return Object.assign(serve, { fetch: serve });
}
