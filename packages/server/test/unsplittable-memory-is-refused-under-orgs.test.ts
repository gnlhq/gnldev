// KARAR-1 (d25 memory cluster), user decision of 8 Nov 2026, points 2-3 ("no silent drop on any
// path") and the startup banner.
//
// A conversation store the framework cannot split per organization — the developer's own object that
// implements the `Memory` interface — handed to a deployment that binds requests to organizations
// must be REFUSED, loudly, naming the fix (`memoryFactory`). Never: served with memory quietly off
// (what createRestApi did under a roleAuth `orgId` — the banner said "memory ✓", `gnl_messages` stayed
// empty), and never shared across organizations.
//
// When the refusal happens:
//   - at construction wherever the door already knows it serves organizations (`org` option given);
//   - otherwise — the organization is only learnt from a request's identity — at the FIRST org-bound
//     request, and at every one after it.
// What counts as loud:
//   - at construction: a thrown, TYPED error (its own `name`, or a string `code`), whose message
//     names `memoryFactory`;
//   - at request time: no 2xx; a 5xx answer carrying a string `code`, with `memoryFactory` named in
//     the answer or in the server log (an error object escaping the handler counts if it is typed and
//     names `memoryFactory`); the model is never called; the object is never consulted.
//
// The banner half: createRestApi's protections block must not mark memory "✓" for a store it will
// refuse or not use, and must mark it "✓" for one that works per organization.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InMemoryStorage, type Storage } from '@gnldev/durable';
import { roleAuth } from '@gnldev/auth';
import { AgentMemory } from '../../memory/src/index.js';
import { createRestApi } from '../src/index.js';
import { ORG_DOORS, recordingModel, restOrgHeader, restChatSurface, restAguiSurface, type DoorFactory } from './memory-under-orgs.world.js';

/** The developer's own store: implements `Memory`, has no notion of an organization, records every call. */
function ownMemory() {
  const calls: string[] = [];
  const threads = new Map<string, unknown[]>();
  const mem = {
    getMessages: async (id: string) => { calls.push(`getMessages:${id}`); return threads.get(id) ?? []; },
    append: async (id: string, msgs: unknown[]) => { calls.push(`append:${id}`); threads.set(id, [...(threads.get(id) ?? []), ...msgs]); },
    loadContext: async (id: string) => { calls.push(`loadContext:${id}`); return { messages: threads.get(id) ?? [] }; },
  };
  return { mem, calls };
}

let logs: string[] = [];
let spies: ReturnType<typeof vi.spyOn>[] = [];
function captureLogs() {
  logs = [];
  const keep = (...a: unknown[]) => { logs.push(a.map((x) => (x instanceof Error ? `${x.name}: ${x.message}` : String(x))).join(' ')); };
  spies = [vi.spyOn(console, 'error').mockImplementation(keep), vi.spyOn(console, 'warn').mockImplementation(keep)];
}
afterEach(() => { for (const s of spies) s.mockRestore(); spies = []; });

/** Loud and typed: an Error with its own name or a string `code`, naming the fix. */
function expectTypedRefusal(e: unknown, where: string) {
  expect(e, `${where}: what was thrown is not an Error`).toBeInstanceOf(Error);
  const err = e as Error & { code?: unknown };
  expect(err.message, `${where}: the refusal does not name the fix`).toMatch(/memoryFactory/);
  expect(err.name !== 'Error' || typeof err.code === 'string',
    `${where}: the refusal is an untyped Error (no own name, no code) — a host cannot tell it from any other failure`).toBe(true);
}

type Outcome = { at: 'construction' } | { at: 'request' };

/** Builds the door over an unsplittable object and drives two org-bound turns; asserts a loud refusal. */
async function expectLoudRefusal(door: DoorFactory): Promise<Outcome> {
  const storage = new InMemoryStorage();
  const { model, prompts } = recordingModel();
  const { mem, calls } = ownMemory();
  captureLogs();
  let d;
  try {
    d = door.build({ storage, memory: mem, agents: { a: { model } } });
  } catch (e) {
    expectTypedRefusal(e, `${door.name} (construction)`);
    return { at: 'construction' };
  }
  const org = d.orgs[0]!;
  for (const attempt of [1, 2]) {
    let t: { status: number; body: string } | undefined;
    try {
      t = await d.turn(org, 'T1', 'my invoice number is INV-OWN-1');
    } catch (e) {
      expectTypedRefusal(e, `${door.name} (request ${attempt})`);
    }
    if (t) {
      expect(t.status, `${door.name} (request ${attempt}): an org-bound turn was SERVED — the memory was dropped silently or shared`)
        .not.toBe(200);
      expect(t.status, `${door.name} (request ${attempt}): a misconfigured store is the server's fault, not the caller's`).toBeGreaterThanOrEqual(500);
      // d25/26c (was: "answer or log"): the fix sentence is for the operator — the server log only.
      expect(logs.join('\n'), `${door.name} (request ${attempt}): the server log does not name memoryFactory`).toMatch(/memoryFactory/);
      let body: { code?: unknown; error?: { data?: { code?: unknown } } } = {};
      try { body = JSON.parse(t.body); } catch { /* not JSON */ }
      const code = body.code ?? body.error?.data?.code;
      expect(typeof code, `${door.name} (request ${attempt}): the answer carries no error code — ${t.body.slice(0, 200)}`).toBe('string');
    }
  }
  expect(prompts.length, `${door.name}: the model ran although the conversation store was refused`).toBe(0);
  expect(calls, `${door.name}: the unsplittable object was consulted for an organization's turn`).toEqual([]);
  return { at: 'request' };
}

