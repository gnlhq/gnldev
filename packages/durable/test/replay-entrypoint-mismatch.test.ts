// One model step, either path (design decision D5). A step journaled by the non-streaming path (a
// generate result, `content`) is read by the streaming path as the parts a provider streams for it, and a
// streamed step (`{ parts, rest }`) is read by the non-streaming path as the content it generated. Until
// D5 both directions threw "replay entry-point mismatch": a registry run executes on the stream path now,
// while a host that resumes it directly reads on the generate path — and runs born before that were
// journaled as generate results. Both directions replay the journaled answer with no model call.
import { describe, it, expect } from 'vitest';
import { stepCountIs } from 'ai';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable, streamDurable } from '../src/run.js';
import { createMockModel, createMockStreamAgent, finalTextResult } from './mock.js';

describe('E2 — a step journaled by one entry point replays through the other', () => {
  it('a run journaled via runDurable, continued via streamDurable, replays its answer — no model call', async () => {
    const journal = new InMemoryJournal();
    const r1 = await runDurable({
      runId: 'e2-g2s', journal, model: createMockModel(async () => finalTextResult('hello')),
      prompt: 'go', stopWhen: stepCountIs(3),
    });
    expect(r1.text).toContain('hello');

    const counter = { calls: 0 };
    const r2: any = await streamDurable({
      runId: 'e2-g2s', journal, model: createMockStreamAgent(counter),
      prompt: 'go', stopWhen: stepCountIs(3),
    });
    let streamed = '';
    for await (const part of r2.fullStream) {
      expect(part?.type).not.toBe('error');
      if (part?.type === 'text-delta') streamed += part.text ?? '';
    }
    expect(streamed).toContain('hello');
    expect(await r2.text).toContain('hello');
    expect(counter.calls, 'the stream path called the model instead of replaying').toBe(0);
  });

  it('a run journaled via streamDurable, continued via runDurable, replays its answer — no model call', async () => {
    const journal = new InMemoryJournal();
    const r1: any = await streamDurable({
      runId: 'e2-s2g', journal, model: createMockStreamAgent(),
      prompt: 'go', stopWhen: stepCountIs(3),
    });
    const first = await r1.text;
    let calls = 0;
    const r2 = await runDurable({
      runId: 'e2-s2g', journal, model: createMockModel(async () => { calls++; return finalTextResult('a second answer'); }),
      prompt: 'go', stopWhen: stepCountIs(3),
    });
    expect(r2.text).toBe(first);
    expect(calls, 'the generate path called the model instead of replaying').toBe(0);
  });
});
