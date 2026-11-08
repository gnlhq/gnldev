// d25 P5 / karar 13: the chat error part. gnl's OWN typed errors are named (not "An error occurred.");
// an error gnl does not know stays masked for the end user; EVERY error's cause goes to the server log with the runId.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createChatRoute } from '../src/index.js';

const hang: any = { specificationVersion: 'v2', provider: 'x', modelId: 'm', supportedUrls: {}, doGenerate: async () => new Promise(() => {}), doStream: async () => new Promise(() => {}) };
const failWith = (err: any): any => ({ specificationVersion: 'v2', provider: 'x', modelId: 'm', supportedUrls: {}, doGenerate: async () => { throw err; }, doStream: async () => { throw err; } });

async function chat(model: any, id: string, extra: Record<string, unknown> = {}) {
  const log: string[] = [];
  const grab = (...a: unknown[]) => { log.push(a.map((x) => (x instanceof Error ? `${x.name}: ${x.message}` : String(x))).join(' ')); };
  vi.spyOn(console, 'error').mockImplementation(grab); vi.spyOn(console, 'warn').mockImplementation(grab);
  const app = createChatRoute({ journal: new InMemoryJournal(), agents: { chat: { model } }, ...extra } as any, { identify: () => ({ userId: 'u1' }) as any, allowedHosts: ['localhost'] } as any);
  const res = await app.request('http://localhost/agents/chat/chat', { method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost' }, body: JSON.stringify({ id, messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] }) });
  return { text: await res.text(), log: log.join('\n') };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('13: chat error text', () => {
  it('a gnl-typed error (model step timed out) is named, not "An error occurred."', async () => {
    const r = await chat(hang, 'p13-a', { timeouts: { modelStepMs: 200 } });
    console.log('TEXT', r.text);
    expect(r.text).not.toContain('An error occurred.');
    expect(r.text).toMatch(/time(d)?[ _-]?out|step_timeout|StepTimeout/i);
  });
  it('the typed error is named in production too (it is gnl-authored, safe text)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const r = await chat(hang, 'p13-b', { timeouts: { modelStepMs: 200 } });
    expect(r.text).not.toContain('An error occurred.');
  });
  it('NEGATIVE: an unknown error text never reaches the end user (also in dev)', async () => {
    const r = await chat(failWith(new Error('db password is hunter2')), 'p13-c');
    expect(r.text).not.toContain('hunter2');
    expect(r.text).toContain('An error occurred.');
  });
  it('every error, known or not, is written to the server log with its cause and the runId', async () => {
    const plain = await chat(failWith(new Error('upstream pool exhausted (internal)')), 'p13-d');
    expect(plain.log).toContain('pool exhausted');
    expect(plain.log).toContain('p13-d');                 // the thread/run it belongs to
    const typed = await chat(hang, 'p13-e', { timeouts: { modelStepMs: 200 } });
    expect(typed.log).toMatch(/time(d)?[ _-]?out|StepTimeout/i);
  });
});
