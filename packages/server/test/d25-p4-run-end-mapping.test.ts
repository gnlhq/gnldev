// d25 P4 / madde 10 (KARAR-1, secenek A): how a run ENDED reaches the client is one rule, the same through
// every door. A canceled run is `run_canceled` (not a 400 with no code, not a bare `done`, not a bare
// `[DONE]`) — on /run (409), /stream (an `error` event carrying `code`), the chat surface (the error text
// names the code instead of "An error occurred.") and AG-UI (RUN_ERROR with `code`).
// The distinction the client needs: canceled / failed / stuck-and-waiting-for-an-operator are three
// different answers. (The stuck run is driven in chat-adapter/test/d25-p4-run-end-mapping-stuck.test.ts,
// where a store outlives its process.)
//
// Not pinned (decision points, KARAR-1 does not name them): the exact event name a stream uses, the exact
// wording of any message, whether `done` still follows the error frame.
import { describe, it, expect, afterEach } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { chatSurface } from '../../chat-adapter/src/index.js';
import { aguiSurface } from '../../agui/src/route.js';
import { createRestApi } from '../src/index.js';
import { call } from './call.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
/** A model that streams its answer only after `gate` opens — the run is canceled while it waits. */
function gatedModel(gate: Promise<void>): any {
  return {
    specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
    doGenerate: async () => { throw new Error('stream only'); },
    doStream: async (o: any) => {
      await Promise.race([gate, new Promise((_, rej) => o.abortSignal?.addEventListener('abort', () => rej(o.abortSignal.reason ?? new Error('aborted'))))]);
      return { stream: new ReadableStream({ start(c) {
        c.enqueue({ type: 'stream-start', warnings: [] });
        c.enqueue({ type: 'text-start', id: 't' }); c.enqueue({ type: 'text-delta', id: 't', delta: 'hello' }); c.enqueue({ type: 'text-end', id: 't' });
        c.enqueue({ type: 'finish', finishReason: 'stop', usage });
        c.close();
      } }) };
    },
  };
}
/** A model whose call fails with an error of the HOST's own (not the provider's, not a cancel). */
const failingModel: any = {
  specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
  doGenerate: async () => { throw new Error('boom'); },
  doStream: async () => { throw new Error('boom'); },
};

const unhandled: unknown[] = [];
const onUnhandled = (e: unknown) => { unhandled.push(e); };
afterEach(() => { process.off('unhandledRejection', onUnhandled); unhandled.length = 0; });
const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

type Door = 'run' | 'stream' | 'chat' | 'agui';
const DOORS: Door[] = ['run', 'stream', 'chat', 'agui'];
const mkApi = (model: any) => createRestApi({ journal: new InMemoryJournal(), agents: { a: { model } } }, { surfaces: [chatSurface(), aguiSurface()], protectionsBanner: false, allowOpenAccess: true } as never);

function send(api: any, door: Door, ident: Record<string, unknown>): Promise<Response> {
  if (door === 'chat') return call(api, '/agents/a/chat', json({ id: 'conv', ...ident, messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] }));
  return call(api, `/agents/a/${door}`, json({ ...ident, prompt: 'hi' }));
}

