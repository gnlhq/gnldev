// Streaming the same run again — the continuation after an approval — replays its finished part before
// anything new. Measured on a real ward round: 6 tool calls and 5 results reached the caller twice, and
// a chat UI listed the doses as given again. The two passes below are the shapes measured there: they
// agree up to the suspended call and diverge at its result (`step-finish` in the first pass, the
// approved `tool-result` in the second), so ids cannot tell old from new; identities can.
import { describe, it, expect } from 'vitest';
import { GnlClient } from '../src/index.js';

const sse = (events: [string, object][]) =>
  events.map(([event, data], id) => `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');

const FIRST: [string, object][] = [
  ['step-start', {}],
  ['tool-call', { toolCallId: 'p0', toolName: 'agent_medic', input: {} }],
  ['step-finish', {}],
  ['interrupt', { interrupts: [{ toolCallId: 'p0/call_0', toolName: 'giveControlledDose' }] }],
  ['done', { runId: 'r1' }],
];
const SECOND: [string, object][] = [
  ['step-start', {}],
  ['tool-call', { toolCallId: 'p0', toolName: 'agent_medic', input: {} }],
  ['tool-result', { toolCallId: 'p0', toolName: 'agent_medic', output: { status: 'completed' } }],
  ['step-finish', {}],
  ['step-start', {}],
  ['text-delta', { text: 'Tur tamamlandı.' }],
  ['step-finish', {}],
  ['done', { runId: 'r1' }],
];

function clientServing(...passes: [string, object][][]) {
  let i = 0;
  const fetch = (async () => new Response(sse(passes[i++]!), { headers: { 'content-type': 'text/event-stream' } })) as typeof globalThis.fetch;
  return new GnlClient({ baseUrl: 'http://x', fetch });
}
const collect = async (it: AsyncIterable<{ event: string; data: any }>) => { const out: string[] = []; for await (const e of it) out.push(`${e.event}${e.data?.toolCallId ? `:${e.data.toolCallId}` : ''}`); return out; };

describe('a run is seen once', () => {
  it('the continuation after an approval brings only what is new — the approved result included', async () => {
    const client = clientServing(FIRST, SECOND);
    expect(await collect(client.stream('ward', { runId: 'r1', prompt: 'go' }))).toEqual(['step-start', 'tool-call:p0', 'step-finish', 'interrupt', 'done']);
    expect(await collect(client.stream('ward', { runId: 'r1', prompt: 'go', approvals: { 'p0/call_0': true } }))).toEqual(
      ['tool-result:p0', 'step-start', 'text-delta', 'step-finish', 'done'],
    );
  });

  it('a run that finished is forgotten: the next stream of that id is delivered whole', async () => {
    const done: [string, object][] = [['step-start', {}], ['text-delta', { text: 'hi' }], ['step-finish', {}], ['done', { runId: 'r2' }]];
    const client = clientServing(done, done);
    await collect(client.stream('a', { runId: 'r2', prompt: 'x' }));
    expect(await collect(client.stream('a', { runId: 'r2', prompt: 'x' }))).toEqual(['step-start', 'text-delta', 'step-finish', 'done']);
  });

  it('another run is not affected', async () => {
    const client = clientServing(FIRST, FIRST);
    await collect(client.stream('ward', { runId: 'r1', prompt: 'go' }));
    expect(await collect(client.stream('ward', { runId: 'r9', prompt: 'go' }))).toEqual(['step-start', 'tool-call:p0', 'step-finish', 'interrupt', 'done']);
  });
});
