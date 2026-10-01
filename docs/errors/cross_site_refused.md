# cross_site_refused

**HTTP 403 · decision record**

## What happened

A page on another site sent a state-changing request (`POST`, `PUT`, `PATCH`, `DELETE`) to a surface
that has no identity to authenticate — a REST API or Studio with no auth provider (or only a
`{ read, write }` pair), or a standalone door (`createChatRoute`, `createAguiRoute`, `createMcpServer`
over HTTP) for a request that resolved no caller — the door has no `identify`, or its `identify` answered
nothing for this request (an anonymous visitor, or `identify: () => undefined`). Having an `identify`
does not turn the check off; resolving a caller does. The browser said the page was on another site:
`Sec-Fetch-Site: cross-site`, or, from a client that does not send Fetch Metadata, an `Origin` naming
another host (or `null`). On MCP the refusal is a JSON-RPC error with code `-32000` and
`data: { code: "cross_site_refused" }`.

```json
{ "error": "a page on another site sent a state-changing request …", "code": "cross_site_refused" }
```

## Why the framework refuses

A plain `<form enctype="text/plain" method="post">` on any website can post to
`http://localhost:4111/agents/a/chat` without a CORS preflight. Before this refusal existed on the doors,
measured on a real loopback socket: such a request ran the model (on your key) and appended the page's
text to a conversation. With no identity there is no way to tell your own request from one a page caused,
so the request is refused before anything runs.

A page served from this machine is not refused: an `Origin` of `localhost`, `*.localhost`, `127.0.0.1`
(any `127.x.x.x`) or `[::1]`, on any port. A UI on `http://localhost:5173` calling an API on
`http://localhost:4111` is `same-site` anyway (ports do not make a different site); a UI on
`http://127.0.0.1:5173` calling `http://localhost:3000` is marked `cross-site` by the browser —
`127.0.0.1` and `localhost` are different sites — and is answered too, because no site on the internet
can carry a loopback `Origin` (the browser writes it). A page on a LAN address calling the same address
on another port is `same-site`. Reads (`GET`, `HEAD`, `OPTIONS`) are not refused by this check — a
cross-site page cannot read their answers.

## What to do

If another site really is meant to call the surface — one line:

| Surface | Way through |
| --- | --- |
| `createRestApi` / `createStudioApp` | `auth: roleAuth({ admin: { token } })` (or any provider that binds an identity): a page on another site cannot read your bearer token, so it cannot ride it |
| `createChatRoute` / `createAguiRoute` / `createMcpServer`, embedded on other sites with no sign-in (a public chat widget on a customer's website) | `allowCrossSite: true` in the door's options. It lifts this check only: the door still answers only the names in [`host_not_allowed`](./host_not_allowed.md), so list the name it is served under — `allowedHosts: ['chat.example.com']` |
| `createChatRoute` / `createAguiRoute` / `createMcpServer`, for signed-in users | `identify: (req) => principal`, reading a verified token: a request it resolves a caller for carries an identity, and neither check runs for it |

`identify: () => undefined` is not a way through: an `identify` that answers nothing resolves no caller,
so the request is checked like a request to a door with no `identify`.

Or serve the page from this machine's own site: proxy the API through your dev server (Vite's
`server.proxy`), which makes the request same-origin.

A request addressed by a name other than `localhost` or an IP address is refused by the other half of the
same protection — see [`host_not_allowed`](./host_not_allowed.md).