/** What the client can read out of an answer, door by door: the code it was given, if any. */
function answer(door: Door, status: number, text: string): { status: number; codes: string[]; errorTexts: string[]; frames: string[] } {
  const codes: string[] = []; const errorTexts: string[] = []; const frames: string[] = [];
  if (door === 'run') {
    try { const b = JSON.parse(text); if (b.code) codes.push(String(b.code)); if (b.error) errorTexts.push(String(b.error)); } catch { /* not JSON */ }
    return { status, codes, errorTexts, frames };
  }
  for (const raw of text.split('\n\n')) {
    const ev = /^event: (.*)$/m.exec(raw)?.[1];
    const data = /^data: (.*)$/m.exec(raw)?.[1];
    if (!data) continue;
    let d: any; try { d = JSON.parse(data); } catch { frames.push(`${ev ?? ''}:${data}`); continue; }
    if (door === 'stream') { frames.push(ev ?? '?'); if (ev === 'error') { if (d.code) codes.push(String(d.code)); errorTexts.push(String(d.error ?? '')); } }
    if (door === 'chat') { frames.push(String(d.type)); if (d.type === 'error') errorTexts.push(String(d.errorText ?? '')); }
    if (door === 'agui') { frames.push(String(d.type)); if (d.type === 'RUN_ERROR') { if (d.code) codes.push(String(d.code)); errorTexts.push(String(d.message ?? '')); } }
  }
  return { status, codes, errorTexts, frames };
}
/** The one assertion: this door told the client `code` — by its own means (code field, or the code named in the chat's error text). */
function expectEndedWith(door: Door, a: ReturnType<typeof answer>, code: string) {
  if (door === 'run') { expect(a.status).toBe(409); expect(a.codes).toContain(code); return; }
  if (door === 'chat') { expect(a.errorTexts.join(' ')).toContain(code); expect(a.errorTexts.join(' ')).not.toMatch(/^An error occurred\.?$/); return; }
  expect(a.codes).toContain(code); // /stream: `error` event with `code`; AG-UI: RUN_ERROR with `code`
}

describe('d25 P4 #10 — the client FOLLOWING a run that is canceled is told `run_canceled`, through every door', () => {
  for (const door of DOORS) {
    it(`${door}: followed run canceled mid-flight`, async () => {
      let open!: () => void; const gate = new Promise<void>((r) => (open = r));
      const api = mkApi(gatedModel(gate));
      const runId = `fc-${door}`;
      const req = send(api, door, { runId });
      await new Promise((r) => setTimeout(r, 150));
      expect((await call(api, `/runs/${runId}/cancel`, { method: 'POST' })).status).toBe(200);
      open();
      const res = await req;
      const a = answer(door, res.status, await res.text());
      console.log(`[follow ${door}]`, JSON.stringify(a));
      expectEndedWith(door, a, 'run_canceled');
    });
  }
});

describe('d25 P4 #10 sibling — a NEW request naming a canceled run is answered `run_canceled` (and the process stays up)', () => {
  for (const door of DOORS) {
    for (const ident of ['runId', 'workKey'] as const) {
      it(`${door} by ${ident}`, async () => {
        process.on('unhandledRejection', onUnhandled);
        let open!: () => void; const gate = new Promise<void>((r) => (open = r));
        const api = mkApi(gatedModel(gate));
        const idObj = ident === 'runId' ? { runId: `cx-${door}` } : { workKey: `wk-${door}`, resourceId: 'ayse' };
        const first = send(api, door, idObj);
        await new Promise((r) => setTimeout(r, 150));
        const listed = await (await call(api, '/runs')).json();
        const id = (Array.isArray(listed) ? listed : listed.items ?? [])[0]?.runId;
        expect((await call(api, `/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST' })).status).toBe(200);
        open(); await (await first).text().catch(() => undefined);
        await new Promise((r) => setTimeout(r, 100));
        const res = await send(api, door, idObj);
        const a = answer(door, res.status, await res.text());
        await new Promise((r) => setTimeout(r, 300));
        console.log(`[redrive ${door} ${ident}]`, JSON.stringify(a));
        expect(unhandled.map((e) => String((e as Error)?.name ?? e))).toEqual([]);
        expectEndedWith(door, a, 'run_canceled');
      });
    }
  }
});

describe('d25 P4 #10 sibling — canceled and failed are different answers', () => {
  for (const door of DOORS) {
    it(`${door}: a run that failed on a host error is NOT reported as canceled (and says it failed)`, async () => {
      const api = mkApi(failingModel);
      const res = await send(api, door, { runId: `fail-${door}` });
      const a = answer(door, res.status, await res.text());
      console.log(`[failed ${door}]`, JSON.stringify(a));
      expect(a.codes).not.toContain('run_canceled');
      expect(a.codes).not.toContain('run_not_continued');
      expect(a.errorTexts.join(' ')).not.toMatch(/run_canceled|run_not_continued|canceled/i);
      if (door === 'run') expect(a.status).not.toBe(200);
      else expect(a.errorTexts.length).toBeGreaterThan(0); // an error is still said
    });
  }
});
