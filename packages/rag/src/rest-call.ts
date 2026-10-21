import http from 'node:http';
import https from 'node:https';

/** Answered for a 409 when the caller asked for it: "someone made it first", not a failure. */
export const CONFLICT = Symbol('conflict');

/** A body of newline-delimited JSON lines, sent as written (`application/x-ndjson`). */
export class NdJson {
  readonly text: string;
  constructor(lines: unknown[]) { this.text = lines.map((l) => JSON.stringify(l)).join('\n') + '\n'; }
}

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
  /** How long one call may take, from sending it to the answer's last byte (default 30 000 ms). */
  timeoutMs?: number;
}

/** The default `timeoutMs`, the same as the A2A tool's. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * One JSON call over REST with `node:http`/`node:https`, a kept-alive connection, no dependency.
 *
 * NOT `fetch`, and measured why: the global `fetch` (undici) on a kept-alive connection waited ~40 ms on
 * every response that carried a payload (43 ms against 1.1 ms through `node:http`, the same Qdrant query,
 * the same server; `curl` 1.5 ms) — 100 queries took 4.4 s instead of 77 ms.
 */
export function restCall(url: string, service: RestService): RestCall {
  const timeoutMs = service.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError(`@gnldev/rag: ${service.name} \`timeoutMs\` is a number of milliseconds above 0`);
  }
  const base = new URL(url);
  const lib = base.protocol === 'https:' ? https : http;
  const agent = new lib.Agent({ keepAlive: true });
  const prefix = base.pathname.replace(/\/+$/, '');
  return (method, path, body, missingIsUndefined = false, conflictIsSymbol = false) => new Promise((resolve, reject) => {
    // A body already written out is sent as it is — newline-delimited JSON, Elasticsearch's `_bulk`.
    const data = body === undefined ? undefined : body instanceof NdJson ? body.text : JSON.stringify(body);
    const type = body instanceof NdJson ? 'application/x-ndjson' : 'application/json';
    const where = `${service.name} ${method} ${path.split('?')[0]}`;
    const req = lib.request({
      protocol: base.protocol, hostname: base.hostname, port: base.port, path: `${prefix}${path}`, method, agent,
      headers: { 'content-type': type, ...(data ? { 'content-length': Buffer.byteLength(data) } : {}), ...service.headers },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('error', (e) => reject(new Error(`@gnldev/rag: ${where} failed: ${e.message}`)));
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
    // A deadline for the whole call, not an idle timer: a server that answers a byte at a time is cut
    // too. A write cut here may still land on the server; the stores' writes are upserts by a derived
    // id, so the same call again is safe.
    const timer = setTimeout(() => {
      reject(Object.assign(new Error(`@gnldev/rag: ${where} timed out after ${timeoutMs} ms`), { timedOut: true }));
      req.destroy();
    }, timeoutMs);
    req.on('close', () => clearTimeout(timer));
    req.on('error', (e) => reject(new Error(`@gnldev/rag: ${where} failed: ${e.message}`)));
    req.end(data);
  });
}
