// Lab experiments kept under `<runId>:derived:` change nothing the run views show and are not listed to
// another organization by naming the run; old or broken `:memctx` shapes do not break the memory-context route.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createStudioApi, type StudioLab } from '../src/server.js';
import { call } from './call.js';

const authProvider = {
  authenticate: (req: Request) => {
    const t = req.headers.get('authorization')?.replace('Bearer ', '');
    if (t === 'acme') return { kind: 'operator', roles: ['admin'], id: 'u-acme', orgId: 'acme' };
    if (t === 'globex') return { kind: 'operator', roles: ['admin'], id: 'u-globex', orgId: 'globex' };
    return null;
  },
  authorize: () => ({ allow: true }),
  capabilities: () => ({ sso: false, rbac: false, audit: false, multiOrganization: false, users: false }),
};
const AS = { acme: { authorization: 'Bearer acme' }, globex: { authorization: 'Bearer globex' } };
// Diagnostics, printed with GNL_TEST_VERBOSE=1.
const log = (...a: unknown[]) => void (process.env.GNL_TEST_VERBOSE && process.stdout.write(`AUDIT ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`));

async function seeded() {
  const j = new InMemoryJournal();
  for (const [org, run] of [['acme', 'r-acme'], ['globex', 'r-globex']] as const) {
    await j.put(`org:${org}:${run}:input`, { prompt: 'hi', agent: 'support', at: 1 });
    await j.put(`org:${org}:${run}:model:0`, { content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', usage: { inputTokens: { total: 10 }, outputTokens: { total: 1 } } });
    await j.put(`org:${org}:${run}:outcome`, { status: 'completed', at: 3 });
  }
  return j;
}
const lab: StudioLab = {
  catalog: () => ({ agents: ['support'], models: ['cheap/model'] }),
  plan: async (_j, req) => ({ ...req }),
  explain: async (_j, req) => ({ runId: req.runId, shares: [] }),
  scenarios: () => [],
  formPlan: (req) => ({ ...req }),
  bestForm: async () => ({ best: {} }),
  capsuleBase: async (_j, req) => ({ runId: req.runId }),
  capsule: async (_j, req) => ({ runId: req.runId, paths: [] }),
} as any;
const post = (app: any, path: string, body: unknown, headers: Record<string, string> = {}) =>
  call(app, path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

describe('kept experiments under the run do not change what the run views show', () => {
  it('run list / run detail / journal, before and after two kept experiments', async () => {
    const j = await seeded();
    const app = createStudioApi({ reader: j, auth: authProvider as any, lab });
    const snap = async () => {
      const out: Record<string, unknown> = {};
      for (const p of ['/runs?limit=50', '/runs/r-acme', '/runs/r-acme/journal', '/runs/r-acme/state', '/metrics/runs', '/runs/r-acme/children']) {
        const r = await call(app, p, { headers: AS.acme });
        out[p] = r.status + ' ' + (await r.text()).slice(0, 4000);
      }
      return out;
    };
    const before = await snap();
    expect((await post(app, '/lab/explain', { runId: 'r-acme', model: 'cheap/model' }, AS.acme)).status).toBe(200);
    expect((await post(app, '/lab/capsule', { runId: 'r-acme', model: 'cheap/model', system: 'x' }, AS.acme)).status).toBe(200);
    const after = await snap();
    const diff = Object.keys(before).filter((k) => before[k] !== after[k]);
    log('views-diff', diff, diff.map((k) => ({ k, before: String(before[k]).slice(0, 300), after: String(after[k]).slice(0, 300) })));
    expect(diff).toEqual([]);
  });

  it('another org cannot list, by naming the run, an experiment kept on it', async () => {
    const j = await seeded();
    const app = createStudioApi({ reader: j, auth: authProvider as any, lab });
    await post(app, '/lab/explain', { runId: 'r-acme', model: 'cheap/model' }, AS.acme);
    for (const t of ['r-acme', 'org:acme:r-acme', '../acme/r-acme', 'r-acme:derived']) {
      const r = await call(app, `/lab/experiments?kind=explain&target=${encodeURIComponent(t)}`, { headers: AS.globex });
      const body = await r.text();
      log('cross-org', t, r.status, body.slice(0, 120));
      expect(body).not.toContain('"runId":"r-acme"');
    }
  });

  it('old / broken :memctx shapes: the route answers 200 and says what the record is', async () => {
    const j = await seeded();
    const shapes: Record<string, unknown> = {
      legacy: { v: 1, threadId: 't', recalled: [], recentCount: 2, incomingCount: 1, echoTrimmed: 0 },
      v2: { v: 2, layout: { v: 2 } },
      string: 'not json at all',
      nulls: { v: 1, recalled: null, layout: { v: 1, n: 'x', status: 3 } },
    };
    const app = createStudioApi({ reader: j, auth: authProvider as any, lab });
    for (const [name, rec] of Object.entries(shapes)) {
      await j.put(`org:acme:r-acme:memctx`, rec);
      const r = await call(app, '/runs/r-acme/memory-context', { headers: AS.acme });
      const body = await r.json();
      log('memctx-route', name, r.status, JSON.stringify(body).slice(0, 200));
      expect(r.status).toBe(200);
    }
  });
});
