// Shared world for the KARAR-1 acceptance tests (d25 memory cluster): a conversation store handed to
// `createGnl` as an OBJECT, served through every door that can bind a request to an organization.
//
// Not a test file (vitest only collects *.test.ts). It builds doors through their PUBLIC factories
// only — createRestApi (+ chatSurface / aguiSurface), createChatRoute, createAguiRoute, createA2AServer —
// and reads results only through public reads: what the model was shown, and an organization's own
// view of the storage (`withOrgStorage`). No internal function of any package is called, so the code
// that makes these tests pass is free to put the rule wherever it belongs.
//
// Every door is reduced to one verb: `turn(org, threadId, text)` — one user turn by user `u1` of
// organization `org` (or of no organization, when `org` is undefined) on `threadId`.
import { InMemoryStorage, withOrgStorage, workingMemoryScope, type Storage } from '@gnldev/durable';
import { roleAuth, signSubjectToken } from '@gnldev/auth';
import { createRestApi } from '../src/index.js';
import { chatSurface } from '../../chat-adapter/src/index.js';
import { createChatRoute } from '../../chat-adapter/src/index.js';
import { createAguiRoute, aguiSurface } from '../../agui/src/route.js';
import { createA2AServer } from '../../a2a/src/server.js';

(globalThis as any).AI_SDK_LOG_WARNINGS = false;

// ── the model ───────────────────────────────────────────────────────────────────────────────────
/**
 * Records every prompt it is shown (as JSON), so "the next turn loads the thread" and "another
 * organization never sees it" are both read off what actually reached the model.
 *
 * A user message `REMEMBER <value>` makes it call `updateWorkingMemory({ memory: { note: <value> } })`
 * once (the tool AgentMemory registers when `workingMemory` is configured), then answer.
 */
export function recordingModel() {
  const prompts: string[] = [];
  const usage = { inputTokens: { total: 1, text: 1 }, outputTokens: { total: 1, text: 1, reasoning: undefined }, totalTokens: 2 };
  const stop = { unified: 'stop', raw: 'stop' };
  const decide = (prompt: any[]): { toolInput?: string } => {
    const msgs = prompt ?? [];
    let lastUser = -1;
    msgs.forEach((m: any, i: number) => { if (m.role === 'user') lastUser = i; });
    const userText = lastUser < 0 ? '' : (Array.isArray(msgs[lastUser].content)
      ? msgs[lastUser].content.map((p: any) => p.text ?? '').join('')
      : String(msgs[lastUser].content));
    const answeredSince = msgs.slice(lastUser + 1).some((m: any) => m.role === 'tool');
    const m = /REMEMBER (\S+)/.exec(userText);
    return m && !answeredSince ? { toolInput: JSON.stringify({ memory: { note: m[1] } }) } : {};
  };
  const model: any = {
    specificationVersion: 'v4', provider: 'mock', modelId: 'recorder', supportedUrls: {},
    doGenerate: async ({ prompt }: any) => {
      prompts.push(JSON.stringify(prompt));
      const d = decide(prompt);
      if (d.toolInput) {
        return { content: [{ type: 'tool-call', toolCallId: `wm-${prompts.length}`, toolName: 'updateWorkingMemory', input: d.toolInput }], finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage, warnings: [] };
      }
      return { content: [{ type: 'text', text: 'noted' }], finishReason: stop, usage, warnings: [] };
    },
    doStream: async ({ prompt }: any) => {
      prompts.push(JSON.stringify(prompt));
      const d = decide(prompt);
      return {
        stream: new ReadableStream({ start(c) {
          c.enqueue({ type: 'stream-start', warnings: [] });
          if (d.toolInput) {
            c.enqueue({ type: 'tool-call', toolCallId: `wm-${prompts.length}`, toolName: 'updateWorkingMemory', input: d.toolInput });
            c.enqueue({ type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage });
            c.close();
            return;
          }
          c.enqueue({ type: 'text-start', id: 't' });
          c.enqueue({ type: 'text-delta', id: 't', delta: 'noted' });
          c.enqueue({ type: 'text-end', id: 't' });
          c.enqueue({ type: 'finish', finishReason: stop, usage });
          c.close();
        } }),
      };
    },
  };
  return { model, prompts };
}

