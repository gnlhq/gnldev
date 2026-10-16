// T7  The run-event signal (Postgres NOTIFY) is one channel every process of every organization shares;
//     its payload carried `<org>/<runId>` in plain text — and a run id can carry a person's name.
// T8  A process lock is taken with a blocking `pg_advisory_lock` on a 32-bit hash of the process id: a
//     second session with the same lock key (a hash collision, or the same id twice) hangs at startup
//     forever instead of failing. (The same id twice is no longer one key: a configured id is a prefix.)
// T9  `heartbeatMs` is how stale a self-proof `confirm()` accepts, and the server gives up on a silent
//     session in ~25 s. A heartbeat at or past that window silently voids the guarantee: refused.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, DetachedRuns, streamDurable, inMemoryLiveness, postgresLiveness, type RunSignal } from '../src/index.js';
import { streamingModel } from './detached/models.js';

const PG = process.env.GNL_PG_URL;

describe('T7: the run-event signal carries no run id', () => {
  it('the payload is opaque (no org, no run id) and still wakes the follower', async () => {
    const sent: string[] = [];
    const subs: Array<(k: string) => void> = [];
    const signal: RunSignal = { notify: async (k) => { sent.push(k); for (const s of subs) s(k); }, subscribe: async (fn) => { subs.push(fn); } };
    const journal = new InMemoryJournal();
    const runs = new DetachedRuns({ journal, liveness: inMemoryLiveness(), signal, resume: () => { throw new Error('no'); }, sweepMs: 0 });
    const model = streamingModel({ words: ['a ', 'b '], gapMs: 1 });
    await runs.start({ runId: 'job:ayse-yilmaz', scope: 'acme', launch: (s) => streamDurable({ journal, runId: 'job:ayse-yilmaz', model, prompt: 'p', resourceId: 'ayse', abortSignal: s } as any) });
    for await (const _ of runs.follow({ runId: 'job:ayse-yilmaz', scope: 'acme' })) { /* to the end */ }
    expect(sent.length).toBeGreaterThan(0);
    for (const p of sent) {
      expect(p).not.toContain('ayse');
      expect(p).not.toContain('acme');
    }
    await runs.close();
  });
});

describe.skipIf(!PG)('T8/T9: Postgres liveness session (real)', () => {
  // A configured id is a prefix now (process-liveness.ts `livenessIdOf`, audit C8): two sessions given one
  // id hold two locks, so the second neither hangs nor is refused — it starts under an id of its own.
  it('T8: a second session given the same id starts at once, under its own lock', async () => {
    const a = await postgresLiveness({ connectionString: PG!, id: 'same-id' });
    try {
      const second = postgresLiveness({ connectionString: PG!, id: 'same-id' });
      const r = await Promise.race([second.then(async (s) => { const other = s.id !== a.id; await s.close(); return other ? 'started' : 'same id'; }, (e) => String(e)), new Promise((res) => setTimeout(() => res('hung'), 5_000))]);
      expect(r).toBe('started');
    } finally { await a.close(); }
  });

  it('T9: a heartbeat at or past the server keepalive window is refused', async () => {
    await expect(postgresLiveness({ connectionString: PG!, heartbeatMs: 30_000 })).rejects.toThrow(/heartbeat/i);
  });
});
