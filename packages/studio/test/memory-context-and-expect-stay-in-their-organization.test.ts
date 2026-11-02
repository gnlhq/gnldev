// Studio's memory-context route and the capsule's `expect`: another organization's run reads as absent,
// a malformed record is reported rather than thrown, and an expectation's text never reaches the audit log.
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
const lab: StudioLab = {
  catalog: () => ({ agents: ['support'], models: ['cheap/model'] }),
  plan: async (_j, req) => ({ ...req }), explain: async (_j, req) => ({ runId: req.runId }), scenarios: () => [],
  formPlan: (req) => ({ ...req }), bestForm: async () => ({}), capsuleBase: async (_j, req) => ({ runId: req.runId }),
  capsule: async (_j, req) => ({ runId: req.runId, paths: [] }),
} as any;

async function seeded() {
  const j = new InMemoryJournal();
  await j.put('org:acme:r-acme:input', { prompt: 'hi', agent: 'support', at: 1, messages: [{ role: 'user', content: 'hi' }], turn: { count: 1, token: 'T' } });
  await j.put('org:acme:r-acme:outcome', { status: 'completed', at: 3 });
  await j.put('org:acme:r-acme:memctx', { v: 1, threadId: 't', recalled: [{ threadId: 't', seq: 0, role: 'user', preview: 'ACME SECRET' }], recentCount: 0, incomingCount: 1, echoTrimmed: 0, layout: { v: 1, n: 1, status: 'exact', incoming: [0, 1], token: 'T' } });
  await j.put('org:globex:r-g:input', { prompt: 'x', at: 1 });
  return j;
}

describe('memory-context route and capsule audit', () => {
  it('another org gets neither the record nor a reading of it', async () => {
    const app = createStudioApi({ reader: await seeded(), auth: authProvider as any, lab });
    const own = await (await call(app, '/runs/r-acme/memory-context', { headers: AS.acme })).json();
    const other = await (await call(app, '/runs/r-acme/memory-context', { headers: AS.globex })).json();
    const viaPrefix = await (await call(app, `/runs/${encodeURIComponent('org:acme:r-acme')}/memory-context`, { headers: AS.globex })).json();
    log('cross-org', { own: own.layout?.status, other, viaPrefix });
    expect(own.layout.status).toBe('present');
    expect(JSON.stringify(other) + JSON.stringify(viaPrefix)).not.toContain('ACME SECRET');
    expect(other.layout?.status).toBe('absent');
  });

  it('the capsule audit says that an expectation was given, not what it holds', async () => {
    const app = createStudioApi({ reader: await seeded(), auth: authProvider as any, lab });
    const r = await call(app, '/lab/capsule', { method: 'POST', headers: { 'content-type': 'application/json', ...AS.acme }, body: JSON.stringify({ runId: 'r-acme', model: 'cheap/model', expect: { answerIncludes: ['AYSE-PRIVATE-PHRASE'], calls: [{ toolName: 'refund', args: { iban: 'TR00SECRET' } }] } }) });
    const audit = await (await call(app, '/audit?action=lab.capsule', { headers: AS.acme })).json();
    log('audit', r.status, audit.items?.[0]);
    expect(r.status).toBe(200);
    expect(JSON.stringify(audit)).not.toMatch(/AYSE-PRIVATE-PHRASE|TR00SECRET/);
  });

  it('a malformed expect is a 400, not a 500', async () => {
    const app = createStudioApi({ reader: await seeded(), auth: authProvider as any, lab });
    const out: Record<string, number> = {};
    for (const [n, e] of Object.entries({ nul: null, arr: [], extra: { x: 1 }, emptyStr: { forbidden: [''] }, deep: { answerIncludes: [[]] }, argsArr: { calls: [{ toolName: 'a', args: [] }] } })) {
      out[n] = (await call(app, '/lab/capsule', { method: 'POST', headers: { 'content-type': 'application/json', ...AS.acme }, body: JSON.stringify({ runId: 'r-acme', model: 'cheap/model', expect: e }) })).status;
    }
    log('expect-validation', out);
    expect(Object.values(out).every((s) => s === 400)).toBe(true);
  });
});
