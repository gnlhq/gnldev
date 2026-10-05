// Every options object @gnldev/a2a reads refuses a name it does not take (@gnldev/options). Measured
// before: `createA2ATool({ secrte })` built a tool that sent every request unsigned.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage } from '@gnldev/durable';
import { createA2ATool } from '../src/index.js';
import { createA2AServer } from '../src/server.js';

describe('@gnldev/a2a: a misspelled option is refused', () => {
  it.each([
    ['createA2ATool', () => createA2ATool({ endpoint: 'http://x', agentName: 'a', secrte: 's'.repeat(32) } as any), /createA2ATool: `secrte` .* did you mean `secret`\?/],
    ['createA2AServer', () => createA2AServer({ storage: new InMemoryStorage(), agents: {} } as any, { authorise: () => ({ allow: true }) } as any), /createA2AServer: `authorise` .* did you mean `authorize`\?/],
  ])('%s', (_n, build, message) => {
    expect(build).toThrow(message);
  });
});
