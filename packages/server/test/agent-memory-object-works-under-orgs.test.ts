// KARAR-1 (d25 memory cluster), user decision of 8 Nov 2026, points 1 and 4.
//
// `createGnl({ memory: new AgentMemory({ storage }) })` — the shape the docs show and nine trial
// projects used — must WORK when the deployment binds requests to organizations: every organization
// gets the same memory, over its own partition of the storage, with nothing changed by the developer.
// Before: @gnldev/server dropped the object without a word (the banner still said "memory ✓"), and
// the chat / AG-UI / A2A doors refused it. Either way, `gnl_messages` stayed empty.
//
// "Works" is read from outside, on every door:
//   - after a thread turn, the messages are in THAT organization's partition (`withOrgStorage`), and
//     not in the root store;
//   - the next turn on the thread is shown the earlier one by the model (only the NEW message is sent).
//
// The same assertions run against `memoryFactory` — the documented alternative — which must keep
// working (backward compatibility), and against an org-less deployment, where the object must keep
// working as it does today (regression).
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, type Storage } from '@gnldev/durable';
import { AgentMemory } from '../../memory/src/index.js';
import { createRestApi } from '../src/index.js';
import { ORG_DOORS, recordingModel, storedTexts, standaloneChat, standaloneAgui, a2aServer, type DoorFactory } from './memory-under-orgs.world.js';

type Style = { name: string; config: (storage: Storage, model: unknown) => Record<string, unknown> };
const STYLES: Style[] = [
  { name: 'memory: new AgentMemory({ storage })', config: (storage, model) => ({ storage, memory: new AgentMemory({ storage, recentN: 20 }), agents: { a: { model } } }) },
  { name: 'memoryFactory: (s) => new AgentMemory({ storage: s })', config: (storage, model) => ({ storage, memoryFactory: (s: Storage) => new AgentMemory({ storage: s, recentN: 20 }), agents: { a: { model } } }) },
];

for (const style of STYLES) {
  describe(`${style.name} — conversation memory under organizations, on every door`, () => {
    for (const door of ORG_DOORS) {
      it(`${door.name}: the turn is stored in the organization's partition and loaded on the next turn`, async () => {
        const storage = new InMemoryStorage();
        const { model, prompts } = recordingModel();
        const d = door.build(style.config(storage, model));
        const org = d.orgs[0]!;

        const first = await d.turn(org, 'T1', 'my invoice number is INV-ACME-4711');
        expect(first.status, first.body).toBe(200);

        const inOrg = await storedTexts(storage, org, 'T1');
        expect(inOrg, `the turn was not written to organization '${org}''s memory (memory silently off)`).toContain('INV-ACME-4711');
        expect(await storedTexts(storage, undefined, 'T1'), 'the turn landed in the ROOT store, outside the organization').not.toContain('INV-ACME-4711');

        const second = await d.turn(org, 'T1', 'what was my invoice number?');
        expect(second.status, second.body).toBe(200);
        expect(prompts.at(-1), 'the next turn was not shown the earlier one — memory was not loaded').toContain('INV-ACME-4711');
      });
    }
  });
}

describe('memory: new AgentMemory({ storage }) without organizations (regression: works as today)', () => {
  const ORGLESS: { name: string; build: (config: Record<string, unknown>) => (thread: string, text: string) => Promise<{ status: number; body: string }> }[] = [
    {
      name: 'REST /run, no auth, no org',
      build: (config) => {
        const api = createRestApi(config as never, { protectionsBanner: false } as never) as unknown as (r: Request) => Promise<Response>;
        let n = 0;
        return async (threadId, text) => {
          const res = await api(new Request('http://x/agents/a/run', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ runId: `orgless-${++n}`, threadId, prompt: text, resourceId: 'u1' }),
          }));
          return { status: res.status, body: await res.text() };
        };
      },
    },
    ...([standaloneChat, standaloneAgui, a2aServer] as DoorFactory[]).map((f) => ({
      name: `${f.name} — identity carries no organization`,
      // `turn(undefined as never, …)`: the standalone doors' identify() names no organization then.
      build: (config: Record<string, unknown>) => { const d = f.build(config); return (t: string, x: string) => d.turn(undefined as never, t, x); },
    })),
  ];

  for (const door of ORGLESS) {
    it(`${door.name}: stored in the root store and loaded on the next turn`, async () => {
      const storage = new InMemoryStorage();
      const { model, prompts } = recordingModel();
      const turn = door.build({ storage, memory: new AgentMemory({ storage, recentN: 20 }), agents: { a: { model } } });

      const first = await turn('T1', 'my invoice number is INV-ROOT-1');
      expect(first.status, first.body).toBe(200);
      expect(await storedTexts(storage, undefined, 'T1')).toContain('INV-ROOT-1');

      const second = await turn('T1', 'what was it?');
      expect(second.status, second.body).toBe(200);
      expect(prompts.at(-1)).toContain('INV-ROOT-1');
    });
  }
});
