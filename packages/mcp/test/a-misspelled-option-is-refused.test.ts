// Every options object @gnldev/mcp reads refuses a name it does not take (@gnldev/options), naming the
// option it is closest to: a misspelled `identify` on the server would serve every caller as nobody,
// and a misspelled `deny` on the firewall would let the tools it names through.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createMcpServer, serveMcp, mcpFirewall, createMcpTools, connectMcp, mcpTools } from '../src/index.js';

const client: any = { listTools: async () => ({ tools: [] }), callTool: async () => ({}) };

describe('@gnldev/mcp: a misspelled option is refused', () => {
  it.each([
    ['createMcpServer', () => createMcpServer({ tools: {}, journal: new InMemoryJournal(), identfy: () => undefined, protectionsBanner: false } as any), /createMcpServer: `identfy` .* did you mean `identify`\?/],
    ['createMcpServer identity (replaced)', () => createMcpServer({ tools: {}, journal: new InMemoryJournal(), identity: () => ({}), protectionsBanner: false } as any), /createMcpServer: `identity` was replaced by `identify` \(0\.7\.0\)/],
    ['createMcpServer rateLimit', () => createMcpServer({ tools: {}, journal: new InMemoryJournal(), rateLimit: { maxCalls: 3, window: 1000 }, protectionsBanner: false } as any), /createMcpServer: rateLimit: `window` .* did you mean `windowMs`\?/],
    ['serveMcp', () => serveMcp({} as any, {} as any, { versoin: '1' } as any), /serveMcp: `versoin` .* did you mean `version`\?/],
    ['mcpFirewall', () => mcpFirewall({ server: 's', journal: new InMemoryJournal(), tools: {}, denny: ['x'] } as any), /mcpFirewall: `denny` .* did you mean `deny`\?/],
    ['createMcpTools', () => createMcpTools(client, { prefx: 'a' } as any), /createMcpTools: `prefx` .* did you mean `prefix`\?/],
    ['connectMcp', () => connectMcp({}, { nme: 'a' } as any), /connectMcp: `nme` .* did you mean `name`\?/],
    ['mcpTools', () => mcpTools({ transport: {}, prefx: 'a' } as any), /mcpTools: `prefx` .* did you mean `prefix`\?/],
  ])('%s', async (_n, build, message) => {
    await expect((async () => build())()).rejects.toThrow(message);
  });
});
