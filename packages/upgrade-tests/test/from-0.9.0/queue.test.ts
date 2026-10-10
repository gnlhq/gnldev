// Upgrade from 0.9.0, @gnldev/queue: a queue 0.9.0 left behind — finished jobs, a row-offset `qcursor`
// ("50"), jobs still pending behind it, dead letters and a 0.9.0 retry copy — opened by the current code.
import { describe, expect, it } from 'vitest';
import { eraseSubject } from '@gnldev/durable';
import { createWorker, enqueue, jobEraser, listJobs, retryJob } from '@gnldev/queue';
import * as S from '../../generate/shapes.mjs';
import { itMigrates, notes090, openFixture, rowsContaining } from '../support.js';

const pad = (n: number) => String(n).padStart(3, '0');
/** Every job 0.9.0 left pending, by payload: p030..p079 and carol's three. */
const pendingOn090 = [
  ...Array.from({ length: S.QUEUE.plainJobs - S.QUEUE.plainDoneOn090 }, (_, i) => `p${pad(S.QUEUE.plainDoneOn090 + i)}`),
  ...Array.from({ length: S.QUEUE.carolJobs }, (_, i) => `c${i}`),
];
const plainWorker = (storage: Parameters<typeof createWorker>[0], ran: string[]) =>
  createWorker(storage, { plain: async (p: { n: string }) => { ran.push(p.n); } }, { maxAttempts: 2, heartbeat: false });

describe('upgrade from 0.9.0 — queue', () => {
  itMigrates('queue.db');
  itMigrates('queue-dead.db');

  it('the fixture is what it claims: 0.9.0 left a row-offset cursor and 53 pending jobs behind it', () => {
    expect(notes090.queue.qcursor).toBe('50');
    expect(notes090.queue.jobs.filter((j: string) => j.endsWith(':pending'))).toHaveLength(pendingOn090.length);
  });

  it('the first drain after the upgrade runs every job 0.9.0 left pending, once, and nothing 0.9.0 finished', async () => {
    const { storage } = await openFixture('queue.db');
    const ran: string[] = [];
    await plainWorker(storage, ran).drain();
    expect([...ran].sort()).toEqual([...pendingOn090].sort());
    expect(await plainWorker(storage, ran).drain()).toBe(0);
    expect((await listJobs(storage.work)).filter((j) => j.status !== 'done')).toEqual([]);
  });

  it('a worker restarted after the first drain runs nothing again', async () => {
    const f = await openFixture('queue.db');
    const ran: string[] = [];
    await plainWorker(f.storage, ran).drain();
    const again: string[] = [];
    expect(await plainWorker(f.reopen(), again).drain()).toBe(0);
    expect(again).toEqual([]);
  });

  it('erasing a person right after the upgrade skips none of anybody else\'s pending jobs', async () => {
    const { storage } = await openFixture('queue.db');
    await eraseSubject(storage, 'ayse', { erasers: [jobEraser(storage)] });
    const ran: string[] = [];
    await plainWorker(storage, ran).drain();
    expect([...ran].sort()).toEqual([...pendingOn090].sort());
  });

  it('the erasure leaves nothing of the erased person\'s 0.9.0 jobs behind', async () => {
    const f = await openFixture('queue.db');
    await eraseSubject(f.storage, 'ayse', { erasers: [jobEraser(f.storage)] });
    expect(rowsContaining(f.path, '~o~:ayse:')).toEqual([]);
    expect(rowsContaining(f.path, '~o~:carol:').length).toBeGreaterThan(0);
  });

  it('a job enqueued after the upgrade runs once, after the 0.9.0 backlog', async () => {
    const { storage } = await openFixture('queue.db');
    const ran: string[] = [];
    await enqueue(storage.work, 'plain', { n: 'new-1' }, { id: 'new-1' });
    await plainWorker(storage, ran).drain();
    expect(ran.filter((n) => n === 'new-1')).toHaveLength(1);
    expect(ran).toHaveLength(pendingOn090.length + 1);
  });
});

