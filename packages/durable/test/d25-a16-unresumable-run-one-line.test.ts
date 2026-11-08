// d25 A16 (cli/KARAR-8, option A): a half-finished run this deployment cannot continue (its agent is no longer
// registered) is announced at boot in ONE line — its id, the reason as text, and where to look (`gnl pending`) —
// not with the Error object, which Node prints as a multi-line stack trace. Measured on 0.17.1: it is printed once
// (boot 1), boots 2 and 3 are silent (kept as a control); the remaining problem is the stack dump.
// Where a stack may still appear (a debug mode) is not fixed by the decision and is not tested.
//
// Builds on fix/d25-cli 06c3f14f.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InMemoryStorage, DetachedRuns, inMemoryLiveness, type Journal } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { execKey } from '../src/exec-record.js';

afterEach(() => vi.restoreAllMocks());

const REASON = "agent 'rental' is not registered";
const resumers = {
  'resume throws': () => { throw new Error(REASON); },
  'resume rejects': () => Promise.reject(new Error(REASON)),
} as const;

async function boots(make: () => any, resume: () => unknown) {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const storage = make();
  const journal = storage.runs as unknown as Journal;
  const runId = `old-${Math.random().toString(36).slice(2)}`;
  await journal.put(execKey(undefined, runId), { v: 1, runId, owner: 'dead', status: 'running', at: Date.now() - 60_000, from: 0, meta: { agent: 'rental' } });
  await journal.put(`${runId}:outcome`, { status: 'running', at: Date.now() - 60_000 });
  const perBoot: unknown[][][] = [];
  for (let i = 1; i <= 3; i++) {
    warn.mockClear();
    const b = new DetachedRuns({ journal, liveness: inMemoryLiveness(`B${i}`), resume: resume as never, sweepMs: 0 });
    await b.sweep();
    perBoot.push(warn.mock.calls.filter((c) => c.some((x) => String(x).includes(runId))));
    await b.close();
  }
  return { runId, perBoot };
}

describe.each([['in-memory', () => new InMemoryStorage()], ['sqlite', () => new SqliteStorage(':memory:')]] as const)('A16: an unresumable run at boot — %s', (_n, make) => {
  for (const [label, resume] of Object.entries(resumers)) {
    it(`${label}: boot 1 prints one line (id + reason + gnl pending), no Error object; boots 2-3 silent`, async () => {
      const { runId, perBoot } = await boots(make, resume);
      expect(perBoot[0]!.length, 'boot 1 names the run once').toBe(1);
      expect(perBoot.slice(1).map((c) => c.length), 'boots 2 and 3 are silent (control)').toEqual([0, 0]);
      const args = perBoot[0]![0]!;
      expect(args.some((x) => x instanceof Error), 'an Error object is printed by Node with its stack trace').toBe(false);
      const line = args.map(String).join(' ');
      expect(line).not.toContain('\n');
      expect(line).toContain(runId);
      expect(line).toContain(REASON);
      expect(line).toMatch(/gnl pending/);
    });
  }
});
