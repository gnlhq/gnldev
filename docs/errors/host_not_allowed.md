# host_not_allowed

**HTTP 403 · decision record**

## What happened

The surface has no identity to authenticate, and the request was addressed to it by a name that is not
`localhost`, not a `*.localhost` name, not an IP address and not listed in `allowedHosts` or
`GNL_ALLOWED_HOSTS`. "No identity" is one of four things, and the message says which:

- a REST API or Studio with **no auth provider** — `"this server has no auth provider, …"`;
- one whose auth is a **`{ read, write }` predicate pair** (or a provider with `bindsIdentity: false`) —
  `"this server's auth names no identity (a { read, write } pair, …)"`. The pair is refused too, even
  when its predicates check a token: a predicate is opaque, and a rebound page is same-origin, so it may
  send any header it likes — an `Authorization` header included. Nothing can tell a predicate that checks
  a secret from one that checks that a header is present. A request the pair itself refuses is answered
  with the pair's refusal, under any name;
- a request to a REST API or Studio whose provider **binds identities** (`roleAuth`, `@gnldev/auth-ee`, a
  provider of your own) that **resolved to no caller** — no credential, or one the provider named nobody
  with — **and that the provider allowed anyway** (a provider that serves anonymous reads) —
  `"this request resolved to no caller (the auth provider named nobody for it) and the provider allowed it
  anyway …"`. A request the provider refuses is answered with its own refusal (`roleAuth`'s 401 for no
  token), whatever the name;
- a request to a standalone door — `createChatRoute`, `createAguiRoute`, or `createMcpServer` over HTTP
  — that **resolved no caller**: the door has no `identify`, or its `identify` answered nothing for this
  request (an anonymous visitor, or `identify: () => undefined`) — `"this request carried no identity the
  createChatRoute door resolved …"`. Having an `identify` does not turn the rule off; resolving a caller
  does. A door handed `authorize` asks it first: an anonymous request it refuses is answered with that
  refusal (`roleAuth`'s 401), whatever the name, and only one it allows is checked here. On MCP it is a JSON-RPC error with code `-32000` and `data: { code: "host_not_allowed", host }`.

The body names the host it saw:

```json
{ "error": "this server has no auth provider, …", "code": "host_not_allowed", "host": "mybox.test" }
```

It applies to reads as well as writes, and to every route that asks the auth gate — the whole REST API,
and Studio's API except the pages that answer anybody even with auth on (the UI shell, health,
`/capabilities`, the API description) — and to every request a door receives that resolved no caller.

## Why the framework refuses

A server with no auth is meant to be open to this machine. It is not meant to be open to every page this
machine's browser visits, and DNS rebinding turns one into the other: a page is served from
`http://evil.example:4747`, `evil.example` is then pointed at `127.0.0.1`, and the page's own requests go
to your server. The browser treats them as **same-origin**, so the cross-site check (`Sec-Fetch-Site`)
lets them through, and the page can read what it is answered. Measured before this refusal existed: such a
page purged Studio's runs, ran an agent on the REST API (spending your model key), and read the run list —
prompts and tool arguments included.

The one thing the page cannot choose is the `Host` header: the browser writes the page's own name there.
So the refusal is on that name. `localhost`, `*.localhost` and IP addresses are always answered — no one
else can point them anywhere, which is also why a LAN address (`http://192.168.1.20:4747`) works with no
setting. Any other name might be somebody else's, so it has to be named by you.

With an auth provider that binds an identity (`roleAuth`, `@gnldev/auth-ee`), a request that carries a
credential the provider resolves to a caller is answered under any name: a rebound page cannot read your
bearer token, so the token is the defence. A request that carries none has no token to be the defence, so
if the provider allows it anyway, the name is checked as above. Measured before this: Studio with a
provider serving anonymous reads answered a rebound page's `GET /runs` — prompts included.

## What to do

If the name is yours, list it — one line either way:

| You use | Option on `createRestApi` / `createStudioApp` | Or in the environment (`gnl dev`, `gnl studio`, your own server) |
| --- | --- | --- |
| A custom dev hostname (`/etc/hosts`, mDNS) | `allowedHosts: ['mybox.test']` | `GNL_ALLOWED_HOSTS=mybox.test` |
| A tunnel (ngrok, cloudflared) | `allowedHosts: ['.ngrok-free.app']` | `GNL_ALLOWED_HOSTS=.ngrok-free.app,.trycloudflare.com` |
| GitHub Codespaces port forwarding | `allowedHosts: ['.app.github.dev']` | `GNL_ALLOWED_HOSTS=.app.github.dev` |
| A Docker / Compose service name | `allowedHosts: ['api']` | `GNL_ALLOWED_HOSTS=api` |
| A container reaching the host (`host.docker.internal`) | `allowedHosts: ['host.docker.internal']` | `GNL_ALLOWED_HOSTS=host.docker.internal` |
| A proxy that sets its own `Host` | `allowedHosts: true` | `GNL_ALLOWED_HOSTS=*` |

On a standalone door the option goes in its own options: `createChatRoute(config, { allowedHosts })`,
`createAguiRoute(config, { allowedHosts })`, `createMcpServer({ …, allowedHosts })`.

**The forms an entry takes.** A leading dot means the domain and every name under it:
`'.ngrok-free.app'` answers `abc123.ngrok-free.app` and `ngrok-free.app`. `'*.ngrok-free.app'` is read as
the same thing. A tunnel hands out a new name each session, so list its domain, not today's name — the
403 suggests the leading-dot form when it recognises a tunnel. A URL or a port is read as its hostname:
`'http://mybox.test:4111'` and `'mybox.test:4111'` both mean `mybox.test`. An entry that could never match
a `Host` header — `'*'` (use `true`), a wildcard in the middle of a name (`'api.*.example.com'`: list the
names you use, or the leading-dot domain you own — the error never guesses a broader one for you), a
space — is refused where the server or door is built, with the fix in the error; in `GNL_ALLOWED_HOSTS`
it is skipped with a warning naming it. `'localhost:*'` is read as `localhost` (a port is never
compared), and an IPv6 address may be written with or without brackets (`'::1'`, `'[::1]'`). The option
and the variable add up.

**When `GNL_ALLOWED_HOSTS` is read.** On every request (memoised on its value), so a value loaded by
dotenv after the module that builds the server still applies — no restart order to get right. A LAN IP
address, Docker's published `localhost:<port>`, and `127.0.0.1` need nothing.

Or configure auth (`gnl add auth`, or `auth: roleAuth({ … })`): a surface that authenticates its callers
answers any name — and a surface a tunnel exposes to the internet should authenticate its callers anyway.
With a `{ read, write }` pair whose predicates check a token, that is the way to keep your token check and
answer any name: `auth: roleAuth({ admin: { token: process.env.API_TOKEN! } })`. On a door, a request
that `identify` resolves a caller for does the same: `identify: (req) => principal`, from a verified
token. A request it resolves nobody for is still answered only by the names above.

A state-changing request that a page on **another site** sent is refused by the other half of the same
protection — see [`cross_site_refused`](./cross_site_refused.md).
