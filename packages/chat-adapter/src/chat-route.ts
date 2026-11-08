// CreateChatRoute: a single-endpoint Hono router speaking the Vercel AI SDK v5 `useChat` wire format —
// the ai-sdk-package counterpart of @gnldev/agui's createAguiRoute (AG-UI/CopilotKit) and @gnldev/server's
// PipeAgentStream (GNL's own SSE schema). Converts `UIMessage[]` -> `ModelMessage[]` via `ai`'s
// `convertToModelMessages` (export verified against the installed ai@7 package — tsc compiles this
// import against its .d.ts), streams the
// agent via `gnl.stream`, and returns the SENTINEL-MASKED UI message stream response (ui-stream.ts) —
// never the native, unmasked one.
import type { Context } from 'hono';
import { Hono } from 'hono';
import { convertToModelMessages } from 'ai';
import type { UIMessage } from 'ai';
import { createGnl, scopeConfigToOrg, endAnswerOf, requestRefusal, sealRequestContext, sealFieldsOf, resolveWorkIdentity, readJsonObject } from '@gnldev/durable';
import type { CreateGnlConfig } from '@gnldev/durable';
import { doorGate, AGENTS_RUN, markRefusal, settleDecision, decisionNotRecorded, type AccessDecision, type Authorize, type Identify, refuseMisplacedOptions, doorOptionKeys, REMOVED_IDENTITY_OPTIONS } from '@gnldev/auth';
import { refuseUnknownNames } from '@gnldev/options';
import { toUIMessageStreamResponse } from './ui-stream.js';
import { chatBodyProblem } from './chat-body.js';

/**
 * The request body as a JSON object (@gnldev/durable `readJsonObject`), or the 400 that says it is not
 * one. A body that was not JSON used to be read as `{}` and fail on a field it seemed to lack.
 */
async function jsonBody(c: Context): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; response: Response }> {
  const read = readJsonObject(await c.req.text());
  return read.ok ? read : { ok: false, response: c.json({ error: read.error, code: read.code }, 400) };
}

