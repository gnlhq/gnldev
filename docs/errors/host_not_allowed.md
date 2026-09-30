# host_not_allowed

**HTTP 403 · decision record**

## What happened

The server has no auth provider (or only a `{ read, write }` predicate pair, which has no identity), and
the request was addressed to it by a name that is not `localhost`, not a `*.localhost` name, not an IP
address and not listed in `allowedHosts` or `GNL_ALLOWED_HOSTS`. The body names the host it saw:

```json
{ "error": "this server has no auth provider, …", "code": "host_not_allowed", "host": "mybox.test" }
```

It applies to reads as well as writes, and to every route that asks the auth gate — the whole REST API,
and Studio's API except the pages that answer anybody even with auth on (the UI shell, health,
`/capabilities`, the API description).

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

With an auth provider that binds an identity (`roleAuth`, `@gnldev/auth-ee`), this check does not run: a
rebound page cannot read your bearer token, so the token is the defence, and any host name works.

## What to do

If the name is yours, list it — one line either way:

| You use | Option on `createRestApi` / `createStudioApp` | Or in the environment (`gnl dev`, `gnl studio`, your own server) |
| --- | --- | --- |
| A custom dev hostname (`/etc/hosts`, mDNS) | `allowedHosts: ['mybox.test']` | `GNL_ALLOWED_HOSTS=mybox.test` |
| A tunnel (ngrok, cloudflared) | `allowedHosts: ['.ngrok-free.app']` | `GNL_ALLOWED_HOSTS=.ngrok-free.app,.trycloudflare.com` |
| GitHub Codespaces port forwarding | `allowedHosts: ['.app.github.dev']` | `GNL_ALLOWED_HOSTS=.app.github.dev` |
| A Docker / Compose service name | `allowedHosts: ['api']` | `GNL_ALLOWED_HOSTS=api` |
| A proxy that sets its own `Host` | `allowedHosts: true` | `GNL_ALLOWED_HOSTS=*` |

A leading dot means the domain and every name under it. The option and the variable add up. A LAN IP
address, Docker's published `localhost:<port>`, and `127.0.0.1` need nothing.

Or configure auth (`gnl add auth`, or `auth: roleAuth({ … })`): a surface that authenticates its callers
answers any name — and a surface a tunnel exposes to the internet should authenticate its callers anyway.
