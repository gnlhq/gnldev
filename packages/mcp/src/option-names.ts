// The names of every options object @gnldev/mcp reads, each held to its parameter's type by the
// compiler (@gnldev/options `optionNames`): an option added to a type and not here fails typecheck. A
// name not listed is refused where the bag is read, naming the option it is closest to.
import { optionNames } from '@gnldev/options';

export const CREATE_MCP_TOOLS_OPTS_NAMES = optionNames<NonNullable<Parameters<typeof import('./index.js').createMcpTools>[1]>>()(['prefix', 'idempotencyKey']);
export const CONNECT_MCP_INFO_NAMES = optionNames<NonNullable<Parameters<typeof import('./index.js').connectMcp>[1]>>()(['name', 'version']);
export const MCP_TOOLS_NAMES = optionNames<NonNullable<Parameters<typeof import('./index.js').mcpTools>[0]>>()(['transport', 'prefix', 'info', 'idempotencyKey']);
export const CREATE_MCP_SERVER_NAMES = optionNames<NonNullable<Parameters<typeof import('./server.js').createMcpServer>[0]>>()(['tools', 'journal', 'identify', 'workKey', 'allowTool', 'rateLimit', 'workScope', 'allowedHosts', 'allowCrossSite', 'protectionsBanner']);
export const SERVE_MCP_INFO_NAMES = optionNames<NonNullable<Parameters<typeof import('./server.js').serveMcp>[2]>>()(['name', 'version']);
export const MCP_FIREWALL_NAMES = optionNames<NonNullable<Parameters<typeof import('./firewall.js').mcpFirewall>[0]>>()(['server', 'journal', 'tools', 'allow', 'deny', 'maxCallsPerRun']);
export const RATE_LIMIT_NAMES = optionNames<Exclude<NonNullable<import('./server.js').McpServerOptions['rateLimit']>, (...args: never[]) => unknown>>()(['maxCalls', 'windowMs']);
/**
 * A replaced option, refused with its replacement: a JavaScript config that still passes it would
 * otherwise run every call as `unknown` and hide every tool, with nothing saying why.
 */
export const REMOVED_MCP_SERVER_NAMES = {
  identity: "was replaced by `identify` (0.7.0): it takes the request and returns a Principal from @gnldev/auth — `identify: (req) => auth.authenticate(req)`, or `{ kind: 'subject', id, orgId, roles: [] }` for an end user.",
} as const;