export interface CreateChatRouteOptions {
  /** Resolve the durable `runId` (exactly-once key for THIS request) from the request/body. */
  resolveRunId?: (c: Context, body: any) => string | undefined;
  /** Resolve the conversation `threadId` (memory continuity across requests) from the request/body. */
  resolveThreadId?: (c: Context, body: any) => string | undefined;
  /**
   * WHO is calling — the application's one answer (@gnldev/auth `Identify`), the same function it hands
   * @gnldev/server, @gnldev/agui and @gnldev/mcp. It reads a session cookie, a verified token or a user
   * store — never the body — and returns a `Principal`, or nothing for an anonymous request.
   *
   * The route maps the principal with `engineCallerOf` and hands the engine that caller:
   *
   *   subject      → that user; its runs and its thread are its own
   *   operator     → staff; reaches every run and thread in its organization
   *   application  → the end user it names in the body's `resourceId` — read for an application ONLY,
   *                  the same field @gnldev/server's REST routes read. Naming nobody is a 400.
   *   nothing      → unknown: the run is born ownerless-unknown and reaches no user's or staff's thread
   *
   * The organization comes from the principal (`orgId`), never from the body.
   *
   * Takes the web `Request`, not the Hono `Context`: a host binding this route from Express or Fastify
   * has a Request and no Context. Called ONCE per request.
   *
   * HONEST BOUND: this route ships with no auth of its own. An `identify` that trusts an
   * unauthenticated request asserts a caller nobody verified.
   */
  identify?: Identify;
  /**
   * WHAT the caller may do: the provider's `authorize`, the one @gnldev/server and @gnldev/studio ask.
   * `authorize: (p, req, ctx) => auth.authorize(p, req, ctx)`. Asked for `agents:run` before a run, so a
   * role without it (auth-ee's `viewer`, roleAuth's `viewer`) is refused here as it is on the REST API.
   * WITHOUT it this route checks identity and ownership only: every identified caller may run.
   */
  authorize?: Authorize;
  /**
   * Report each request's outcome — who asked, allowed or refused and why, the status it got — to the
   * same hook @gnldev/server and @gnldev/studio report to (@gnldev/auth `AuthProvider.onDecision`). Pass
   * the provider's: `identify: (req) => auth.authenticate(req), onDecision: (d) => auth.onDecision?.(d)`.
   *
   * An option rather than a provider, because this route is handed `identify` and nothing else; it
   * authorizes nothing itself, so what it reports is who asked and what the engine answered — a foreign
   * thread or run (409 `thread_owner_mismatch` / `run_owner_mismatch` / `run_actor_mismatch`) is recorded
   * as an ownership refusal. WITHOUT it this route leaves no record. If it throws, the route answers 500.
   */
  onDecision?: (decision: AccessDecision) => void | Promise<void>;
  /**
   * Host names this route also answers for a request with no identity, besides `localhost`,
   * `*.localhost` and any IP address — the same list, forms and meaning as `allowedHosts` on
   * `createRestApi` (a hostname, a leading-dot domain like `'.ngrok-free.app'`, or `true` for every
   * name); `GNL_ALLOWED_HOSTS` adds to it.
   *
   * A request carries an identity when `identify` resolved a principal for it. One that did not — no
   * `identify`, or an `identify` that answered nothing (an anonymous visitor, `() => undefined`) — gets
   * what a providerless REST API gets: a request addressed by any other name is refused (403
   * `host_not_allowed` — the DNS-rebinding shape, where the rebound page could read a thread back), and
   * so is a state-changing request a page on another site sent (403 `cross_site_refused`; see
   * `allowCrossSite`). Having `identify` does not switch either check off; resolving a caller does.
   */
  allowedHosts?: readonly string[] | true;
  /**
   * `true` for a route that pages on OTHER sites are meant to call with no identity — a chat widget
   * embedded on a customer's website. Lifts the cross-site check (403 `cross_site_refused`) for a request
   * with no identity, and nothing else: the host rule keeps `allowedHosts`. Without it, such a page
   * needs a request that carries an identity (`identify` resolving a verified token).
   */
  allowCrossSite?: boolean;
  /** Print this door's protections when it is built (default `true`); `false` when something else already prints them. */
  protectionsBanner?: boolean;
}


let anonCounter = 0;

/**
 * A run's ending as the chat route answers it BEFORE the stream exists — rendered from
 * @gnldev/durable#endAnswerOf, the one mapping @gnldev/server and AG-UI render too (the dependency
 * direction is chat-adapter → durable, never → server). Before it, this catch collapsed everything it did
 * not copy to a flat 400, so a concurrent duplicate of the same runId (`run_busy`, "retry later and you'll
 * get the replay") read as "your request was malformed" — a retrying client told to stop at the moment
 * retrying is right. Undefined: an error of the host's own.
 */
function typedErrorResponse(c: Context, e: unknown, workKey?: string): Response | undefined {
  const a = endAnswerOf(e, workKey);
  if (!a) return undefined;
  if (a.ownership) markRefusal(c.req.raw, 'ownership', { detail: a.code });
  return c.json(a.body, a.status as 409, a.headers);
}

/** Every option createChatRoute takes in its SECOND argument, held to `CreateChatRouteOptions` by `pnpm typecheck` below. */
const CHAT_ROUTE_OPTION_KEYS = doorOptionKeys<CreateChatRouteOptions>()(['resolveRunId', 'resolveThreadId', 'identify', 'authorize', 'onDecision', 'allowedHosts', 'allowCrossSite', 'protectionsBanner']);

