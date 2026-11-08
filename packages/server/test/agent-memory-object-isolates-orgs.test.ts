// KARAR-1 (d25 memory cluster), user decision of 8 Nov 2026, point 2: when ONE `AgentMemory` object
// serves several organizations, each organization's memory is its own.
//
// The reason the server used to drop the object is real: a single store shared by every organization
// is keyed by a caller-chosen thread id, so naming another tenant's thread read it. The decision
// keeps the object AND the boundary. Read from outside, through what the model is shown and what each
// organization's partition holds:
//   - the same threadId in two organizations is two threads: B is never shown A's turn, and neither
//     partition holds the other's text;
//   - resource-scoped recall (`recall: { scope: 'resource' }`) of user `u1` in B never brings back
//     what `u1` said in A — while it DOES work inside A (positive control, so a recall that silently
//     does nothing cannot pass);
//   - working memory written in A is not shown in B, and is stored in A's partition only.
//
// Every case also runs with `memoryFactory`, the documented per-organization form: it must hold there
// too, and it proves the assertions are satisfiable today.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, type Storage } from '@gnldev/durable';
import { AgentMemory } from '../../memory/src/index.js';
import { ORG_DOORS, recordingModel, storedTexts, storedWorkingMemory, embed } from './memory-under-orgs.world.js';

type MemoryOpts = Record<string, unknown>;
type Style = { name: string; config: (storage: Storage, model: unknown, opts: MemoryOpts) => Record<string, unknown> };
const STYLES: Style[] = [
  { name: 'memory: new AgentMemory(...)', config: (storage, model, opts) => ({ storage, memory: new AgentMemory({ storage, ...opts } as never), agents: { a: { model } } }) },
  { name: 'memoryFactory', config: (storage, model, opts) => ({ storage, memoryFactory: (s: Storage) => new AgentMemory({ storage: s, ...opts } as never), agents: { a: { model } } }) },
];

for (const style of STYLES) {
  describe(`${style.name} — one organization's memory is not another's`, () => {
    for (const door of ORG_DOORS) {
      it(`${door.name}: the same threadId in two organizations is two threads`, async () => {
        const storage = new InMemoryStorage();
        const { model, prompts } = recordingModel();
        const d = door.build(style.config(storage, model, { recentN: 20 }));
        const [A, B] = d.orgs as [string, string];

        expect((await d.turn(A, 'SAME', 'the vault code is VAULT-A-9931')).status).toBe(200);
        const b = await d.turn(B, 'SAME', 'what was said before in this thread?');
        // Another organization naming the same thread id is not a conflict: it is its own thread.
        expect(b.status, b.body).toBe(200);
        expect(prompts.at(-1), `organization '${B}' was shown organization '${A}''s thread`).not.toContain('VAULT-A-9931');
        expect(await storedTexts(storage, B, 'SAME')).not.toContain('VAULT-A-9931');
        expect(await storedTexts(storage, B, 'SAME'), `organization '${B}''s own turn was not stored`).toContain('what was said before');

        // Back in A: its thread has its own turn, and none of B's.
        expect((await d.turn(A, 'SAME', 'and now?')).status).toBe(200);
        expect(prompts.at(-1), `organization '${A}' lost its own thread`).toContain('VAULT-A-9931');
        expect(prompts.at(-1), `organization '${A}' was shown organization '${B}''s turn`).not.toContain('what was said before');
      });

      it(`${door.name}: resource-scoped recall of the same user stays inside the organization`, async () => {
        const storage = new InMemoryStorage();
        const { model, prompts } = recordingModel();
        // recentN 1: an earlier thread can only reach a new thread's prompt through recall.
        const d = door.build(style.config(storage, model, { embed, recentN: 1, recall: { scope: 'resource', topK: 3 } }));
        const [A, B] = d.orgs as [string, string];

        expect((await d.turn(A, 'RA-1', 'my invoice INV-A-SECRET-77 is overdue')).status).toBe(200);

        // Positive control: recall works across u1's threads inside A.
        expect((await d.turn(A, 'RA-2', 'any news on my invoice?')).status).toBe(200);
        expect(prompts.at(-1), 'resource recall did not work inside the organization (control)').toContain('INV-A-SECRET-77');

        // The same user id in B, same kind of question: nothing of A's comes back.
        const b = await d.turn(B, 'RB-1', 'any news on my invoice?');
        expect(b.status, b.body).toBe(200);
        expect(prompts.at(-1), `resource recall in '${B}' returned '${A}''s message`).not.toContain('INV-A-SECRET-77');
      });

      it(`${door.name}: working memory is the organization's own`, async () => {
        const storage = new InMemoryStorage();
        const { model, prompts } = recordingModel();
        const d = door.build(style.config(storage, model, { recentN: 20, workingMemory: { scope: 'thread' } }));
        const [A, B] = d.orgs as [string, string];

        expect((await d.turn(A, 'WM', 'REMEMBER WM-A-NOTE-5')).status).toBe(200);
        expect(await storedWorkingMemory(storage, A, 'WM'), `working memory was not written to '${A}''s partition`)
          .toEqual({ note: 'WM-A-NOTE-5' });

        // Control: A's next turn is shown its working memory.
        expect((await d.turn(A, 'WM', 'hello again')).status).toBe(200);
        expect(prompts.at(-1)).toContain('WM-A-NOTE-5');

        const b = await d.turn(B, 'WM', 'hello');
        expect(b.status, b.body).toBe(200);
        expect(prompts.at(-1), `organization '${B}' was shown '${A}''s working memory`).not.toContain('WM-A-NOTE-5');
        expect(JSON.stringify(await storedWorkingMemory(storage, B, 'WM') ?? null)).not.toContain('WM-A-NOTE-5');
        expect(JSON.stringify(await storedWorkingMemory(storage, undefined, 'WM') ?? null), 'working memory landed in the root store')
          .not.toContain('WM-A-NOTE-5');
      });
    }
  });
}
