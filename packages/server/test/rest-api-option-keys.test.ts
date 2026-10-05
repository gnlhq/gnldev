// The options createRestApi reads are listed once (REST_API_OPTION_KEYS), and one given in the config
// instead is refused by name rather than silently ignored — measured: `a2aSecret` in the config served
// every route unsigned.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createRestApi, REST_API_OPTION_KEYS, type RestApiOptions } from '../src/index.js';

type Listed = (typeof REST_API_OPTION_KEYS)[number];
// Compile-time pin: every option of the interface is listed, and nothing else is.
const everyOptionListed: [Exclude<keyof RestApiOptions, Listed>] extends [never] ? true : false = true;
const nothingElseListed: [Exclude<Listed, keyof RestApiOptions>] extends [never] ? true : false = true;

describe('an option given in the wrong argument', () => {
  it('the list matches the interface', () => { expect(everyOptionListed && nothingElseListed).toBe(true); });
  it('a2aSecret in the config → refused, naming it and where it goes', () => {
    expect(() => createRestApi({ journal: new InMemoryJournal(), agents: {}, a2aSecret: 's' } as any)).toThrow(/`a2aSecret`.*createRestApi\(config, \{ a2aSecret/s);
  });
  it('two at once are named together', () => {
    expect(() => createRestApi({ journal: new InMemoryJournal(), agents: {}, cors: {}, allowOpenAccess: true } as any)).toThrow(/`allowOpenAccess`, `cors`|`cors`.*`allowOpenAccess`/);
  });
  it('a dev config carrying title, auth and surfaces still works (gnl dev passes it whole)', () => {
    expect(() => createRestApi({ journal: new InMemoryJournal(), agents: {}, title: 't', auth: undefined, surfaces: [] } as any, { protectionsBanner: false })).not.toThrow();
  });
  it('the same option given in both places is the caller being explicit → accepted', () => {
    expect(() => createRestApi({ journal: new InMemoryJournal(), agents: {}, a2aSecret: 's' } as any, { a2aSecret: 's', protectionsBanner: false })).not.toThrow();
  });
});
