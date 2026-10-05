// A door's option written into its engine config (first argument) is refused by name — one function
// (@gnldev/auth refuseMisplacedOptions) for createRestApi and the three doors that take (config, opts).
// Measured before: `identify` in createChatRoute's config was never called, and the request ran
// anonymously with 200.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createChatRoute } from '../../chat-adapter/src/index.js';
import { createAguiRoute } from '../../agui/src/route.js';
import { createA2AServer } from '../../a2a/src/server.js';
import { createRestApi } from '../src/index.js';

const identify = () => ({ kind: 'subject', id: 'u1', roles: [] }) as any;
const cfg = (extra: Record<string, unknown> = {}) => ({ journal: new InMemoryJournal(), agents: {}, ...extra }) as any;

describe('a door option in the config argument', () => {
  for (const [name, build] of [
    ['createChatRoute', (c: any, o?: any) => createChatRoute(c, o)],
    ['createAguiRoute', (c: any, o?: any) => createAguiRoute(c, o)],
    ['createA2AServer', (c: any, o?: any) => createA2AServer(c, o)],
  ] as const) {
    it(`${name}: identify in the config → refused, naming it and where it goes`, () => {
      expect(() => (build as any)(cfg({ identify }))).toThrow(new RegExp(`\`identify\`.*${name}\\(config, \\{ identify`, 's'));
    });
    it(`${name}: identify where it belongs → built`, () => {
      expect(() => (build as any)(cfg(), { identify, protectionsBanner: false })).not.toThrow();
    });
  }
});

describe('createRestApi: auth in the config', () => {
  // `auth` was exempt here ("gnl dev passes the config whole"), and that exemption was the hole: a deny-all
  // provider written into the config was never read, and the API answered 200 with the agent's answer —
  // the same provider in the options answered 401. gnl dev and the scaffold pass auth second already.
  const denyAll = { authenticate: () => null, authorize: () => ({ allow: false }) };
  it('is refused, naming it and where it goes — not served open', () => {
    expect(() => createRestApi(cfg({ auth: denyAll }), { protectionsBanner: false } as any)).toThrow(/`auth` is an option of createRestApi.*createRestApi\(config, \{ auth/s);
  });
  it('where it belongs, it is built; title and surfaces stay accepted in the config', () => {
    expect(() => createRestApi(cfg(), { auth: denyAll, protectionsBanner: false } as any)).not.toThrow();
    expect(() => createRestApi(cfg({ title: 'x', surfaces: [] }), { allowOpenAccess: true, protectionsBanner: false } as any)).not.toThrow();
  });
});
