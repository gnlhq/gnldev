// `gnl dev` could not cap a run: `limits` existed only as a createRestApi option, which `gnl dev`
// builds itself, so a project had to reach into the dev server's internals to set a ceiling. The
// config now declares it, and `gnl dev` (and the scaffolded src/app.ts) pass it on as the server-side
// bound — a request may only tighten it.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import * as Durable from '@gnldev/durable';
import * as Hono from 'hono';
import * as Server from '@gnldev/server';
import * as Studio from '@gnldev/studio';
import * as StudioAi from '@gnldev/studio/ai';
import * as Auth from '@gnldev/auth';
import { buildDevApp, type DevRuntimeModules } from '../src/dev-server.js';
import { defineConfig } from '../src/config.js';

const rt: DevRuntimeModules = { hono: Hono, durable: Durable, server: Server, studio: Studio, studioAi: StudioAi, auth: Auth };
const model: any = {
  specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
  doGenerate: async () => ({ content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', usage: { inputTokens: 40, outputTokens: 40, totalTokens: 80 }, warnings: [] }),
};
const run = (app: { request: (p: string, i: RequestInit) => Response | Promise<Response> }, runId: string, extra: object = {}) =>
  app.request('/agents/a/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId, prompt: 'hi', ...extra }) });

describe('gnl.config `limits`', () => {
  it('is a name defineConfig accepts', () => {
    expect(() => defineConfig({ journal: new InMemoryJournal(), agents: { a: { model } }, limits: { maxTokens: 10 } } as never)).not.toThrow();
  });

  it('caps the runs `gnl dev` serves; without it the same run completes', async () => {
    const capped = buildDevApp({ journal: new InMemoryJournal(), agents: { a: { model } }, studio: false, limits: { maxTokens: 10 } } as never, rt);
    const res = await run(capped, 'capped');
    expect(res.status).not.toBe(200);
    expect(await res.text()).toContain('maxTokens');

    const open = buildDevApp({ journal: new InMemoryJournal(), agents: { a: { model } }, studio: false } as never, rt);
    expect((await run(open, 'open')).status).toBe(200);
  });

  it('a request can tighten the bound but not loosen it', async () => {
    const app = buildDevApp({ journal: new InMemoryJournal(), agents: { a: { model } }, studio: false, limits: { maxTokens: 10 } } as never, rt);
    const res = await run(app, 'loosen', { limits: { maxTokens: 1_000_000 } });
    expect(res.status).not.toBe(200);
  });
});
