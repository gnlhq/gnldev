// Every options object @gnldev/agui reads refuses a name it does not take (@gnldev/options).
import { describe, it, expect } from 'vitest';
import { InMemoryStorage } from '@gnldev/durable';
import { createAguiRoute, aguiSurface, pipeAguiStream, toAguiEvents } from '../src/index.js';

describe('@gnldev/agui: a misspelled option is refused', () => {
  it.each([
    ['createAguiRoute', () => createAguiRoute({ storage: new InMemoryStorage(), agents: {} } as any, { authorise: () => ({ allow: true }) } as any), /createAguiRoute: `authorise` .* did you mean `authorize`\?/],
    ['aguiSurface', () => aguiSurface({ pth: '/x' } as any), /aguiSurface: `pth` .* did you mean `path`\?/],
    ['pipeAguiStream', () => pipeAguiStream({} as any, 'r', {}, { threadID: 't' } as any), /pipeAguiStream: `threadID` .* did you mean `threadId`\?/],
    ['toAguiEvents', () => toAguiEvents({ event: 'finish', data: {} } as any, { threadId: 't', runID: 'r' } as any), /toAguiEvents: `runID` .* did you mean `runId`\?/],
  ])('%s', (_n, build, message) => {
    expect(build).toThrow(message);
  });
});