describe('an unsplittable memory object under organizations is refused, on every door', () => {
  for (const door of ORG_DOORS) {
    it(`${door.name}: refused loudly (construction, or every org-bound request), naming memoryFactory`, async () => {
      await expectLoudRefusal(door);
    });
  }

  // Where the door is TOLD it serves organizations, the refusal cannot wait for traffic.
  for (const door of [restOrgHeader, restChatSurface, restAguiSurface]) {
    it(`${door.name}: refused at construction, because the \`org\` option already says organizations are served`, async () => {
      expect((await expectLoudRefusal(door)).at).toBe('construction');
    });
  }

  it('the same mistake gets the same kind of refusal from every door that throws one', () => {
    // One rule, one owner: two doors refusing the same config with two different error types is two
    // copies of the rule. Compared on what a host can branch on: the error's name and code.
    const kinds = new Set<string>();
    for (const door of ORG_DOORS) {
      const { mem } = ownMemory();
      const { model } = recordingModel();
      captureLogs();
      try { door.build({ storage: new InMemoryStorage(), memory: mem, agents: { a: { model } } }); }
      catch (e) { kinds.add(`${(e as Error).name}/${String((e as { code?: unknown }).code)}`); }
      for (const s of spies) s.mockRestore();
    }
    expect(kinds.size, 'no door refused at construction at all').toBeGreaterThan(0);
    expect([...kinds], 'doors refuse the same config with different error types').toHaveLength(1);
  });
});

describe('createRestApi\'s protections banner tells the truth about memory under organizations', () => {
  const mkModel = () => recordingModel().model;

  /** Builds the API, returns { threw, memoryRow } — the banner's memory row, as printed. */
  function boot(config: Record<string, unknown>, opts: Record<string, unknown>): { threw: boolean; memoryRow: string } {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
    let threw = false;
    try { createRestApi(config as never, opts as never); } catch { threw = true; } finally { spy.mockRestore(); }
    const rows = lines.join('\n').split('\n').map((l) => l.trim());
    // A row starts with its glyph; note lines under a row do not.
    const memoryRow = rows.find((l) => /^[✓○─?]\s/.test(l) && /\bmemory\b/i.test(l)) ?? ''; // not "InMemoryStorage"
    return { threw, memoryRow };
  }
  const roleOrg = () => ({ auth: roleAuth({ client: { token: 'C', orgId: 'acme' } }) });
  const headerOrg = () => ({ org: {} });
  const isOn = (row: string) => row.startsWith('✓');

  it('an unsplittable object under a roleAuth orgId: no "✓" — the server refuses or does not print it as on', () => {
    const storage = new InMemoryStorage();
    const { threw, memoryRow } = boot({ storage, memory: ownMemory().mem, agents: { a: { model: mkModel() } } }, roleOrg());
    if (!threw) {
      expect(memoryRow, 'the banner has no memory row').not.toBe('');
      expect(isOn(memoryRow), `the banner claims memory is on for a store every org-bound request will refuse: ${memoryRow}`).toBe(false);
    }
  });

  for (const [label, opts] of [['roleAuth orgId', roleOrg], ['`org` option', headerOrg]] as const) {
    it(`AgentMemory object under ${label}: boots, and the banner marks memory "✓"`, () => {
      const storage = new InMemoryStorage();
      const { threw, memoryRow } = boot({ storage, memory: new AgentMemory({ storage }), agents: { a: { model: mkModel() } } }, opts());
      expect(threw, 'an AgentMemory object under organizations was refused at construction').toBe(false);
      expect(isOn(memoryRow), `memory works per organization, but the banner does not say so: ${memoryRow}`).toBe(true);
    });

    it(`memoryFactory under ${label}: boots, and the banner marks memory "✓" (unchanged)`, () => {
      const storage = new InMemoryStorage();
      const { threw, memoryRow } = boot({ storage, memoryFactory: (s: Storage) => new AgentMemory({ storage: s }), agents: { a: { model: mkModel() } } }, opts());
      expect(threw).toBe(false);
      expect(isOn(memoryRow), memoryRow).toBe(true);
    });
  }

  it('an unsplittable object WITHOUT organizations: boots, and the banner marks memory "✓" (unchanged)', () => {
    const storage = new InMemoryStorage();
    const { threw, memoryRow } = boot({ storage, memory: ownMemory().mem, agents: { a: { model: mkModel() } } }, {});
    expect(threw).toBe(false);
    expect(isOn(memoryRow), memoryRow).toBe(true);
  });
});

describe('an unsplittable object WITHOUT organizations keeps working (regression)', () => {
  it('REST /run on a thread consults it: loads the thread and appends the turn', async () => {
    const { model } = recordingModel();
    const { mem, calls } = ownMemory();
    const api = createRestApi({ storage: new InMemoryStorage(), memory: mem, agents: { a: { model } } } as never, { protectionsBanner: false } as never) as unknown as (r: Request) => Promise<Response>;
    const res = await api(new Request('http://x/agents/a/run', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'r1', threadId: 'T1', prompt: 'hi', resourceId: 'u1' }),
    }));
    expect(res.status, await res.text()).toBe(200);
    expect(calls.some((c) => c.endsWith(':T1') && !c.startsWith('append')), 'the thread was not loaded').toBe(true);
    expect(calls, 'the turn was not appended').toContain('append:T1');
  });
});