/** A deterministic embedding: texts about "invoice" point one way, everything else the other. */
export const embed = async (t: string): Promise<number[]> => (/invoice/i.test(t) ? [1, 0] : [0, 1]);

// ── reading an organization's store ───────────────────────────────────────────────────────────────
/** The texts of `threadId` as stored in `org`'s partition (or the root store when `org` is undefined). */
export async function storedTexts(storage: Storage, org: string | undefined, threadId: string): Promise<string> {
  const view = org === undefined ? storage : withOrgStorage(storage, org);
  const page = await view.memory!.getMessages(threadId, { limit: 1000 } as never);
  return JSON.stringify((page as { items: unknown[] }).items);
}

/** Working memory of `threadId` (thread scope) in `org`'s partition. */
export async function storedWorkingMemory(storage: Storage, org: string | undefined, threadId: string): Promise<unknown> {
  const view = org === undefined ? storage : withOrgStorage(storage, org);
  return view.memory!.getWorkingMemory(workingMemoryScope.thread(threadId));
}

// ── doors ───────────────────────────────────────────────────────────────────────────────────────
export type Turn = { status: number; body: string };
export interface Door {
  name: string;
  /** Organizations this door can put a request in (the first two are used by isolation tests). */
  orgs: readonly string[];
  turn(org: string, threadId: string, text: string): Promise<Turn>;
}

const SECRET = 'end-user-signing-secret-at-least-32-bytes!!';
let seq = 0;
const next = () => `${Date.now().toString(36)}-${++seq}`;

/**
 * Builds a door over `config`. Construction errors propagate — a door that refuses the config at
 * boot throws from here (the refusal tests catch it; the "it works" tests let it fail the test).
 */
export type DoorFactory = { name: string; build: (config: Record<string, unknown>) => Door };

