// d25 P5 / karar 14: when the model answers 429 on the step AFTER an approved tool already ran, the error answer
// carries the run's address (runId) and says the action DID run (effectsRan: true, retry: 'same-runId'),
// so the client does not ask the user to repeat a payment. Where no tool ran, it does not claim one did.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { InMemoryJournal } from '@gnldev/durable';
import { createRestApi } from '../src/index.js';
import { call } from './call.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const mkStream = (arr: any[]) => new ReadableStream({ start(c) { for (const p of arr) c.enqueue(p); c.close(); } });
const okText = () => ({ stream: mkStream([{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: '1' }, { type: 'text-delta', id: '1', delta: 'ok' }, { type: 'text-end', id: '1' }, { type: 'finish', finishReason: 'stop', usage }]) });
const callTool = () => ({ stream: mkStream([{ type: 'stream-start', warnings: [] }, { type: 'tool-call', toolCallId: 'call-c', toolName: 'chargeCard', input: JSON.stringify({ amount: 5000 }) }, { type: 'finish', finishReason: 'tool-calls', usage }]) });
const rate = Object.assign(new Error('Too Many Requests'), { name: 'AI_APICallError', statusCode: 429, isRetryable: true, url: 'https://h.example/v1/chat' });
/** 429 on the step that follows the tool result (once). */
const modelRateAfterTool = (): any => { let first = true; return { specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {}, doGenerate: async () => { throw new Error('no gen'); },
  doStream: async ({ prompt }: any) => { if (!(prompt ?? []).some((m: any) => m.role === 'tool')) return callTool(); if (first) { first = false; throw rate; } return okText(); } }; };
/** 429 on the very first step: nothing ran. */
const modelRateFirst: any = { specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {}, doGenerate: async () => { throw rate; }, doStream: async () => { throw rate; } };
const mkApi = (model: any, ran: { n: number }) => createRestApi({ journal: new InMemoryJournal(), agents: { a: { model,
  tools: { chargeCard: tool({ description: 'c', inputSchema: z.object({ amount: z.number() }), execute: async () => { ran.n++; return { ok: true }; } }) },
  guard: () => ({ action: 'require-approval' as const }), maxSteps: 4 } } }, { protectionsBanner: false } as any);
const post = (api: any, p: string, b: any) => call(api, p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); });

describe('14: provider 429 after an approved action', () => {
  it('/run: status stays 429; body has runId, effectsRan:true and retry:"same-runId"; the effect ran once', async () => {
    const ran = { n: 0 }; const api = mkApi(modelRateAfterTool(), ran);
    await post(api, '/agents/a/run', { runId: 'p14-1', prompt: 'x' });
    const r = await post(api, '/agents/a/run', { runId: 'p14-1', prompt: 'x', approvals: { 'call-c': true } });
    const j: any = await r.json();
    console.log('429 body:', r.status, JSON.stringify(j));
    expect(r.status).toBe(429);                          // control (0.17.1 mapping)
    expect(ran.n).toBe(1);
    expect(j.runId).toBe('p14-1');
    expect(j.effectsRan).toBe(true);
    expect(j.retry).toBe('same-runId');
  });
  it('/stream: the error event says the same thing', async () => {
    const ran = { n: 0 }; const api = mkApi(modelRateAfterTool(), ran);
    await post(api, '/agents/a/run', { runId: 'p14-2', prompt: 'x' });
    const t = await (await post(api, '/agents/a/stream', { runId: 'p14-2', prompt: 'x', approvals: { 'call-c': true } })).text();
    console.log('stream:', t.slice(-400));
    expect(t).toContain('p14-2');
    expect(t).toMatch(/effectsRan"?\s*:\s*true/);
  });
  it('NEGATIVE: 429 on the first step (no tool ran) carries runId but does NOT claim an action ran', async () => {
    const ran = { n: 0 }; const api = mkApi(modelRateFirst, ran);
    const r = await post(api, '/agents/a/run', { runId: 'p14-3', prompt: 'x' });
    const j: any = await r.json();
    expect(r.status).toBe(429);
    expect(ran.n).toBe(0);
    expect(j.runId).toBe('p14-3');
    expect(j.effectsRan).not.toBe(true);
  });
  it('a re-send of the same runId finishes without running the tool again (control)', async () => {
    const ran = { n: 0 }; const api = mkApi(modelRateAfterTool(), ran);
    await post(api, '/agents/a/run', { runId: 'p14-4', prompt: 'x' });
    await post(api, '/agents/a/run', { runId: 'p14-4', prompt: 'x', approvals: { 'call-c': true } });
    const r3 = await post(api, '/agents/a/run', { runId: 'p14-4', prompt: 'x', approvals: { 'call-c': true } });
    expect(r3.status).toBe(200);
    expect(ran.n).toBe(1);
  });
});
