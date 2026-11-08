// k3 upgrade — data written by release/0.17.1 (before any call-identity change: no run id in the duplicate
// marker, records keyed as 0.17.1 keys them), opened by this code. Fixtures: test/k3/fixtures (generate.ts).
// The rule after an upgrade: on the safe side — a person is asked, nothing runs silently, nothing runs twice.
//
//   U1  dead-marker.db: a process killed inside `pay` (`call_0`). After the upgrade a new message in the same
//       thread with the same id is asked, not run (effects stay 1), in both orders; the old run is not run
//       again by itself either. Control: the new message's call has a unique id.
//   U2  pending-confirm-one.db: a run waiting on its one question (pay 5). After the upgrade it is still
//       asked, and the person's answer runs it exactly once — also when the answer names the id the client
//       was given before the upgrade.
//   U3  pending-confirm.db: pay 5 then pay 7, both `call_0`, both confirm, waiting on the first. After the
//       upgrade, approving the first does not run the second unasked; approving it too runs it.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createRestApi } from '../../server/dist/index.js';
import { chatSurface } from '../dist/index.js';
import { AgentMemory } from '../../memory/dist/index.js';

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
const FX = join(__dirname, 'k3', 'fixtures');
const PROC = join(__dirname, 'k3', 'proc.ts');
const TSX = join(__dirname, '..', '..', '..', 'node_modules', '.bin', 'tsx');

