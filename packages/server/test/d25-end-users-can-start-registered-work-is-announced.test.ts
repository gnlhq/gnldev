// d25 item 4 (0.17.1: documentation + a visible warning, NO behaviour change; 0.18 gets a per-definition `access` field).
//
// On a deployment that gives end users their own credential (roleAuth `endUsers`), `workflow:run` / `agents:run` cover EVERY
// registered workflow and agent: an end user can start the back-office one (measured: POST /workflows/monthly-billing/run -> 200).
// For 0.17.1 that is not changed, but the deployment must be TOLD when it starts. The wording is not pinned; what is:
//   - a visible startup message exists exactly when end users are configured AND workflows/agents are registered,
//   - it is about starting registered work (mentions end users, and workflows/agents, and the way out `resourceAuth`),
//   - it is printed once per built API, and does not appear on a deployment without end users,
//   - behaviour is unchanged (the end user still gets 200: 0.18's job, so a premature 403 is a red here on purpose).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { workflow, step } from '@gnldev/workflow';
import { roleAuth, signSubjectToken } from '@gnldev/auth';
import { createRestApi } from '../src/index.js';

const SECRET = 'app-signing-secret-at-least-32-bytes!!';
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const textModel: any = {
  specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
  doGenerate: async () => ({ content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', usage, warnings: [] }),
};
const wf = () => workflow<unknown>().then(step('s', async () => 'done'));

let spies: Array<ReturnType<typeof vi.spyOn>> = [];
let captured: string[] = [];
afterEach(() => { for (const s of spies) s.mockRestore(); spies = []; });
function capture() {
  captured = [];
  const push = (...a: unknown[]) => { captured.push(a.map(String).join(' ')); };
  for (const m of ['error', 'warn', 'log', 'info'] as const) spies.push(vi.spyOn(console, m).mockImplementation(push));
  for (const s of [process.stderr, process.stdout]) spies.push(vi.spyOn(s, 'write').mockImplementation(((c: unknown) => { captured.push(String(c)); return true; }) as never));
}
const said = () => captured.join('\n');

function build(o: { endUsers: boolean; workflows?: boolean; agents?: boolean; banner?: boolean }) {
  capture();
  const config = {
    journal: new InMemoryJournal(), memory: false,
    agents: o.agents === false ? {} : { 'back-office': { model: textModel } },
    workflows: o.workflows === false ? {} : { 'monthly-billing': wf() },
  };
  const api = createRestApi(config as never, {
    auth: roleAuth({ admin: { token: 'STAFF', orgId: 'acme' }, client: { token: 'APP', orgId: 'acme' }, ...(o.endUsers ? { endUsers: { secret: SECRET, orgId: 'acme' } } : {}) }),
    org: {},
    ...(o.banner === false ? { protectionsBanner: false } : {}),
  } as never) as any;
  return api;
}

/** The warning: one place says end users + starting registered workflows/agents. Tolerant of wording, strict about content. */
function warningLines(text: string): string[] {
  const paragraphs = text.split(/\n\s*\n|\n(?=\S)/).flatMap((p) => p.split('\n'));
  return paragraphs.filter((l) => /end[- ]?users?/i.test(l) && /(workflow)/i.test(l) && /agent/i.test(l) && /(start|run|launch|trigger)/i.test(l));
}

describe('endUsers configured + workflows and agents registered', () => {
  it('prints a visible warning at startup (workflows, agents and end users named; the way out, resourceAuth, named)', () => {
    build({ endUsers: true });
    const w = warningLines(said());
    expect(w.length, `nothing warns that end users can start every registered workflow/agent. Output:\n${said()}`).toBeGreaterThan(0);
    expect(said()).toContain('resourceAuth');
  });

  it('is printed once for one API (not once per route or per request)', async () => {
    const api = build({ endUsers: true });
    for (let i = 0; i < 3; i++) await api(new Request('http://x/agents', { headers: { authorization: 'Bearer STAFF' } }));
    expect(warningLines(said()).length).toBe(1);
  });

  it('is not tied to the protections banner: protectionsBanner:false does not make the deployment unwarned', () => {
    build({ endUsers: true, banner: false });
    expect(warningLines(said()).length).toBeGreaterThan(0);
  });

  it('for each kind alone: workflows only, and agents only, still warn', () => {
    const about = (kind: RegExp) => said().split('\n').filter((l) => /end[- ]?users?/i.test(l) && kind.test(l) && /(start|run|launch|trigger)/i.test(l));
    build({ endUsers: true, agents: false });
    expect(about(/workflow/i).length, 'workflows only').toBeGreaterThan(0);
    build({ endUsers: true, workflows: false });
    expect(about(/agent/i).length, 'agents only').toBeGreaterThan(0);
  });
});

describe('NEGATIVE CONTROLS: no noise where it does not apply', () => {
  it('no end users configured: no such warning', () => {
    build({ endUsers: false });
    expect(warningLines(said())).toEqual([]);
  });
  it('end users configured but nothing registered to start: no such warning', () => {
    build({ endUsers: true, agents: false, workflows: false });
    expect(warningLines(said())).toEqual([]);
  });
});

describe('0.17.1 changes no behaviour: the warning is the whole change', () => {
  it('an end user can still start the registered workflow (403 comes with 0.18\'s `access`, not now)', async () => {
    const api = build({ endUsers: true, banner: false });
    const tok = `Bearer ${signSubjectToken({ sub: 'donor-1' }, SECRET)}`;
    const res = await api(new Request('http://x/workflows/monthly-billing/run', { method: 'POST', headers: { 'content-type': 'application/json', authorization: tok }, body: JSON.stringify({ input: {} }) }));
    expect(res.status).toBe(200);
  });
});
