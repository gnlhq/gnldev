# cross_site_refused

**HTTP 403 · decision record**

## What happened

A page on another site sent a state-changing request (`POST`, `PUT`, `PATCH`, `DELETE`) to a surface
that has no identity to authenticate — a REST API or Studio with no auth provider (or only a
`{ read, write }` pair), or a standalone door (`createChatRoute`, `createAguiRoute`, `createMcpServer`
over HTTP) with no `identify`. The browser said so: `Sec-Fetch-Site: cross-site`, or, from a client that
does not send Fetch Metadata, an `Origin` naming another host (or `null`).

```json
{ "error": "a page on another site sent a state-changing request …", "code": "cross_site_refused" }
```

## Why the framework refuses

A plain `<form enctype="text/plain" method="post">` on any website can post to
`http://localhost:4111/agents/a/chat` without a CORS preflight. Before this refusal existed on the doors,
measured on a real loopback socket: such a request ran the model (on your key) and appended the page's
text to a conversation. With no identity there is no way to tell your own request from one a page caused,
so the request is refused before anything runs.

Requests from this machine's own sites are not refused: a UI on `http://localhost:5173` calling an API on
`http://localhost:4111` is `same-site` (ports do not make a different site), so the documented dev setup
works unchanged. Reads (`GET`, `HEAD`, `OPTIONS`) are not refused by this check — a cross-site page cannot
read their answers.

## What to do

If another site really is meant to call the surface, give the surface an identity to check — one line:

| Surface | Way through |
| --- | --- |
| `createRestApi` / `createStudioApp` | `auth: roleAuth({ admin: { token } })` (or any provider that binds an identity): a page on another site cannot read your bearer token, so it cannot ride it |
| `createChatRoute` / `createAguiRoute` / `createMcpServer` | `identify: (req) => principal` from a verified token — or `identify: () => undefined` to declare, on purpose, that the door has no per-user identity (both checks then stop) |

Or serve the page from this machine's own site: proxy the API through your dev server (Vite's
`server.proxy`), which makes the request same-origin.

A request addressed by a name other than `localhost` or an IP address is refused by the other half of the
same protection — see [`host_not_allowed`](./host_not_allowed.md).
