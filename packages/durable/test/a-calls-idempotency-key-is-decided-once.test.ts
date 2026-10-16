// A call's idempotency key is decided once — when the call is first recorded — written into the call's
// own record, and read back from there by everything that hands it out later: a retry's body, the
// recover() probe, compensateRun. It is never derived a second time.
//
// It was derived again by each reader, from the run it found itself in: the body got it from the
// window's request (`<request>:<tool>:<hash>`), compensateRun rebuilt it from the run-scoped key
// (`<run>:<toolCallId>`) — so the provider was asked about a key it had never seen, answered "never
// happened", and an effect that had happened was not unwound.
import { describe, it, expect } from 'vitest';
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { compensateRun } from '../src/compensation.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

const model = () => createMockModel(async ({ prompt }: any) =>
  countToolResults(prompt) === 0 ? toolCallResult('charge', 'call-1', { id: 'A' }) : finalTextResult('done'));

function charge(seen: { body: string[]; recover: string[] }, opts: { idempotency?: 'args' } = {}) {
  const t = tool({
    description: 'charge',
    inputSchema: z.object({ id: z.string() }),
    execute: async (_a: unknown, o: any) => { seen.body.push(o.idempotencyKey); throw new Error('gateway timeout'); },
  });
  Object.assign(t as object, opts, {
    recover: async (_a: unknown, o: { idempotencyKey: string }) => { seen.recover.push(o.idempotencyKey); return { done: true, output: { chargeId: 'ch-1' } }; },
    compensate: async () => ({ refunded: true }),
  });
  return t;
}

const toolRecords = async (journal: InMemoryJournal) =>
  (await journal.listKeys!('')).filter((k) => k.includes(':tool:') || k.startsWith('xreq:')).map((k) => k);

describe("a call's idempotency key is decided once", () => {
  for (const mode of ['call', 'args'] as const) {
    it(`${mode} mode: the record carries the key the body got, and compensateRun asks recover() with that key`, async () => {
      const journal = new InMemoryJournal();
      const seen = { body: [] as string[], recover: [] as string[] };
      const tools = { charge: charge(seen, mode === 'args' ? { idempotency: 'args' } : {}) };
      await runDurable({ runId: 'r1', journal, model: model(), tools, prompt: 'go', stopWhen: stepCountIs(4) }).catch(() => undefined);
      expect(seen.body).toHaveLength(1);
      const recs = await Promise.all((await toolRecords(journal)).map(async (k) => [k, await journal.get<any>(k)] as const));
      const authoritative = recs.filter(([, v]) => v && v.mirrorOf === undefined && v.status !== undefined);
      expect(authoritative.length, 'one authoritative record for the call').toBe(1);
      expect(authoritative[0]![1].idempotencyKey, 'the call record holds its key').toBe(seen.body[0]);
      await compensateRun('r1', { journal, tools });
      expect(seen.recover, 'compensateRun asked the provider about the key the body carried').toEqual([seen.body[0]]);
    });
  }
});
