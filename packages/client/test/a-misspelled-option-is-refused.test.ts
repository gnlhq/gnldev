// Every options object @gnldev/client reads refuses a name it does not take (@gnldev/options).
import { describe, it, expect } from 'vitest';
import { GnlClient, tokenFrom } from '../src/index.js';

describe('@gnldev/client: a misspelled option is refused', () => {
  it.each([
    ['GnlClient', () => new GnlClient({ baseURL: 'http://x' } as any), /GnlClient: `baseURL` .* did you mean `baseUrl`\?/],
    ['tokenFrom', () => tokenFrom('http://x/token', { fecth: fetch } as any), /tokenFrom: `fecth` .* did you mean `fetch`\?/],
  ])('%s', (_n, build, message) => {
    expect(build).toThrow(message);
  });
});

it('useChat refuses a misspelled option before it touches React', async () => {
  const { useChat } = await import('../src/react/index.js');
  expect(() => useChat({} as any, 'a', { threadID: 't' } as any)).toThrow(/useChat: `threadID` .* did you mean `threadId`\?/);
});
