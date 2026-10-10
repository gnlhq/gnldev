// Upgrade from 0.9.0, @gnldev/processors: a run 0.9.0 made with `piiRedactor({ redactToolResults: true })`
// whose tool returned `{ email, createdAt: <epoch ms> }`. 0.9.0 journaled that object UNREDACTED (the
// JSON round trip failed on the 13-digit number), then the model call after it failed.
import { describe, expect, it } from 'vitest';
import { eraseSubject, runDurable, toJournal } from '@gnldev/durable';
import { piiRedactor } from '@gnldev/processors';
import * as S from '../../generate/shapes.mjs';
import { itMigrates, notes090, openFixture, rowsContaining } from '../support.js';

const resume = (journal: ReturnType<typeof toJournal>, executed: number[]) =>
  runDurable({
    runId: S.PII.runId,
    journal,
    resourceId: S.PII.resourceId,
    model: S.toolThenTextModel({ toolName: S.PII.toolName, input: { who: S.PII.resourceId } }) as any,
    tools: { [S.PII.toolName]: { description: 'lookup', execute: async () => { executed.push(1); return { ...S.PII.toolResult }; } } } as any,
    processors: [piiRedactor({ redactToolResults: true })],
    prompt: 'look the customer up',
  });

describe('upgrade from 0.9.0 — PII tool results in the journal', () => {
  itMigrates('pii.db');

  it('the fixture is what it claims: 0.9.0 journaled the tool result with the email in plain text', () => {
    expect(notes090.pii.executedOn090).toBe(1);
    expect(notes090.pii.keysHoldingPlainEmail).toEqual([`${S.PII.runId}:tool:call-1`]);
  });

  it('the unfinished 0.9.0 run finishes after the upgrade without calling the tool again', async () => {
    const { storage } = await openFixture('pii.db');
    const executed: number[] = [];
    const r = await resume(toJournal(storage.runs), executed);
    expect(r.text).toBe('done');
    expect(executed).toEqual([]);
  });

  it("erasing the run's owner leaves the email nowhere in the file", async () => {
    const f = await openFixture('pii.db');
    await eraseSubject(f.storage, S.PII.resourceId);
    expect(rowsContaining(f.path, S.PII.email)).toEqual([]);
  });

  it('erasing after the run was finished on the current code leaves the email nowhere either', async () => {
    const f = await openFixture('pii.db');
    await resume(toJournal(f.storage.runs), []);
    await eraseSubject(f.storage, S.PII.resourceId);
    expect(rowsContaining(f.path, S.PII.email)).toEqual([]);
  });
});
