// d25 madde 26c (kullanici karari, 8 Kas 2026): istek aninda bolunemeyen memory nesnesinin retti
// son kullaniciya YAPILANDIRMA IPUCU SIZDIRMAZ.
//
// 500 govdesi: genel mesaj + `memory_not_splittable` kodu. "memoryFactory kullanin" duzeltme cumlesi
// yalniz SUNUCU LOGUNA gider (operator okur, son kullanici degil).
//
// Kapsam: istegin organizasyonu YALNIZ kimlikten ogrenildigi (kurulus aninda `org` secenegi YOK)
// kapilar — REST roleAuth, REST+chatSurface, REST+aguiSurface, createChatRoute, createAguiRoute,
// createA2AServer. (`org` secenegi verilmis kapilar kurulusta firlatir; o, gelistiricinin gordugu hata,
// bu dosyanin konusu degil.)
//
// NOT — mevcut `unsplittable-memory-is-refused-under-orgs.test.ts` "memoryFactory yanitta YA DA logda"
// diyordu; 26c ile "yalniz logda" olur. O test degistirilmedi; kod ajani tek beklentiyi guncelleyecek.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InMemoryStorage } from '@gnldev/durable';
import { roleAuth } from '@gnldev/auth';
import { createRestApi } from '../src/index.js';
import { chatSurface } from '../../chat-adapter/src/index.js';
import { aguiSurface } from '../../agui/src/route.js';
import { restRoleAuth, standaloneChat, standaloneAgui, a2aServer, recordingModel, type Door, type DoorFactory } from './memory-under-orgs.world.js';

/** Elle yazilmis, org kavrami olmayan store. */
function ownMemory() {
  const calls: string[] = [];
  const mem = {
    getMessages: async (id: string) => { calls.push(`getMessages:${id}`); return []; },
    append: async (id: string) => { calls.push(`append:${id}`); },
    loadContext: async (id: string) => { calls.push(`loadContext:${id}`); return { messages: [] }; },
  };
  return { mem, calls };
}

let logs: string[] = [];
let spies: ReturnType<typeof vi.spyOn>[] = [];
function captureLogs() {
  logs = [];
  const keep = (...a: unknown[]) => { logs.push(a.map((x) => (x instanceof Error ? `${x.name}: ${x.message}` : typeof x === 'string' ? x : JSON.stringify(x) ?? String(x))).join(' ')); };
  spies = [vi.spyOn(console, 'error').mockImplementation(keep), vi.spyOn(console, 'warn').mockImplementation(keep), vi.spyOn(console, 'log').mockImplementation(keep), vi.spyOn(console, 'info').mockImplementation(keep)];
}
afterEach(() => { for (const s of spies) s.mockRestore(); spies = []; });

const SECRET = 'APP-ACME';
const restWith = (name: string, surface: () => unknown, path: string, body: (t: string, thread: string) => unknown): DoorFactory => ({
  name,
  build(config) {
    const api = createRestApi(config as never, { auth: roleAuth({ client: { token: SECRET, orgId: 'acme' } }), protectionsBanner: false, surfaces: [surface()] } as never) as unknown as (r: Request) => Promise<Response>;
    return {
      name, orgs: ['acme'],
      turn: async (_org, threadId, text) => {
        const res = await api(new Request(`http://x${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` }, body: JSON.stringify(body(text, threadId)) }));
        return { status: res.status, body: await res.text() };
      },
    } as Door;
  },
});
const restChatRoleAuth = restWith('chatSurface on createRestApi (roleAuth orgId)', () => chatSurface(), '/agents/a/chat',
  (t, id) => ({ id, threadId: id, resourceId: 'u1', messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: t }] }] }));
const restAguiRoleAuth = restWith('aguiSurface on createRestApi (roleAuth orgId)', () => aguiSurface(), '/agents/a/agui',
  (t, id) => ({ runId: `r-${id}`, threadId: id, prompt: t, resourceId: 'u1' }));

const DOORS: DoorFactory[] = [restRoleAuth, restChatRoleAuth, restAguiRoleAuth, standaloneChat, standaloneAgui, a2aServer];

describe('d25/26c — the request-time refusal body is generic; the fix sentence goes to the log', () => {
  for (const door of DOORS) {
    it(`${door.name}: 5xx + code memory_not_splittable, no memoryFactory in the body, memoryFactory in the log`, async () => {
      const { model, prompts } = recordingModel();
      const { mem, calls } = ownMemory();
      captureLogs();
      const d = door.build({ storage: new InMemoryStorage(), memory: mem, agents: { a: { model } } });
      const t = await d.turn(d.orgs[0]!, 'T1', 'my invoice number is INV-OWN-1');

      expect(t.status, `a misconfigured store must not be served: ${t.body.slice(0, 200)}`).toBeGreaterThanOrEqual(500);
      // The wire code the host/UI can branch on (REST/chat/AG-UI: body.code; A2A JSON-RPC: error.data.code).
      let body: { code?: unknown; error?: { data?: { code?: unknown } } } = {};
      try { body = JSON.parse(t.body); } catch { /* not JSON — asserted below */ }
      expect(body.code ?? body.error?.data?.code, `no machine-readable code: ${t.body.slice(0, 200)}`).toBe('memory_not_splittable');
      // 26c proper: nothing configuration-shaped reaches the end user.
      expect(t.body, 'the answer leaks the memoryFactory fix sentence to the end user').not.toMatch(/memoryFactory/i);
      expect(t.body, 'the answer leaks a configuration fix (function-of-organization hint)').not.toMatch(/\(\{ orgId \}\)/);
      // A generic message is still there (not an empty body).
      expect(t.body.length).toBeGreaterThan(20);
      // …and the operator is told, in the server log.
      expect(logs.join('\n'), 'the fix sentence went nowhere: the server log does not name memoryFactory').toMatch(/memoryFactory/);
      // Behaviour unchanged: the model never ran, the object was never consulted.
      expect(prompts.length).toBe(0);
      expect(calls).toEqual([]);
    });
  }

  it('the generic body is the SAME text on every door that answers with a message string (one rule, one wording)', async () => {
    const messages = new Set<string>();
    for (const door of [restRoleAuth, restChatRoleAuth, restAguiRoleAuth, standaloneChat, standaloneAgui]) {
      const { model } = recordingModel();
      captureLogs();
      const d = door.build({ storage: new InMemoryStorage(), memory: ownMemory().mem, agents: { a: { model } } });
      const t = await d.turn(d.orgs[0]!, 'T1', 'hello');
      const b = JSON.parse(t.body) as { error?: unknown; message?: unknown };
      const m = b.error ?? b.message;
      expect(typeof m, `${door.name}: no message field in ${t.body.slice(0, 150)}`).toBe('string');
      messages.add(String(m));
      for (const s of spies) s.mockRestore();
    }
    expect([...messages], 'doors word the same refusal differently').toHaveLength(1);
  });

  it('regression: the log line also names the organization-binding reason ("organization") for the operator', async () => {
    const { model } = recordingModel();
    captureLogs();
    const d = restRoleAuth.build({ storage: new InMemoryStorage(), memory: ownMemory().mem, agents: { a: { model } } });
    await d.turn('acme', 'T1', 'hello');
    expect(logs.join('\n')).toMatch(/organization/i);
  });
});
