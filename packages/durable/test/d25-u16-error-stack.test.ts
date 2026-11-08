// d25 U16 — an error thrown inside the agent's own model/tool reaches `gnl.run()`'s caller rebuilt from the event record
// (errorOf); its stack points into gnl's event-codec, not at the line that threw.
// Red = claim holds.
import { describe, it, expect, vi } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import { createGnl } from '../src/registry.js';
import { createMockModel } from './mock.js';
import { errorData, errorOf } from '../src/event-codec.js';

function userModelThatBreaks() {
  return createMockModel(async ({ prompt }: any) => {
    const text: string = (undefined as any).split(' ');           // <-- THE USER'S BUG (this file, this line)
    return { content: [{ type: 'text', text }], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 }, warnings: [] };
  });
}
describe('U16 error provenance', () => {
  it('a throw in the model: the caller sees the original frame', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const gnl = createGnl({ journal: new InMemoryJournal(), agents: { a: { model: userModelThatBreaks() } } } as any);
    let err: any;
    try { await gnl.run('a', { runId: 'u16', prompt: 'x' }); } catch (e) { err = e; }
    const frames = String(err?.stack).split('\n').slice(0, 4).map((l: string) => l.trim());
    console.log('message:', err?.message, '\nstack head:\n  ' + frames.join('\n  '));
    expect(String(err?.stack)).toMatch(/d25-u16-error-stack\.test\.ts/);   // red => the user's frame is gone
    expect(String(err?.stack).split('\n').slice(0, 3).join('\n')).not.toMatch(/event-codec/);
  });
  it('the kept stack is bounded and never carries a header or a body', () => {
    const e: any = new Error('x'); e.stack = ['Error: x', ...Array.from({ length: 80 }, (_, i) => `    at frame${i} (/srv/app/file${i}.ts:1:1)`)].join('\n');
    const d = errorData(e);
    expect(d.stack!.split('\n').length).toBeLessThanOrEqual(13);
    expect(errorOf(d).stack).toBe(d.stack);
    expect(JSON.stringify(errorData(Object.assign(new Error('y'), { statusCode: 500, responseHeaders: { authorization: 'Bearer zzzzzzzz' }, responseBody: 'nope' })))).not.toContain('zzzzzzzz');
  });
});
