// Every options object @gnldev/studio reads refuses a name it does not take (@gnldev/options), in its
// options and in each bag inside them. Measured in this package's own tests before: nine calls passed a
// `journal` Studio never reads (it reads `reader`) — dropped silently.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createStudioApi, createStudioApp, createStudioAdmin } from '../src/server.js';
import { basicAuth } from '../src/auth.js';
import { createStudioRunner } from '../src/runner.js';

const reader = new InMemoryJournal() as any;

describe('@gnldev/studio: a misspelled option is refused', () => {
  it.each([
    ['createStudioApi', () => createStudioApi({ reader, journal: reader } as any), /createStudioApi: `journal` is not an option/],
    ['createStudioApi auth', () => createStudioApi({ reader, auht: {} } as any), /createStudioApi: `auht` .* did you mean `auth`\?/],
    ['createStudioApp', () => createStudioApp({ reader, apibase: '/s' } as any), /createStudioApp: `apibase` .* did you mean `apiBase`\?/],
    ['createStudioApp retention', () => createStudioApp({ reader, retention: { olderThan: 1 } } as any), /createStudioApp: retention: `olderThan` .* did you mean `olderThanMs`\?/],
    ['createStudioApi budgets', () => createStudioApi({ reader, budgets: { default: { usdLimt: 1 } } } as any), /createStudioApi: budgets\.default: `usdLimt` .* did you mean `usdLimit`\?/],
    ['createStudioApi evalGate', () => createStudioApi({ reader, evalGate: { datasetID: 'd', minAvg: 1 } } as any), /createStudioApi: evalGate: `datasetID` .* did you mean `datasetId`\?/],
    ['createStudioAdmin', () => createStudioAdmin({ apibase: '/s' } as any), /createStudioAdmin: `apibase` .* did you mean `apiBase`\?/],
    ['basicAuth', () => basicAuth({ user: 'u', password: 'p' } as any), /basicAuth: `password` is not an option/],
    ['createStudioRunner', () => createStudioRunner({} as any, { agents: {}, workflow: {} } as any), /createStudioRunner: `workflow` .* did you mean `workflows`\?/],
  ])('%s', (_n, build, message) => {
    expect(build).toThrow(message);
  });

  it('a bare reader is a reader, not options', () => {
    expect(() => createStudioApi(reader)).not.toThrow();
  });
});
