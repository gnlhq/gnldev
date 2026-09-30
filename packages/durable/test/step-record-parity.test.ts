// ONE step-record format, two copies: @gnldev/workflow writes it (and stays dependency-free, so it keeps
// its own encoder), @gnldev/durable reads it for every reader outside the engine (the registry's run
// result, Studio's run views and playground). This pins the pair: whatever the workflow engine stores
// for an output, `decodeStepRecord` gives back that output — including the values that look like the
// record's own shapes, which the first cut of the void brand read back as `undefined`.
import { describe, it, expect } from 'vitest';
import { workflow, step, isVoidStepRecord } from '@gnldev/workflow';
import { InMemoryStorage } from '../src/in-memory-storage.js';
import { toJournal } from '../src/storage.js';
import { createGnl } from '../src/registry.js';
import { encodeStepRecord, decodeStepRecord } from '../src/index.js';

const OUTPUTS: Array<[string, unknown]> = [
  ['undefined', undefined],
  ['null', null],
  ['0', 0],
  ['a string', 'ok'],
  ['an array', [1, { a: 2 }]],
  ['a plain object', { charged: 10 }],
  ['the first-cut void brand', { __gnlVoid: true }],
  ['the void record', { __gnlStepRecord: 'void' }],
  ['the escape wrapper', { __gnlStepRecord: 'value', value: 1 }],
  ['a wrapper around a void record', { __gnlStepRecord: 'value', value: { __gnlStepRecord: 'void' } }],
  ['the key with other fields', { __gnlStepRecord: 'void', other: 1 }],
];

describe('the workflow writer and the durable reader agree on every output', () => {
  it.each(OUTPUTS)('%s: what the engine stored decodes to what the step returned', async (_n, value) => {
    const journal = toJournal(new InMemoryStorage().runs);
    await workflow<number>().then(step('s', async () => value)).run(1, { runId: 'p', journal });
    const stored = await journal.get('p:wf:s');
    expect(decodeStepRecord(stored)).toEqual(value);
    // …and the durable copy of the encoder writes the same record the engine did.
    expect(encodeStepRecord(value)).toEqual(stored);
  });

  it('only the void record is a void record', () => {
    for (const [, value] of OUTPUTS) expect(isVoidStepRecord(encodeStepRecord(value))).toBe(value === undefined);
  });

  it('a record 0.9.0 wrote (a plain value) decodes as itself', () => {
    expect(decodeStepRecord({ __gnlVoid: true })).toEqual({ __gnlVoid: true });
    expect(decodeStepRecord({ charged: 10 })).toEqual({ charged: 10 });
  });
});

describe('the registry reports what each step returned', () => {
  it('runWorkflow().steps: a step returning { __gnlVoid: true } is reported as that object, a void step as undefined', async () => {
    const wf = workflow<number>()
      .then(step('flag', async () => ({ __gnlVoid: true })))
      .then(step('notify', async () => undefined))
      .then(step('wrapped', async () => ({ __gnlStepRecord: 'void' })));
    const gnl = createGnl({ journal: toJournal(new InMemoryStorage().runs), workflows: { w: wf as any } });
    const r = await gnl.runWorkflow('w', 1, { runId: 'reg-2' });
    expect(r.steps.map((s) => [s.id, s.output])).toEqual([
      ['flag', { __gnlVoid: true }],
      ['notify', undefined],
      ['wrapped', { __gnlStepRecord: 'void' }],
    ]);
  });
});