const restCall = async (api: (r: Request) => Promise<Response>, path: string, body: unknown, headers: Record<string, string>): Promise<Turn> => {
  const res = await api(new Request(`http://x${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.text() };
};

/** (a) createRestApi + roleAuth: the organization comes from the CREDENTIAL (`orgId`), no `org` option. */
export const restRoleAuth: DoorFactory = {
  name: 'REST /run, organization bound by roleAuth credential (no `org` option)',
  build(config) {
    const api = createRestApi(config as never, {
      auth: roleAuth({ client: { token: 'APP-ACME', orgId: 'acme' }, endUsers: { secret: SECRET, orgId: 'globex' } }),
      protectionsBanner: false,
    } as never) as unknown as (r: Request) => Promise<Response>;
    return {
      name: this.name, orgs: ['acme', 'globex'],
      turn: (org, threadId, text) => org === 'acme'
        // An application credential names its end user in the body.
        ? restCall(api, '/agents/a/run', { runId: `r-${next()}`, threadId, prompt: text, resourceId: 'u1' }, { authorization: 'Bearer APP-ACME' })
        // An end user's signed token carries the user; the credential's `orgId` is the organization.
        : restCall(api, '/agents/a/run', { runId: `r-${next()}`, threadId, prompt: text }, { authorization: `Bearer ${signSubjectToken({ sub: 'u1' }, SECRET, { ttlSec: 300 })}` }),
    };
  },
};

/** (b) createRestApi + `org` option: the organization comes from the `x-gnl-org` header. */
export const restOrgHeader: DoorFactory = {
  name: 'REST /run, organization from the x-gnl-org header (`org` option)',
  build(config) {
    const api = createRestApi(config as never, { org: {}, protectionsBanner: false } as never) as unknown as (r: Request) => Promise<Response>;
    return {
      name: this.name, orgs: ['acme', 'globex'],
      turn: (org, threadId, text) => restCall(api, '/agents/a/run', { runId: `r-${next()}`, threadId, prompt: text, resourceId: 'u1' }, { 'x-gnl-org': org }),
    };
  },
};

/** (c1) chatSurface on createRestApi (useChat wire format), organization from the header. */
export const restChatSurface: DoorFactory = {
  name: 'chatSurface on createRestApi (x-gnl-org)',
  build(config) {
    const api = createRestApi(config as never, { org: {}, protectionsBanner: false, surfaces: [chatSurface()] } as never) as unknown as (r: Request) => Promise<Response>;
    return {
      name: this.name, orgs: ['acme', 'globex'],
      // Only the NEW message is sent, so an earlier turn can reach the prompt only through memory.
      turn: (org, threadId, text) => restCall(api, '/agents/a/chat', {
        id: threadId, threadId, resourceId: 'u1', messages: [{ id: `m-${next()}`, role: 'user', parts: [{ type: 'text', text }] }],
      }, { 'x-gnl-org': org }),
    };
  },
};

/** (d1) aguiSurface on createRestApi, organization from the header. */
export const restAguiSurface: DoorFactory = {
  name: 'aguiSurface on createRestApi (x-gnl-org)',
  build(config) {
    const api = createRestApi(config as never, { org: {}, protectionsBanner: false, surfaces: [aguiSurface()] } as never) as unknown as (r: Request) => Promise<Response>;
    return {
      name: this.name, orgs: ['acme', 'globex'],
      turn: (org, threadId, text) => restCall(api, '/agents/a/agui', { runId: `r-${next()}`, threadId, prompt: text, resourceId: 'u1' }, { 'x-gnl-org': org }),
    };
  },
};

/** The verified session a standalone door's `identify` stands in for: user u1 of the header's org. */
const identify = (req: Request): any => {
  const org = req.headers.get('x-test-org');
  return { kind: 'subject', id: 'u1', roles: [], ...(org ? { orgId: org } : {}) };
};

/** (c2) createChatRoute (standalone), organization from the verified identity. */
export const standaloneChat: DoorFactory = {
  name: 'createChatRoute (standalone), organization from identify()',
  build(config) {
    const app = createChatRoute(config as never, { identify, protectionsBanner: false } as never) as any;
    return {
      name: this.name, orgs: ['acme', 'globex'],
      turn: async (org, threadId, text) => {
        const res: Response = await app.request('/agents/a/chat', {
          method: 'POST', headers: { 'content-type': 'application/json', ...(org ? { 'x-test-org': org } : {}) },
          body: JSON.stringify({ id: threadId, messages: [{ id: `m-${next()}`, role: 'user', parts: [{ type: 'text', text }] }] }),
        });
        return { status: res.status, body: await res.text() };
      },
    };
  },
};

/** (d2) createAguiRoute (standalone), organization from the verified identity. */
export const standaloneAgui: DoorFactory = {
  name: 'createAguiRoute (standalone), organization from identify()',
  build(config) {
    const handler = createAguiRoute(config as never, { identify, protectionsBanner: false } as never) as unknown as (r: Request) => Promise<Response>;
    return {
      name: this.name, orgs: ['acme', 'globex'],
      turn: async (org, threadId, text) => {
        const res = await handler(new Request('http://x/agents/a/run', {
          method: 'POST', headers: { 'content-type': 'application/json', ...(org ? { 'x-test-org': org } : {}) },
          body: JSON.stringify({ runId: `r-${next()}`, threadId, prompt: text }),
        }));
        return { status: res.status, body: await res.text() };
      },
    };
  },
};

/** (e) createA2AServer, organization from the verified identity; the A2A `contextId` is the thread. */
export const a2aServer: DoorFactory = {
  name: 'createA2AServer, organization from identify()',
  build(config) {
    const serve = createA2AServer(config as never, { identify, protectionsBanner: false } as never);
    return {
      name: this.name, orgs: ['acme', 'globex'],
      turn: async (org, threadId, text) => {
        const res = await serve(new Request('http://localhost/agents/a', {
          method: 'POST', headers: { 'content-type': 'application/json', ...(org ? { 'x-test-org': org } : {}) },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method: 'message/send', params: { message: {
            kind: 'message', role: 'user', messageId: `m-${next()}`, contextId: threadId, parts: [{ kind: 'text', text }],
          } } }),
        }));
        // A JSON-RPC error rides a 200; surface it as a failure status so "it worked" means it worked.
        const body = await res.text();
        let rpcError = false;
        try { rpcError = !!JSON.parse(body).error; } catch { /* not JSON */ }
        return { status: rpcError && res.status < 400 ? 599 : res.status, body };
      },
    };
  },
};

/** Every door that can bind a request to an organization. */
export const ORG_DOORS: readonly DoorFactory[] = [restRoleAuth, restOrgHeader, restChatSurface, restAguiSurface, standaloneChat, standaloneAgui, a2aServer];

// ── configs ─────────────────────────────────────────────────────────────────────────────────────
export { InMemoryStorage, signSubjectToken };
