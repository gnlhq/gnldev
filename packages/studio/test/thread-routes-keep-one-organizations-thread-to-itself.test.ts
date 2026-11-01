// The thread routes over the real studioLab, two organizations with the SAME thread id: one sees none of
// the other's turns, previews or absence candidates; a malformed diagnosis body is a 400, and the audit
// keeps no expectation or override content.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { InMemoryJournal, runDurable, withOrg } from '@gnldev/durable';
import { studioLab } from '../../lab/src/index.js';
import { createMockModel } from '../../durable/test/mock.js';
import { createStudioApi } from '../src/server.js';
import { call } from './call.js';

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
// Diagnostics, printed with GNL_TEST_VERBOSE=1.
const log = (...a: unknown[]) => void (process.env.GNL_TEST_VERBOSE && process.stdout.write(`AUDIT ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`));
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
const model = () => { const m = createMockModel(async () => ({ content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 1 } })); (m as any).modelId = 'cheap'; return m; };
function windowMemory(n: number) {
  const stored: any[] = [];
  return { async getMessages() { return stored; }, async append(_t: string, m: any[]) { stored.push(...m); }, async loadContext() { const r = stored.slice(-n); return { messages: r, provenance: { recalled: [], recentCount: r.length } }; } };
}

describe('thread routes with the real lab, one thread id in two organizations', () => {
  it("acme's plan holds nothing of globex's thread 't'", async () => {
    const j = new InMemoryJournal();
    const memA = windowMemory(2), memG = windowMemory(2);
    for (let i = 0; i < 4; i++) await runDurable({ runId: `g${i}`, journal: withOrg(j, 'globex'), agentName: 'support', memory: memG, threadId: 't', model: model(), prompt: `GLOBEX-SECRET-${i}` } as any);
    for (let i = 0; i < 3; i++) await runDurable({ runId: `a${i}`, journal: withOrg(j, 'acme'), agentName: 'support', memory: memA, threadId: 't', model: model(), prompt: `acme question ${i}` } as any);
    const lab = studioLab({ config: { agents: { support: {} } }, models: { 'cheap/model': model() } } as any);
    const app = createStudioApi({ reader: j, auth: authProvider as any, lab });
    const r = await call(app, '/lab/thread-plan?threadId=t&model=cheap/model', { headers: AS.acme });
    const body = await r.text();
    log('same-thread', r.status, body.slice(0, 600));
    expect(r.status).toBe(200);
    expect(body).not.toContain('GLOBEX-SECRET');
    const plan = JSON.parse(body);
    expect(plan.total).toBe(3);
    expect(plan.turns.map((t: any) => t.runId)).toEqual(['a0', 'a1', 'a2']);
  });

  it('a diagnosis with a NaN-ish / huge body is a 400, and the audit keeps no expect or override content', async () => {
    const j = new InMemoryJournal();
    const memA = windowMemory(2);
    await runDurable({ runId: 'a0', journal: withOrg(j, 'acme'), agentName: 'support', memory: memA, threadId: 't', model: model(), prompt: 'q' } as any);
    const lab = studioLab({ config: { agents: { support: {} } }, models: { 'cheap/model': model() } } as any);
    const app = createStudioApi({ reader: j, auth: authProvider as any, lab });
    const post = (b: unknown) => call(app, '/lab/thread', { method: 'POST', headers: { 'content-type': 'application/json', ...AS.acme }, body: JSON.stringify(b) });
    const st: Record<string, number> = {};
    for (const [n, b] of Object.entries({ trialsFloat: { trials: 2.5 }, trialsNeg: { trials: -1 }, trialsString: { trials: '5' }, eliminationString: { eliminationTrials: '2' }, topKString: { topK: '1' }, wmObj: { workingMemory: { a: 1 } } })) st[n] = (await post({ runId: 'a0', model: 'cheap/model', expect: { answerIncludes: ['x'] }, ...b })).status;
    log('validation', st);
    const ok = await post({ runId: 'a0', model: 'cheap/model', expect: { answerIncludes: ['AYSE-EXPECT'] }, workingMemory: 'AYSE-WM', overrides: [{ toolName: 'lookup', args: {}, output: { address: 'AYSE-ADDR' } }], trials: 1, eliminationTrials: 1, topK: 1 });
    await ok.text();
    const audit = await (await call(app, '/audit?action=lab.thread', { headers: AS.acme })).json();
    log('audit', audit.items?.[0]);
    expect(JSON.stringify(audit)).not.toMatch(/AYSE-(EXPECT|WM|ADDR)/);
    expect(Object.values(st).every((s) => s === 400)).toBe(true);
  });
});