function serve(env: Record<string, string>): Promise<Record<string, any>> {
  return new Promise((resolve) => {
    const child = spawn(TSX, [PROC], { env: { ...process.env, ...env }, cwd: join(__dirname, '..') });
    let out = '';
    child.stdout.on('data', (b) => { out += b; }); child.stderr.on('data', (b) => { out += b; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.on('close', () => {
      clearTimeout(timer);
      const lines: Record<string, any> = {};
      for (const l of out.split('\n')) { const m = /^([A-Z_0-9]+) (\{.*\})$/.exec(l); if (m) { try { lines[m[1]] = JSON.parse(m[2]); } catch { /* */ } } }
      resolve(lines);
    });
  });
}

describe('k3 U1 — a dead marker written by 0.17.1, after the upgrade', () => {
  for (const order of ['msg-first', 'takeover-first']) for (const ids of ['same', 'unique']) {
    it.concurrent(`${order} · new message ids=${ids}: asked, not run; the old run does not run again by itself`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'k3-up-'));
      copyFileSync(join(FX, 'dead-marker.db'), join(dir, 'j.db'));
      copyFileSync(join(FX, 'dead-marker.eff'), join(dir, 'eff'));
      const s = await serve({ ROLE: 'serve', BACKEND: 'sqlite', DB: join(dir, 'j.db'), EFFECTS: join(dir, 'eff'), DOOR: 'run', IDS: ids, ORDER: order, OLD_Q: '1', TAKEOVER_WAIT_MS: '5000' });
      console.log(`[U1 ${order} ${ids}] t2=${JSON.stringify({ status: s.T2?.status, text: s.T2?.text, q: s.T2?.interrupts?.map((i: any) => i.reason.slice(0, 100)), blocked: s.T2?.blocked?.slice(0, 120) })} final=${JSON.stringify(s.FINAL?.lines)}`);
      expect(s.BOOT.effects).toBe(1);
      expect(s.AFTER_T2.effects, 'the new message ran beside the dead call').toBe(1);
      expect((s.T2.interrupts?.length ?? 0) > 0, 'the new message is asked').toBe(true);
      expect(s.FINAL.effects, 'nothing ran without a person').toBe(1);
    }, 180_000);
  }
});

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
function script(steps: number[]): any {
  const stream = (parts: any[]) => ({ stream: new ReadableStream({ start(c) { c.enqueue({ type: 'stream-start', warnings: [] }); for (const p of parts) c.enqueue(p); c.close(); } }) });
  return {
    specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
    doGenerate: async () => { throw new Error('stream only'); },
    doStream: async ({ prompt }: any) => {
      const lastUser = prompt.map((m: any) => m.role).lastIndexOf('user');
      const n = prompt.slice(lastUser).filter((m: any) => m.role === 'tool').flatMap((m: any) => m.content).filter((p: any) => p.type === 'tool-result').length;
      if (n < steps.length) return stream([{ type: 'tool-call', toolCallId: 'call_0', toolName: 'pay', input: JSON.stringify({ amount: steps[n] }) }, { type: 'finish', finishReason: 'tool-calls', usage }]);
      return stream([{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'done' }, { type: 'text-end', id: 't' }, { type: 'finish', finishReason: 'stop', usage }]);
    },
  };
}
async function openFixture(name: string, steps: number[]) {
  const dir = mkdtempSync(join(tmpdir(), 'k3-up-'));
  copyFileSync(join(FX, name), join(dir, 'j.db'));
  const { SqliteStorage } = await import('@gnldev/durable/sqlite') as any;
  const storage = new SqliteStorage(join(dir, 'j.db'));
  const paid: number[] = [];
  const api = createRestApi({ storage, preset: 'assistant', memoryFactory: (st: any) => new AgentMemory({ storage: st }), agents: { a: { model: script(steps), system: 'assistant', tools: {
    pay: { description: 'pay', inputSchema: z.object({ amount: z.number() }), sideEffect: true, confirm: true, execute: async (a: any) => { paid.push(a.amount); return { charged: a.amount }; } },
  } } } } as any, { surfaces: [chatSurface()], protectionsBanner: false } as any);
  const send = async (approvals?: Record<string, boolean>) => {
    const res = await api(new Request('http://x/agents/a/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workKey: 'wk-c1', resourceId: 'u1', threadId: 'th-1', messages: [{ role: 'user', content: 'pay' }], ...(approvals ? { approvals } : {}) }) }));
    const raw = await res.text();
    let j: any = {}; try { j = JSON.parse(raw); } catch { /* */ }
    return { status: res.status, text: j.text ?? '', interrupts: (j.interrupts ?? []) as any[], raw: raw.slice(0, 300) };
  };
  return { paid, send };
}

describe('k3 U2 — a question 0.17.1 left open, answered after the upgrade', () => {
  it('re-sent: still asked, nothing ran; approved by the id it now gives: runs exactly once', async () => {
    const { paid, send } = await openFixture('pending-confirm-one.db', [5]);
    const q = await send();
    expect(paid).toEqual([]);
    expect(q.interrupts.length).toBe(1);
    const r = await send({ [q.interrupts[0].toolCallId]: true });
    console.log(`[U2] q=${q.interrupts[0].toolCallId} → paid=${JSON.stringify(paid)} text=${r.text} ${r.status}`);
    expect(paid).toEqual([5]);
    expect(r.text).toBe('done');
    await send({ [q.interrupts[0].toolCallId]: true });
    expect(paid).toEqual([5]);
  });
  it('approved by the id the client was given before the upgrade (call_0): runs at most once, or asks again', async () => {
    const { paid, send } = await openFixture('pending-confirm-one.db', [5]);
    const r = await send({ call_0: true });
    console.log(`[U2old] paid=${JSON.stringify(paid)} q=${r.interrupts.length} text=${r.text} ${r.status} ${r.status >= 400 ? r.raw : ''}`);
    expect(paid.length).toBeLessThanOrEqual(1);
    if (paid.length === 0) expect(r.interrupts.length, 'not run and not asked: the answer was lost').toBe(1);
    else expect(paid).toEqual([5]);
  });
});

describe('k3 U3 — two questions with the same id, the first left open by 0.17.1', () => {
  it('approving the first after the upgrade does not run the second unasked; approving it too runs it', async () => {
    const { paid, send } = await openFixture('pending-confirm.db', [5, 7]);
    const q = await send();
    expect(q.interrupts.length).toBe(1);
    const q1 = q.interrupts[0].toolCallId;
    const r2 = await send({ [q1]: true });
    console.log(`[U3] after q1(${q1}): paid=${JSON.stringify(paid)} q=${JSON.stringify(r2.interrupts.map((i: any) => [i.toolCallId, i.args]))} text=${r2.text}`);
    expect(paid).toEqual([5]);
    expect(r2.interrupts.length, 'pay 7 must be asked').toBe(1);
    const r3 = await send({ [q1]: true, [r2.interrupts[0].toolCallId]: true });
    expect(paid).toEqual([5, 7]);
    expect(r3.text).toBe('done');
  });
});
