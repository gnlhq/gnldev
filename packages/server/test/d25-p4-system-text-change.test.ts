// d25 P4 / madde 18 (KARAR-5, secenek A): the agent's `system` text is SERVER configuration, not the caller's
// content. When it differs between a turn and its retry (a clock in the text, a deploy that edited it) and
// the content the client sent is the same, the retry is ACCEPTED and the run continues with the text it
// began with (the recorded one). When the CONTENT differs the refusal stays: `409 run_input_mismatch`.
//
// Not pinned (decision points): the wording of the refusal; whether it names what differs (KARAR-5 says it
// should: "gonderdiginiz icerik farkli" vs "sistem metni degisti" — only the status and code are held here).
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { InMemoryJournal } from '@gnldev/durable';
import { aguiSurface } from '../../agui/src/route.js';
import { createRestApi } from '../src/index.js';
import { call } from './call.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
/** Asks to book (a confirm tool) then, once the booking is answered, says "Booked." — and remembers every system text it was shown. */
function mkModel(seen: string[]): any {
  const sys = (prompt: any[]) => (prompt ?? []).filter((m) => m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
  return {
    specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
    doGenerate: async () => { throw new Error('stream only'); },
    doStream: async ({ prompt }: any) => {
      seen.push(sys(prompt));
      const answered = (prompt ?? []).some((m: any) => m.role === 'tool');
      const parts: any[] = answered
        ? [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'Booked.' }, { type: 'text-end', id: 't' }, { type: 'finish', finishReason: 'stop', usage }]
        : [{ type: 'tool-call', toolCallId: 'c1', toolName: 'book', input: JSON.stringify({ slot: 9 }) }, { type: 'finish', finishReason: 'tool-calls', usage }];
      return { stream: new ReadableStream({ start(c) { c.enqueue({ type: 'stream-start', warnings: [] }); for (const p of parts) c.enqueue(p); c.close(); } }) };
    },
  };
}
const mkApi = (journal: InMemoryJournal, system: string, seen: string[], preset?: string) => createRestApi({
  journal, ...(preset ? { preset } : {}),
  agents: { a: { model: mkModel(seen), system, tools: { book: { description: 'book', inputSchema: z.object({ slot: z.number() }), confirm: true, ...(preset ? { sideEffect: false } : {}) /* critical demands a declared intent; this test is about the system text */, execute: async () => ({ ok: true }) } } } },
} as never, { allowOpenAccess: true, protectionsBanner: false, surfaces: [aguiSurface()] } as never);
const post = (api: any, path: string, body: unknown) => call(api, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const T1 = 'Now is 10:41.'; const T2 = 'Now is 10:42.';
const IDENTS = [['workKey', { workKey: 'wk-1', resourceId: 'ayse' }], ['runId', { runId: 'r-1', resourceId: 'ayse' }]] as const;
const DOORS = ['run', 'stream', 'agui'] as const;
const path = (d: string) => `/agents/a/${d}`;

describe('d25 P4 #18 — same content, system text changed: accepted, and the run continues with the RECORDED text', () => {
  for (const [label, ident] of IDENTS) {
    for (const door of DOORS) {
      it(`${label} /${door}: the retry is accepted, and the run then completes with the RECORDED text`, async () => {
        const journal = new InMemoryJournal(); const seen: string[] = [];
        const first = await post(mkApi(journal, T1, seen), '/agents/a/run', { ...ident, prompt: 'book slot 9' });
        expect(first.status).toBe(200); // waits on the confirm question
        // The client sends the SAME turn again (no approval yet) after the system text changed.
        const retry = await post(mkApi(journal, T2, seen), path(door), { ...ident, prompt: 'book slot 9' });
        const retryText = await retry.text();
        console.log(`[${label} ${door} retry] ${retry.status} ${retryText.slice(0, 200).replace(/\n/g, ' | ')}`);
        if (label === 'workKey') { // a plain runId is not fingerprint-checked outside preset critical (see the critical test below)
          expect(retry.status).toBe(200);
          expect(retryText).not.toMatch(/run_input_mismatch/);
        }
        // Then the person approves; the run carries on with the instructions it began with.
        const res = await post(mkApi(journal, T2, seen), path(door), { ...ident, prompt: 'book slot 9', approvals: { c1: true } });
        const text = await res.text();
        console.log(`[${label} ${door}] ${res.status} ${text.slice(0, 300).replace(/\n/g, ' | ')}`);
        expect(res.status).toBe(200);
        expect(text).toMatch(/Booked/);
        expect(seen.join('\n')).not.toContain('10:42'); // recorded instructions, not the new ones
        expect(seen[seen.length - 1]).toContain('10:41');
      });
    }
  }
  it('the same turn re-sent WITHOUT an approval is not refused either (it is asked again)', async () => {
    const journal = new InMemoryJournal(); const seen: string[] = [];
    await post(mkApi(journal, T1, seen), '/agents/a/run', { workKey: 'wk-2', resourceId: 'ayse', prompt: 'book slot 9' });
    const res = await post(mkApi(journal, T2, seen), '/agents/a/run', { workKey: 'wk-2', resourceId: 'ayse', prompt: 'book slot 9' });
    const text = await res.text();
    console.log('[no approval]', res.status, text.slice(0, 200));
    expect(res.status).toBe(200);
    expect(text).not.toMatch(/run_input_mismatch/);
  });
  it('content given as `messages` instead of `prompt` — same rule', async () => {
    const journal = new InMemoryJournal(); const seen: string[] = [];
    const body = { workKey: 'wk-3', resourceId: 'ayse', messages: [{ role: 'user', content: 'book slot 9' }] };
    await post(mkApi(journal, T1, seen), '/agents/a/run', body);
    const res = await post(mkApi(journal, T2, seen), '/agents/a/run', { ...body, approvals: { c1: true } });
    const text = await res.text();
    console.log('[messages]', res.status, text.slice(0, 200));
    expect(res.status).toBe(200);
    expect(text).toMatch(/Booked/);
  });
  it('preset critical (strictInput) with a plain runId — same rule', async () => {
    const journal = new InMemoryJournal(); const seen: string[] = [];
    await post(mkApi(journal, T1, seen, 'critical'), '/agents/a/run', { runId: 'rc-1', resourceId: 'ayse', prompt: 'book slot 9' });
    const res = await post(mkApi(journal, T2, seen, 'critical'), '/agents/a/run', { runId: 'rc-1', resourceId: 'ayse', prompt: 'book slot 9', approvals: { c1: true } });
    const text = await res.text();
    console.log('[critical runId]', res.status, text.slice(0, 200));
    expect(res.status).toBe(200);
    expect(text).not.toMatch(/run_input_mismatch/);
  });
});

describe('d25 P4 #18 negative control — the CONTENT differs: still `409 run_input_mismatch`', () => {
  for (const system of [T1, T2]) { // system unchanged, and system changed as well: the content alone is what is refused
    for (const door of ['run', 'stream'] as const) {
      it(`workKey /${door}, system ${system === T1 ? 'unchanged' : 'also changed'}`, async () => {
        const journal = new InMemoryJournal(); const seen: string[] = [];
        const ident = { workKey: `wk-n-${door}-${system === T1}`, resourceId: 'ayse' };
        await post(mkApi(journal, T1, seen), '/agents/a/run', { ...ident, prompt: 'book slot 9' });
        const res = await post(mkApi(journal, system, seen), path(door), { ...ident, prompt: 'book slot 10' });
        const text = await res.text();
        console.log(`[content differs ${door}]`, res.status, text.slice(0, 160).replace(/\n/g, ' | '));
        expect(res.status === 409 || /run_input_mismatch/.test(text)).toBe(true);
        expect(text).toMatch(/run_input_mismatch/);
      });
    }
  }
});
