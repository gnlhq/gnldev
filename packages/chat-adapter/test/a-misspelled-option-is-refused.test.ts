// Every options object @gnldev/chat-adapter reads refuses a name it does not take (@gnldev/options).
// `toUIMessageStream` passes its options on to the AI SDK: a misspelling of a known name is refused, a
// name close to none (a newer AI SDK's) passes. A prebuilt `{ gnl }` config takes nothing beside it.
import { describe, it, expect } from 'vitest';
import { createGnl, InMemoryStorage } from '@gnldev/durable';
import { createChatRoute, chatSurface, approve, toUIMessages, toUIMessageStream, toUIMessageStreamResponse } from '../src/index.js';

const result: any = { toUIMessageStream: () => new ReadableStream({ start(c) { c.close(); } }) };

describe('@gnldev/chat-adapter: a misspelled option is refused', () => {
  it.each([
    ['createChatRoute', () => createChatRoute({ storage: new InMemoryStorage(), agents: {} } as any, { authorise: () => ({ allow: true }) } as any), /createChatRoute: `authorise` .* did you mean `authorize`\?/],
    ['createChatRoute { gnl }', () => createChatRoute({ gnl: createGnl({ storage: new InMemoryStorage() }), agents: {} } as any), /createChatRoute: config: `agents` is not an option/],
    ['chatSurface', () => chatSurface({ pth: '/x' } as any), /chatSurface: `pth` .* did you mean `path`\?/],
    ['approve', () => approve('http://x', { interrupt: {} as any, messages: [], chatID: 'c' } as any), /approve: `chatID` .* did you mean `chatId`\?/],
    ['toUIMessages', () => toUIMessages([], { runID: 'r' } as any), /toUIMessages: `runID` .* did you mean `runId`\?/],
    ['toUIMessageStream', () => toUIMessageStream(result, { sendReasonning: true } as any), /toUIMessageStream: `sendReasonning` .* did you mean `sendReasoning`\?/],
    ['toUIMessageStreamResponse', () => toUIMessageStreamResponse(result, { statusTxt: 'x' } as any), /toUIMessageStreamResponse: `statusTxt` .* did you mean `statusText`\?/],
  ])('%s', async (_n, build, message) => {
    await expect((async () => build())()).rejects.toThrow(message);
  });

  it('passes a name close to none on to the AI SDK', () => {
    expect(() => toUIMessageStream(result, { experimental_newThing: true } as any)).not.toThrow();
  });

  // ai@7.0.132 added `onStepEnd` and `onStepFinish` to the UI stream options. They reach the AI SDK
  // from both wrappers, on any ai 7.x: an older SDK ignores them, a newer one calls them.
  it.each(['toUIMessageStream', 'toUIMessageStreamResponse'] as const)('%s hands onStepEnd and onStepFinish to the AI SDK', (fn) => {
    let seen: Record<string, unknown> | undefined;
    const capturing: any = { toUIMessageStream: (o: Record<string, unknown>) => { seen = o; return new ReadableStream({ start(c) { c.close(); } }); } };
    const onStepEnd = () => {};
    const onStepFinish = () => {};
    const opts = { onStepEnd, onStepFinish, runId: 'r1' } as any;
    if (fn === 'toUIMessageStream') toUIMessageStream(capturing, opts);
    else toUIMessageStreamResponse(capturing, opts);
    expect(seen?.onStepEnd).toBe(onStepEnd);
    expect(seen?.onStepFinish).toBe(onStepFinish);
    expect(seen && 'runId' in seen).toBe(false);
  });
});