/**
 * Produces a single-endpoint Hono router from a createGnl config (or an already-built `gnl` instance)
 * that a `useChat({ api: '.../agents/:name/chat' })` client can talk to:
 * POST /agents/:name/chat   { id?, messages: UIMessage[], runId?, threadId?, approvals? }  → UI message stream
 * Deliberately kept small — SAME posture as @gnldev/agui's `createAguiRoute`: NO auth/org/budget gates (if
 * needed, wrap this route, or compose @gnldev/server's createRestApi's auth middleware around it — see README).
 *
 * IDENTITY precedence: `body.runId` > `opts.resolveRunId(...)` > the TURN'S NAME
 * (`Idempotency-Key` header, else DERIVED `${body.id}:${lastMessage.id}`) > a generated id. The
 * derivation is the load-bearing default: `body.id` is useChat's STABLE per-conversation id — using
 * it ALONE would make every later turn replay turn 1 from the journal (withDurableModel replays
 * `runId:model:0` and the model never runs again). Combining it with the LAST message's id (useChat
 * stamps a fresh id per message) gives one exactly-once run PER TURN, and makes a network retry of
 * the SAME turn land on the same run (deduped replay — free idempotency) while a NEW turn runs fresh.
 * `threadId` defaults to `body.id` (the conversation), NOT the per-turn key — conversation memory
 * must span turns.
 *
 * TWO REGIMES, decided by whether the route can name a SUBJECT (package #5, §7). With one, the
 * turn's name is a `workKey` and the engine derives an opaque `run1_` id from it; without one it
 * stays the raw id it has always been, because deriving needs an address (§6) and this route's
 * quickstart names nobody. The retry contract is identical either way: the same message ids produce
 * the same key, and the same key lands on the same run.
 *
 * SCOPE of that idempotency: a turn's run executes once, apart from the request (@gnldev/durable's
 * executor) — a CONCURRENT duplicate (double-click, two tabs, a retry racing the original) follows the
 * same run instead of executing it again, and a client that leaves gets the answer when it comes back. The effective
 * RunId is echoed on every response as `X-Gnl-Run-Id` and stamped onto interrupt chunks — a
 * CORRELATION handle, not the retry key: to retry, send the same turn again. One exception, agui's
 * too: a pre-run identity refusal (unknown agent, unaddressable scope) carries no header, because
 * the header names a run and none exists yet on that path.
 *
 * Body `workKey` is deliberately NOT read here (the REST, agui and workflow doors all take it):
 * this route speaks the useChat wire format, where the turn IS the work — the per-turn key above,
 * or a gateway's `Idempotency-Key`, is what gets promoted. A field the UI library never sends would
 * be dead surface with a live failure mode (a stale key silently pinning every turn to one run).
 */
