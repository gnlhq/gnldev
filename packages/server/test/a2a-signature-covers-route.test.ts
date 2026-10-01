// An A2A signature covers the request it was made for — the method and the route — not only the body.
// The real client (@gnldev/a2a createA2ATool) signs; the server (a2aSecret) verifies. A captured signed
// request is replayed to every other door that reads a signed body.
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { InMemoryJournal } from '@gnldev/durable';
import { workflow, step } from '@gnldev/workflow';
import { createA2ATool } from '../../a2a/src/index.js';
import { createRestApi } from '../src/index.js';
import { call } from './call.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const mkStream = (arr: any[]) => new ReadableStream({ start(c) { for (const p of arr) c.enqueue(p); c.close(); } });
function mkModel(name: string): any {
  const text = `answer-from-${name}`;
  return {
    specificationVersion: 'v2', provider: 'mock', modelId: name, supportedUrls: {},
    doGenerate: async () => ({ content: [{ type: 'text', text }], finishReason: 'stop', usage, warnings: [] }),
    doStream: async () => ({ stream: mkStream([
      { type: 'stream-start', warnings: [] }, { type: 'text-start', id: '1' }, { type: 'text-delta', id: '1', delta: text },
      { type: 'text-end', id: '1' }, { type: 'finish', finishReason: 'stop', usage }]) }),
  };
}
const SECRET = 's3cret';
const ENDPOINT = 'http://remote.test/api';

function server() {
  return createRestApi({
    journal: new InMemoryJournal(),
    agents: { a: { model: mkModel('a') }, b: { model: mkModel('b') }, 'müşteri destek': { model: mkModel('md') } },
    workflows: { x: workflow<unknown>().then(step('s', async () => 'output-of-X')) },
  } as any, { a2aSecret: SECRET, protectionsBanner: false } as any);
}

/** Runs the real client once against `api` (the host strips `/api`), capturing the request it sent. */
async function signedBy(api: any, agentName: string) {
  let captured: { url: string; headers: Record<string, string>; body: string } | undefined;
  const fetchImpl = (async (url: string, init: any) => {
    captured = { url, headers: { ...init.headers }, body: init.body };
    const path = new URL(url).pathname.replace(/^\/api/, '');
    return call(api, `http://remote.test${path}`, { method: 'POST', headers: init.headers, body: init.body });
  }) as typeof fetch;
  const t = createA2ATool({ endpoint: ENDPOINT, agentName, secret: SECRET, fetchImpl });
  const result = await (t as any).execute({ task: 'hi' }, { toolCallId: 'tc-1', messages: [] }).then((r: unknown) => r, (e: Error) => e);
  return { captured: captured!, result };
}
const replay = (api: any, path: string, cap: { headers: Record<string, string>; body: string }, body = cap.body) =>
  call(api, `http://remote.test${path}`, { method: 'POST', headers: cap.headers, body });
const expectSignatureRefused = async (res: Response) => {
  const text = await res.text();
  expect(res.status, text.slice(0, 200)).toBe(401);
  expect(JSON.parse(text).code).toMatch(/^a2a_signature_/);
};

describe('an A2A signature covers the request it was made for', () => {
  it('T1 control: the real client and the server agree', async () => {
    const { result } = await signedBy(server(), 'a');
    expect((result as any).text).toBe('answer-from-a');
  });
  it('T2 control: an agent name that needs encoding round-trips', async () => {
    const { result } = await signedBy(server(), 'müşteri destek');
    expect((result as any).text, String((result as Error).message ?? '')).toBe('answer-from-md');
  });
  it('T3 a request signed for agent a, replayed to agent b (which never saw it)', async () => {
    const { captured } = await signedBy(server(), 'a');
    await expectSignatureRefused(await replay(server(), '/agents/b/run', captured));
  });
  it('T4 replayed to the same agent\'s /stream', async () => {
    const { captured } = await signedBy(server(), 'a');
    await expectSignatureRefused(await replay(server(), '/agents/a/stream', captured));
  });
  it('T5 replayed to the same agent\'s /resume', async () => {
    const { captured } = await signedBy(server(), 'a');
    await expectSignatureRefused(await replay(server(), '/agents/a/resume', captured));
  });
  it('T6 replayed to a workflow\'s run', async () => {
    const { captured } = await signedBy(server(), 'a');
    await expectSignatureRefused(await replay(server(), '/workflows/x/run', captured));
  });
  it('T7 the body changed under the signature', async () => {
    const { captured } = await signedBy(server(), 'a');
    await expectSignatureRefused(await replay(server(), '/agents/a/run', captured, captured.body.replace('"hi"', '"refund"')));
  });
  it('T8 no signature at all', async () => {
    const res = await call(server(), 'http://remote.test/agents/a/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId: 'u1', prompt: 'hi' }) });
    await expectSignatureRefused(res);
  });
  it('T9 a 0.9-style signature (timestamp and body only) is refused, loudly', async () => {
    const body = JSON.stringify({ runId: 'old-1', prompt: 'hi' });
    const ts = String(Date.now());
    const sig = createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex');
    const res = await call(server(), 'http://remote.test/agents/a/run', { method: 'POST', headers: { 'content-type': 'application/json', 'x-gnl-timestamp': ts, 'x-gnl-signature': sig }, body });
    await expectSignatureRefused(res);
  });
});
