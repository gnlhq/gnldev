// A BARE SCHEDULER'S FIRE LOCK NAMES ITS PROCESS — through `acquireRunLock`, which binds the store's
// liveness itself (run-lock.ts). The scheduler used to call `bindOwnLiveness` on the line before; that
// copy went (one rule, one place) and this is what holds the rule where it now lives.
//
// Isolated on purpose: nothing else touches the store first. k1-liveness L3 ("a bare scheduler") builds a
// `createGnl` in the same app, and the registry's executor binds the store at construction — so L3 passes
// whether or not the scheduler (or the lock) binds anything. Here only the scheduler runs, so the fire
// lock's `proc` comes from the acquisition or from nowhere.
import { describe, it, expect, afterEach } from 'vitest';
import { livenessFor } from '@gnldev/durable';
import { createScheduler, scheduleWorkflow, type WorkflowRunner } from '../src/index.js';
import { kinds, freshDatabase, openStore } from '../../durable/test/mod3-k1/stores.js';
import { distMods } from '../../durable/test/mod3-k1/dist-mods.js';

const ends: Array<() => unknown> = [];
afterEach(async () => { for (const e of ends.splice(0).reverse()) await e(); });

for (const kind of kinds()) {
  describe(`a bare scheduler's fire lock names its process — ${kind}`, () => {
    it('no other component binds the store; the fire lock carries the store liveness id, one session', async () => {
      const fresh = await freshDatabase(kind, 'fire-lock-binds');
      const storage: any = openStore(distMods, fresh.conn);
      ends.push(async () => { await storage.close(); await fresh.dispose(); });
      await storage.runs.get('warm');
      expect(livenessFor(storage.runs)).toBeUndefined(); // nothing bound yet: the lock is the first
      let fire: string | undefined;
      const runner: WorkflowRunner = { async runWorkflow(_n, _i, o) { fire = (await storage.runs.get(`${o!.runId}:fire:lock`))?.proc; return { runId: o!.runId! }; } };
      const sched = createScheduler(storage.runs, runner, { pollMs: 100, lockTtlMs: 5_000 });
      ends.push(() => sched.stop?.());
      await scheduleWorkflow(storage.runs, { id: 's1', name: 'wf', at: Date.now() - 1 });
      await sched.poll();
      const bound = livenessFor(storage.runs);
      expect(bound?.id).toBeTruthy();
      expect(fire).toBe(bound!.id);
      expect(await fresh.sessions()).toBe(1);
    }, 30_000);
  });
}
