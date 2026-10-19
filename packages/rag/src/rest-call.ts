import http from 'node:http';
import https from 'node:https';

/** Answered for a 409 when the caller asked for it: "someone made it first", not a failure. */
export const CONFLICT = Symbol('conflict');

export type RestCall = (method: string, path: string, body?: unknown, missingIsUndefined?: boolean, conflictIsSymbol?: boolean) => Promise<unknown>;

export interface RestService {
  /** The service's name in messages: `Qdrant`, `Chroma`. */
  name: string;
  /** Headers every call carries (an API key among them). Their values never go into a message. */
  headers: Record<string, string>;
  /** The answer's payload from the parsed body (Qdrant wraps it in `result`). */
  result: (body: any) => unknown;
  /** What of a failed answer's body goes into the message, at most 200 characters. */
  detail: (body: any) => unknown;
}

/**
 * One JSON call over REST with `node:http`/`node:https`, a kept-alive connection, no dependency.
 *
 * NOT `fetch`, and measured why: the global `fetch` (undici) on a kept-alive connection waited ~40 ms on
 * every response that carried a payload (43 ms against 1.1 ms through `node:http`, the same Qdrant query,
 * the same server; `curl` 1.5 ms) — 100 queries took 4.4 s instead of 77 ms.
 */
export function restCall(url: string, service: RestService): RestCall {
  const base = new URL(url);
  const lib = base.protocol === 'https:' ? https : http;
  const agent = new lib.Agent({ keepAlive: true });
  const prefix = base.pathname.replace(/\/+$/, '');
  return (method, path, body, missingIsUndefined = false, conflictIsSymbol = false) => new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const where = `${service.name} ${method} ${path.split('?')[0]}`;
    const req = lib.request({
      protocol: base.protocol, hostname: base.hostname, port: base.port, path: `${prefix}${path}`, method, agent,
      headers: { 'content-type': 'application/json', ...(data ? { 'content-length': Buffer.byteLength(data) } : {}), ...service.headers },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        if (missingIsUndefined && status === 404) return resolve(undefined);
        if (conflictIsSymbol && status === 409) return resolve(CONFLICT);
        let j: any = {};
        try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not JSON: reported below by status */ }
        if (status < 200 || status >= 300) {
          return reject(Object.assign(new Error(`@gnldev/rag: ${where} answered ${status} ${JSON.stringify(service.detail(j) ?? '').slice(0, 200)}`), { status }));
        }
        resolve(service.result(j));
      });
    });
    req.on('error', (e) => reject(new Error(`@gnldev/rag: ${where} failed: ${e.message}`)));
    req.end(data);
  });
}