export function createChatRoute(
  config: CreateGnlConfig | { gnl: ReturnType<typeof createGnl> },
  opts: CreateChatRouteOptions = {},
): Hono {
  refuseMisplacedOptions('createChatRoute', config, opts, CHAT_ROUTE_OPTION_KEYS, undefined, REMOVED_IDENTITY_OPTIONS);
  // A prebuilt `{ gnl }` is the whole config: anything beside it would be read by nothing.
  if ('gnl' in config) refuseUnknownNames('createChatRoute: config', config, ['gnl']);
  const rootGnl = 'gnl' in config ? config.gnl : createGnl(config);
  // One instance per organization, over that organization's partition (see @gnldev/durable
  // `scopeConfigToOrg`). A prebuilt `{ gnl }` carries no config to scope, so it stays as handed in.
  const orgGnls = new Map<string, ReturnType<typeof createGnl>>();
  const gnlFor = (org: string | undefined): ReturnType<typeof createGnl> => {
    if (!org || 'gnl' in config) return rootGnl; // `{ gnl }` + an org is refused before this is asked
    let g = orgGnls.get(org);
    if (!g) orgGnls.set(org, (g = createGnl(scopeConfigToOrg(config, org).config)));
    return g;
  };
  // Who is calling, the open-surface checks for a request with no identity, the role: @gnldev/auth's
  // `doorGate`, the one preamble every door runs. In production a route with no `identify` refuses to
  // start (it used to warn and serve: every caller ran the model and left an ownerless run, measured).
  const admit = doorGate({
    door: 'createChatRoute',
    identify: opts.identify,
    authorize: opts.authorize,
    allowedHosts: opts.allowedHosts,
    allowCrossSite: opts.allowCrossSite,
    protectionsBanner: opts.protectionsBanner,
    restMount: 'createRestApi(config, { auth, surfaces: [chatSurface()] })',
  });
  const app = new Hono();
  // The outcome, reported once the route has answered (see `onDecision`).
  if (opts.onDecision) {
    const onDecision = opts.onDecision;
    app.use('*', async (c, next) => {
      await next();
      try {
        await settleDecision(onDecision, c.req.raw, c.res.status);
      } catch (err) {
        c.res = decisionNotRecorded(err);
      }
    });
  }
  app.post('/agents/:name/chat', async (c) => {
    const name = c.req.param('name');
    const parsedBody = await jsonBody(c); if (!parsedBody.ok) return parsedBody.response;
    const body = parsedBody.value as {
      id?: string;
      messages?: UIMessage[];
      runId?: string;
      threadId?: string;
      approvals?: Record<string, boolean>;
      context?: Record<string, unknown>;
      resourceId?: unknown;
    };
    const lastMsg = body.messages?.[body.messages.length - 1];
    // WHO, resolved once and FIRST: the key decision below cannot be made without the subject, and a
    // resolver that reads the request may answer differently the second time. `body.resourceId` is
    // read for an APPLICATION principal only — a user or staff naming someone in the body names nobody.
    // The body is read before the refusals: reading it changes nothing, and nothing has run yet.
    const who = await admit(c.req.raw, { named: body.resourceId, permission: AGENTS_RUN });
    if ('refused' in who) return Response.json(who.refused.body, { status: who.refused.status });
    const caller = who.caller;
    const subject = caller.kind === 'user' ? caller.id : undefined;
    // WHICH ORGANIZATION: the principal's, never the body's. An org is an isolation boundary, and a
    // caller who picks their own has none (sealRequestContext strips the reserved key for this reason).
    const org = caller.kind === 'unknown' ? undefined : caller.orgId;
    // A prebuilt `{ gnl }` is ONE instance over one storage, so it cannot be split by organization.
    // Serving an org-bound turn from it put two organizations' identical turns on one run id —
    // measured: globex was replayed acme's answer. Refused, loudly, rather than served across the line.
    if (org && 'gnl' in config) {
      return c.json({
        error: 'this chat route was built from a prebuilt `{ gnl }` instance, which cannot keep organizations apart, '
          + `and \`identify\` named organization '${org}'. Pass the config (createChatRoute(config, ...)) so each `
          + 'organization gets its own partition.',
      }, 500);
    }
    // The organization's instance. A config whose `memory` cannot be split for it is refused here by
    // @gnldev/durable's one rule (`scopeConfigToOrg`), and answered as every door answers it.
    let gnl: ReturnType<typeof createGnl>;
    try { gnl = gnlFor(org); } catch (e) {
      const refused = requestRefusal(e);
      if (!refused) throw e;
      return c.json(refused.body, refused.status, refused.headers);
    }
    // A RAW id, when the caller is holding one. `body.runId` and `resolveRunId` both name an ID (the
    // second one says so in its name), so neither is promoted — a host that hands us an id has
    // already decided the addressing.
    const rawId = body.runId ?? opts.resolveRunId?.(c, body);
    // THE TURN'S NAME. `${body.id}:${lastMessage.id}` is what this route has always derived, and the
    // `Idempotency-Key` header is the same declaration arriving from a gateway instead. Deliberately
    // AFTER the two raw resolvers (heyet kararı 1.5): the header is often stamped by a proxy, while a
    // body/host decision is explicit, and header-first would let an intermediary redefine the turn.
    const workName = c.req.header('Idempotency-Key') ?? (body.id && lastMsg?.id ? `${body.id}:${lastMsg.id}` : undefined);
    let runId: string | undefined = rawId;
    let workKey: string | undefined;
    if (!runId && workName) {
      // THE PROMOTION, and the concession that comes with it (package #5, §7).
      //
      // With a subject, the turn's name is a `workKey`: the engine derives `run1_<digest>` and the
      // client-controlled string stops being a journal key prefix. That closes bug class 2 (§2) at
      // its documented source — `conv` and `conv:msg1` were exactly this derivation's shape.
      //
      // WITHOUT a subject it stays what it has always been: a raw runId. Deriving a name into an id
      // needs an ADDRESS (§6, fail-closed), and this route ships with no auth and a `useChat`
      // quickstart that names nobody. Refusing those would replace a working first five minutes
      // with a 400 — so the anonymous regime is preserved byte for byte, and the protection matrix's
      // identity row is where a deployment reads which of the two it is in.
      if (subject) {
        try {
          const identity = resolveWorkIdentity(`agent:${name}`, {
            workKey: workName,
            // The agent's own declaration, read off the registry rather than guessed: the route has
            // no business deciding which address a name is unique within (see AgentConfig.workScope).
            scopeKind: gnl.agent(name).workScope ?? 'resource',
            resourceId: subject,
            // THE ORG, and it is not optional decoration — @gnldev/server passes it on the REST
            // route, and an `'org'` workScope with no org falls back to the deployment sentinel
            // (§10.2). Without this line the same organization's same named work derives one id
            // through REST and another through here: not an error, a DUPLICATE, decided by whichever
            // surface the request came in on.
            ...(org ? { orgId: org } : {}),
            anonymous: 'refuse',
            surface: `POST /agents/${name}/chat`,
          });
          runId = identity.runId!;
          workKey = identity.work?.workKey;
        } catch (e: any) {
          // An unknown agent, or a scope that cannot be addressed. There is no run to correlate with,
          // so no X-Gnl-Run-Id either — the header names a run, and there is none.
          return c.json({ error: String(e?.message ?? e) }, 400);
        }
      } else {
        runId = workName;
      }
    }
    if (!runId) {
      // Anon fallback: a fresh id per request = ZERO dedup — a network retry of this exact request
      // Runs the turn again. Deliberately NOT content-hashed (two intentional identical requests must
      // stay two runs); the fix is the contract, not magic: the response's X-Gnl-Run-Id header hands
      // the client the key to retry with.
      // Sayaç MODÜL düzeyinde: her replika kendi sıfırından sayar. Ortak journal üstünde iki
      // süreç aynı milisaniyede `chat-<ms>-0` üretir ve İKİ FARKLI kullanıcının isteği tek koşuma
      // düşer — dedup yokluğu değil, YANLIŞ dedup: ikinci istek birincinin adımlarını replay eder.
      // Süreç-dışı entropi bunu kapatır. Doğru çözüm hâlâ istikrarlı bir runId GÖNDERMEK; aşağıdaki
      // uyarı onu söylüyor, bu satır yalnız çarpışmayı engelliyor.
      runId = `chat-${Date.now()}-${anonCounter++}-${crypto.randomUUID().slice(0, 8)}`;
      console.warn(
        `[gnl chat-route] no runId derivable (body.runId / resolveRunId / body.id+message.id all absent) — generated '${runId}'. Retries of this request will NOT dedupe; send body.runId (echoed back as X-Gnl-Run-Id) so retries land on the same run.`,
      );
    }
    // The conversation id (NOT the per-turn runId) anchors memory — see the runId note in the JSDoc.
    // Choosing a conversation is not an identity claim: the ENGINE checks the thread's owner against
    // the caller (admitThreadRun), so a user naming staff's or another user's thread is refused there.
    const threadId = opts.resolveThreadId?.(c, body) ?? body.threadId ?? body.id ?? runId;
    // V1: `tools` is not passed to convertToModelMessages — a conversation whose CLIENT-side history
    // still carries tool-invocation parts from a prior turn round-trips as best-effort (text/reasoning
    // are unaffected). Fine for the common case (server-side history via toUIMessages + threadId memory
    // is the durable source of truth); documented rather than silently assumed complete.
    // AWAITED: `convertToModelMessages` is async in AI SDK 7 (it was synchronous in v5). Passing the
    // un-awaited Promise straight through as `messages` sent a Promise into the run — the journal
    // then tried to structuredClone it and every chat request failed with
    // "#<Promise> could not be cloned", i.e. a flat 400 on the whole route.
    // INSIDE the try below: conversion throws on CLIENT-controlled input (a malformed `messages`
    // shape, an unsupported part type) — outside the try that surfaced as Hono's bare 500 with no
    // typed body and NO X-Gnl-Run-Id, breaking the every-response header contract on exactly the
    // malformed-request path. In the catch it falls through typedErrorResponse (no match) to the
    // generic 400, which is what a malformed request is.
    let result: any;
    {
      // The body's shape, said before the converter: its own TypeError is not an answer a client can act on.
      // The run id is already derived, so the header contract holds on this path too.
      const problem = chatBodyProblem(body);
      if (problem) {
        const res = c.json({ error: `invalid chat request: ${problem}` }, 400);
        res.headers.set('X-Gnl-Run-Id', runId);
        return res;
      }
    }
    try {
      const messages = await convertToModelMessages(body.messages ?? []);
      result = await gnl.stream(name, {
        // The NAME when the turn key was promoted, the raw id otherwise. The door re-resolves the
        // same tuple and lands on the same id — passing the id instead would drop the declaration,
        // and the declaration is what makes "which run was this turn?" answerable in Studio.
        ...(workKey !== undefined ? { workKey } : { runId }),
        messages,
        threadId,
        approvals: body.approvals,
        // WHO answers them — the one mapping (@gnldev/auth `answererOf`, via the door's admission); the engine decides what they may answer.
        ...(who.answerer ? { answerer: who.answerer } : {}),
        // HER ZAMAN mühürlü — kimlik bilinmese bile. Ayrılmış anahtarlar motorun "bunu sunucu
        // doğruladı" kanalıdır; mühürsüz bir gövde o kanalın sahibi olur. Kimlik yoksa anahtarlar
        // silinir (fail-closed), çözücü varsa sunucunun değeri yazılır.
        // The org travels in the SEAL as well as into the derivation above — the two must not
        // disagree. `sealRequestContext` writes the reserved `__gnl_orgId`/`org` keys from what the
        // SERVER established, so an org-scoped run's record and its dynamic `system`/`tools` see the
        // same organization the id was derived under, and a body that named its own is stripped.
        context: sealRequestContext(body.context ?? {}, sealFieldsOf(caller, org)),
        // THE CALLER, from the one mapping. The seal above carries the same decision into the
        // context (it wins in the engine), and an `unknown` seals nothing: it stays closed.
        caller,
        // No request signal: the run executes apart from this request (@gnldev/durable). A closed tab ends
        // this response, not the turn — its answer is in the thread when the user comes back.
      });
    } catch (e: any) {
      const res = typedErrorResponse(c, e, workKey) ?? c.json({ error: String(e?.message ?? e) }, 400);
      res.headers.set('X-Gnl-Run-Id', runId);
      return res;
    }
    // Every response (success AND error) echoes the effective runId — the client-side retry key is a
    // contract, not something the caller has to re-derive from useChat internals. The SAME runId is
    // stamped onto `data-gnl-interrupt` chunks (FAZ-2) so an approval addresses THIS run.
    const res = toUIMessageStreamResponse(result, { runId });
    res.headers.set('X-Gnl-Run-Id', runId);
    // FAZ-7: the engine's replay signal — 'replay' when this runId had frozen input before the call
    // (a resume/retry landing on journal state), 'new' on a fresh run. An observability contract for
    // reconciliation, NOT a byte-identity guarantee.
    res.headers.set('X-Gnl-Idempotency-Status', (result as { __gnlPriorRun?: boolean })?.__gnlPriorRun ? 'replay' : 'new');
    return res;
  });
  return app;
}
