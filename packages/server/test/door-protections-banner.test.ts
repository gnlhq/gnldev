// Every standalone door prints how it is protected when it is built, as @gnldev/server does — one
// function (@gnldev/auth doorProtectionLines, printed by doorGate) for all four — and prints it to
// standard ERROR (@gnldev/auth printProtections). Standard output is an MCP stdio server's JSON-RPC
// channel and a CLI's piped result: measured, the block on stdout gave a stdio MCP client 4 parse
// errors before `initialize`.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { doorProtectionLines } from '@gnldev/auth';
import { createChatRoute } from '../../chat-adapter/src/index.js';
import { createAguiRoute } from '../../agui/src/route.js';
import { createMcpServer } from '../../mcp/src/server.js';
import { createA2AServer } from '../../a2a/src/server.js';

let log: ReturnType<typeof vi.spyOn>;
let out: ReturnType<typeof vi.spyOn>;
let stdout: ReturnType<typeof vi.spyOn>;
afterEach(() => { log?.mockRestore(); out?.mockRestore(); stdout?.mockRestore(); });
const quiet = () => {
  log = vi.spyOn(console, 'error').mockImplementation(() => {});
  out = vi.spyOn(console, 'log').mockImplementation(() => {});
  stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
};
const printed = () => log.mock.calls.map((c) => String(c[0])).join('\n');
const base = () => ({ journal: new InMemoryJournal(), agents: {} });

describe('a standalone door prints its protections', () => {
  for (const [name, build] of [
    ['createChatRoute', (o: any) => createChatRoute(base() as any, o)],
    ['createAguiRoute', (o: any) => createAguiRoute(base() as any, o)],
    ['createMcpServer', (o: any) => createMcpServer({ journal: new InMemoryJournal(), tools: {}, ...o })],
    ['createA2AServer', (o: any) => createA2AServer(base() as any, o)],
  ] as const) {
    it(`${name}: printed once when built, naming the door — on stderr, nothing on stdout`, () => {
      quiet();
      (build as any)({});
      expect(printed()).toContain(`gnl ${name} — door protections`);
      expect(printed()).toContain('○ identity');
      expect(out).not.toHaveBeenCalled();
      expect(stdout).not.toHaveBeenCalled();
    });
    it(`${name}: protectionsBanner: false → silent`, () => {
      quiet();
      (build as any)({ protectionsBanner: false });
      expect(printed()).not.toContain('door protections');
    });
  }
});

describe('the block claims only checks that run', () => {
  it('createMcpServer says the host and cross-site rows are not checked without an HTTP request (stdio)', () => {
    quiet();
    createMcpServer({ journal: new InMemoryJournal(), tools: {} });
    expect(printed()).toMatch(/not checked .*no HTTP request \(stdio/);
  });
  it('an HTTP-only door carries no such row', () => {
    quiet();
    createChatRoute(base() as any, {});
    expect(printed()).not.toContain('not checked');
  });
  it('@gnldev/server prints its matrix to stderr too, nothing on stdout', async () => {
    const { createRestApi } = await import('../src/index.js');
    quiet();
    createRestApi(base() as any);
    expect(printed()).toContain('protections');
    expect(out).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
  });
});

describe('the rows say what the options do', () => {
  it('identify, an allow-list and no cross-site', () => {
    const lines = doorProtectionLines({ door: 'd', identify: () => undefined, allowedHosts: ['app.example.com'] }).join('\n');
    expect(lines).toContain('✓ identity');
    expect(lines).toContain('app.example.com');
    expect(lines).toContain('✓ cross-site');
  });
  it('any host and cross-site allowed are marked off', () => {
    const lines = doorProtectionLines({ door: 'd', allowedHosts: true, allowCrossSite: true }).join('\n');
    expect(lines).toContain('○ host rule');
    expect(lines).toContain('○ cross-site');
  });
});