describe('upgrade from 0.9.0 — a queue 0.9.0 itself erased a person from', () => {
  itMigrates('queue-erased.db');

  it('the fixture is what it claims: 0.9.0 removed 40 rows from under its row-offset cursor', () => {
    expect(notes090.queueErasedOn090.erase.byEraser.jobs).toBeGreaterThanOrEqual(S.QUEUE.ayseJobs);
    expect(notes090.queueErasedOn090.qcursor).toBe('50');
  });

  it('the first drain after the upgrade runs every job that was pending when 0.9.0 erased, once', async () => {
    const { storage } = await openFixture('queue-erased.db');
    const ran: string[] = [];
    await plainWorker(storage, ran).drain();
    expect([...ran].sort()).toEqual([...pendingOn090].sort());
    expect(await plainWorker(storage, ran).drain()).toBe(0);
  });
});

describe('upgrade from 0.9.0 — queue dead letters', () => {
  const payWorker = (storage: Parameters<typeof createWorker>[0], charges: string[], ran: string[]) =>
    createWorker(storage, {
      pay: async (_p: unknown, ctx: { runId: string; jobId: string; run: (a: any) => Promise<any> }) => {
        ran.push(ctx.jobId);
        await ctx.run({
          model: S.toolThenTextModel({ toolName: S.DEAD.toolName, input: { amount: 20 } }) as any,
          tools: { [S.DEAD.toolName]: { description: 'charge', execute: async () => { charges.push(ctx.runId); return { charged: 20 }; } } } as any,
          prompt: 'pay the order',
        });
      },
    }, { maxAttempts: 2, heartbeat: false });
  const [dl1, dl2] = notes090.deadLetters.ids as string[];
  const copy090 = notes090.deadLetters.copy as string;

  it('the fixture is what it claims: two dead letters whose charge landed, and one unlinked 0.9.0 retry copy', () => {
    expect(notes090.deadLetters.chargesOn090).toEqual([`job:${dl1}`, `job:${dl2}`]);
    expect(notes090.deadLetters.jobs).toContain(`${copy090}:pending`);
  });

  it('the 0.9.0 retry copy runs once, under its own run (documented: a 0.9.0 copy carries no link)', async () => {
    const { storage } = await openFixture('queue-dead.db');
    const charges: string[] = [];
    const ran: string[] = [];
    await payWorker(storage, charges, ran).drain();
    expect(ran).toEqual([copy090]);
    expect(charges).toEqual([`job:${copy090}`]);
    expect(await payWorker(storage, charges, ran).drain()).toBe(0);
  });

  it('a 0.9.0 dead letter retried after the upgrade continues its run: the charge is not made again', async () => {
    const { storage } = await openFixture('queue-dead.db');
    const charges: string[] = [];
    const ran: string[] = [];
    const retried = await retryJob(storage.work, dl1);
    expect(retried).toBeTruthy();
    await payWorker(storage, charges, ran).drain();
    expect(ran).toContain(retried);
    expect(charges.filter((c) => c === `job:${dl1}`)).toEqual([]);
  });

  it('two clicks on retry for the same 0.9.0 dead letter still charge nothing', async () => {
    const { storage } = await openFixture('queue-dead.db');
    const charges: string[] = [];
    const ran: string[] = [];
    await retryJob(storage.work, dl1);
    await retryJob(storage.work, dl1);
    await payWorker(storage, charges, ran).drain();
    expect(charges.filter((c) => c !== `job:${copy090}`)).toEqual([]);
  });

  it('the dead letters stay listed as failed for audit after their retry', async () => {
    const { storage } = await openFixture('queue-dead.db');
    await retryJob(storage.work, dl1);
    await payWorker(storage, [], []).drain();
    const status = new Map((await listJobs(storage.work)).map((j) => [j.id, j.status]));
    expect(status.get(dl1)).toBe('failed');
    expect(status.get(dl2)).toBe('failed');
  });

  it('retryJob(…, { newRun: true }) on a 0.9.0 dead letter starts an empty run (the documented way back to 0.9.0 behaviour)', async () => {
    const { storage } = await openFixture('queue-dead.db');
    const charges: string[] = [];
    const id = await retryJob(storage.work, dl2, { newRun: true });
    await payWorker(storage, charges, []).drain();
    expect(charges).toContain(`job:${id}`);
  });
});
