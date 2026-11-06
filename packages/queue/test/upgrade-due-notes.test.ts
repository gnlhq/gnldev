// The notes a package leaves when it meets data its upgrade step has not moved (@gnldev/durable
// `markUpgradeDue`), and that the step clears as its last act (`clearUpgradeDue`). Without them a
// `storage.upgrade()` on a store where nobody registered the step finds nothing to do and says the store
// is up to date, while this version's worker refuses it.
//
//   · queue — a worker on v1 data (0.16's one log) notes `queue/lanes`; on v2 (moved, old log still there)
//     `queue/lanes-cleanup`. Each step clears its own.
//   (The scheduler's note: packages/scheduler/test/upgrade-due-notes.test.ts.)
//
// The 0.16 store is the committed fixture (packages/upgrade-tests/fixtures/0.16.0/queue.db).
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerUpgradeSteps, toJournal, InMemoryStorage, UpgradeFailedError, type Storage } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { createWorker, queueUpgrade } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, '..', '..', 'upgrade-tests', 'fixtures', '0.16.0', 'queue.db');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function copyOf016(): string {
  const d = mkdtempSync(join(tmpdir(), 'gnl-due-'));
  dirs.push(d);
  const file = join(d, 'q.db');
  copyFileSync(FIXTURE, file);
  return file;
}
const notes = async (s: Storage) => (await toJournal(s.runs).listKeys('__upgrade_due__:')).sort();
const rowOf = (r: { steps: Array<{ name: string; detail?: Record<string, unknown> }> }, name: string) => r.steps.find((x) => x.name === name);
async function runOnceOf(s: Storage): Promise<unknown> {
  const w = createWorker(s, { t: async () => undefined }, { ttlMs: 10_000, heartbeat: false });
  try { return await w.runOnce(); } catch (e) { return e; } finally { await w.close(); }
}

describe('queue: a worker notes the step its data waits for, the step clears it', () => {
  it('v1: the refused worker leaves a note for queue/lanes, and an upgrade() nobody registered the step on fails with the line to add', async () => {
    const file = copyOf016();
    const s = new SqliteStorage(file);
    expect(await notes(s)).toEqual([]);
    const refused = await runOnceOf(s);
    expect(String(refused)).toMatch(/job data is at v1/);
    expect(await notes(s)).toEqual(['__upgrade_due__:queue/lanes']);
    const dry = await s.upgrade!({ dryRun: true });
    expect(rowOf(dry, 'queue/lanes')?.detail).toMatchObject({ notRegistered: true, register: 'registerUpgradeSteps(storage, [queueUpgrade])', dataVersion: 1 });
    const err = await s.upgrade!().then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(UpgradeFailedError);
    expect(String((err as Error).message)).toMatch(/registerUpgradeSteps\(storage, \[queueUpgrade\]\)/);
    await s.close?.();
  });

  it('queue/lanes clears its note; a worker on v2 then notes queue/lanes-cleanup, which that step clears', async () => {
    const file = copyOf016();
    const s = registerUpgradeSteps(new SqliteStorage(file), [queueUpgrade]);
    await runOnceOf(s); // v1: refused, noted
    expect(await notes(s)).toEqual(['__upgrade_due__:queue/lanes']);
    await s.upgrade!();
    expect(await notes(s)).toEqual([]);
    expect(await runOnceOf(s)).not.toBeInstanceOf(Error); // v2: the worker starts
    expect(await notes(s)).toEqual(['__upgrade_due__:queue/lanes-cleanup']);
    // Registered, the note is answered by its step: a plain upgrade() leaves the cleanup waiting and does not fail.
    const plain = await s.upgrade!();
    expect(rowOf(plain, 'queue/lanes-cleanup')?.detail).toHaveProperty('waits');
    // The same file opened with nothing registered: the cleanup is a debt nobody answers.
    const bare = new SqliteStorage(file);
    expect(rowOf(await bare.upgrade!({ dryRun: true }), 'queue/lanes-cleanup')?.detail).toMatchObject({ notRegistered: true, dataVersion: 2 });
    await bare.close?.();
    await s.upgrade!({ only: ['queue/lanes-cleanup'] });
    expect(await notes(s)).toEqual([]);
    expect(await runOnceOf(s)).not.toBeInstanceOf(Error); // v3: nothing to note
    expect(await notes(s)).toEqual([]);
    await s.close?.();
  });

  it('a store this version wrote gets no note', async () => {
    const s = new InMemoryStorage();
    await runOnceOf(s);
    expect(await notes(s)).toEqual([]);
  });
});
