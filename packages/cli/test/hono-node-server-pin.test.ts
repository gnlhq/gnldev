// `npm i -D @gnldev/cli` after an UNPINNED `@hono/node-server` fails with ERESOLVE: the CLI (and server and
// Studio) are built against the 1.x line and ask for it (`^1.13.0` peer, `^1.19.17` dep), while the registry's
// latest is 2.x. Measured with the packed CLI in a clean npm project: `npm i @hono/node-server hono` then
// `npm i -D @gnldev/cli` → ERESOLVE; the same with `@hono/node-server@1` → installs. So every place that tells
// a reader to install it pins the major, and the scaffold's own package.json does too.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (p: string) => readFileSync(join(REPO, p), 'utf8');

describe('@hono/node-server is pinned to the 1.x line wherever a reader is told to install it', () => {
  it('the scaffold template depends on ^1', () => {
    expect(JSON.parse(read('packages/cli/templates/minimal/package.json')).dependencies['@hono/node-server']).toMatch(/^\^1\./);
  });
  it.each([
    'README.md', 'README.tr.md', 'docs/GUIDE.md', 'docs/GUIDE.tr.md',
    'packages/server/README.md', 'packages/studio/README.md', 'packages/agui/README.md',
  ])('%s says to install @hono/node-server@1', (file) => {
    expect(read(file)).toContain('@hono/node-server@1');
  });
});
