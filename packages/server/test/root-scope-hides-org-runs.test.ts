// Invariant (ADR-0001): in the root scope, every organization's rows are hidden — RUNS included.
//
// Memory already held this (a root `listThreads` / `recall` covers the root's rows only). Runs did not:
// an organization's run sits in the root journal as `org:<id>:<runId>`, and the root scope's reader was
// the raw journal, so `GET /runs` at the root listed `org:acme:r-acme` and `GET /runs/org%3Aacme%3Ar-acme`
// returned acme's journal — the model's answer, the tool arguments, the prompt (measured through REST,
// review panel C `runid-mem.mjs`: "rootOp: GET /runs 200 [{"runId":"org:acme:r-acme" …").
//
// The way through for an operator who must see an organization's runs is that organization's scope:
// `x-gnl-org: <id>` for a platform admin (the existing platform grant), or `withOrgStorage` in code.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, InMemoryStorage, type Storage } from '@gnldev/durable';
import { type AuthProvider, type Principal } from '@gnldev/auth';
import { createRestApi } from '../src/index.js';
import { call } from './call.js';

const SECRET = 'ACME-SECRET-RUN';

function mkModel(text: string): any {
  return {
    specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
    doGenerate: async () => ({ content: [{ type: 'text', text }], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] }),
  };
}

const PRINCIPALS: Record<string, Principal> = {
  'a-adm': { kind: 'operator', id: 'a-adm', roles: ['admin'], orgId: 'acme' },
  plat: { kind: 'operator', id: 'plat', roles: ['admin', 'platform-admin'] },
};
const licensed: AuthProvider = {
  authenticate: (req) => PRINCIPALS[req.headers.get('authorization')?.replace('Bearer ', '') ?? ''] ?? null,
  authorize: (p) => (p ? { allow: true } : { allow: false, status: 401, reason: 'unauthenticated' }),
  capabilities: () => ({ multiOrganization: true }),
};
const H = (t: string, org?: string) => ({ authorization: `Bearer ${t}`, ...(org ? { 'x-gnl-org': org } : {}) });
const runIds = async (r: Response) => {
  const body = await r.json();
  return (Array.isArray(body) ? body : body.items).map((x: { runId: string }) => x.runId).sort();
};

const sources: [string, () => { journal?: InMemoryJournal; storage?: Storage }][] = [
  ['journal', () => ({ journal: new InMemoryJournal() })],
  ['storage', () => ({ storage: new InMemoryStorage() })],
];

describe.each(sources)('root-scope run reads hide every organization\'s runs (%s)', (_n, make) => {
  async function seeded() {
    const src = make();
    const api = createRestApi({ ...src, memory: false, agents: { a: { model: mkModel(SECRET) } } } as never, { auth: licensed, org: {}, protectionsBanner: false } as never);
    // acme's run, written through acme's own scope (its bound admin).
    const acme = await call(api, '/agents/a/run', { method: 'POST', headers: { ...H('a-adm'), 'content-type': 'application/json' }, body: JSON.stringify({ runId: 'r-acme', prompt: 'hi' }) });
    expect(acme.status).toBe(200);
    // The root's own run, by the platform admin with no organization named.
    const root = await call(api, '/agents/a/run', { method: 'POST', headers: { ...H('plat'), 'content-type': 'application/json' }, body: JSON.stringify({ runId: 'r-root', prompt: 'hi' }) });
    expect(root.status).toBe(200);
    return api;
  }

  it('GET /runs (array and paged) lists the root\'s runs and no organization\'s', async () => {
    const api = await seeded();
    expect(await runIds(await call(api, '/runs', { headers: H('plat') }))).toEqual(['r-root']);
    expect(await runIds(await call(api, '/runs?limit=10', { headers: H('plat') }))).toEqual(['r-root']);
  });

  it('GET /runs/:id on an organization\'s physical run id answers 404 and carries nothing of it', async () => {
    const api = await seeded();
    const r = await call(api, `/runs/${encodeURIComponent('org:acme:r-acme')}`, { headers: H('plat') });
    expect(r.status).toBe(404);
    expect(await r.text()).not.toContain(SECRET);
  });

  it('WAY THROUGH: the platform admin reads acme\'s runs in acme\'s scope (x-gnl-org)', async () => {
    const api = await seeded();
    expect(await runIds(await call(api, '/runs', { headers: H('plat', 'acme') }))).toEqual(['r-acme']);
    const r = await call(api, '/runs/r-acme', { headers: H('plat', 'acme') });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain(SECRET);
  });
});
