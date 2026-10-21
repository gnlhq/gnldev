// A package the library loads at run time but does not depend on — a database driver (`pg`, `mysql2`,
// `mongodb`, `libsql`) or `@gnldev/tool-schema`, all optional peers — goes through
// `requireOptionalPeer` / `importOptionalPeer`, never a literal `require('x')` or `import('x')`.
//
// Measured why (raporlar/2026-10-21-frameworks): a Next.js 16 App Router route that imported
// @gnldev/durable 0.13.0 and ran on memory failed `next build` — "Module not found: Can't resolve 'pg'"
// (twice) and "'@gnldev/tool-schema'" — because the bundler resolves every literal load it sees, and the
// app never installed those drivers. Through the helper the same app builds and runs with no config.
// This scan is what keeps a new literal load from bringing that back; it reads the source, so it holds
// for a load the bundler would meet in any package an app imports.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const packages = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// Command-line tools run on Node and are never bundled into an app.
const NOT_BUNDLED = new Set(['cli', 'create-gnl', 'deploy']);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? sources(p) : p.endsWith('.ts') && !p.endsWith('.d.ts') ? [p] : [];
  });
}
/** `@scope/name/sub` → `@scope/name`; `mysql2/promise` → `mysql2`. */
const packageOf = (spec: string) => spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/');

describe('an optional driver is loaded by Node, not by a bundler', () => {
  it('no library source loads a package it does not depend on with a literal require() or import()', () => {
    const found: string[] = [];
    for (const pkg of readdirSync(packages)) {
      if (NOT_BUNDLED.has(pkg)) continue;
      let manifest: { name?: string; dependencies?: Record<string, string> };
      try { manifest = JSON.parse(readFileSync(join(packages, pkg, 'package.json'), 'utf8')); } catch { continue; }
      const deps = new Set([manifest.name, ...Object.keys(manifest.dependencies ?? {})]);
      let files: string[];
      try { files = sources(join(packages, pkg, 'src')); } catch { continue; }
      for (const file of files) {
        const text = readFileSync(file, 'utf8');
        const loads = [
          ...text.matchAll(/createRequire\(import\.meta\.url\)\(\s*'([^']+)'/g),
          ...text.matchAll(/(?<!typeof\s)\bimport\(\s*'([^']+)'\s*\)/g),
        ];
        for (const m of loads) {
          const spec = m[1]!;
          if (spec.startsWith('.') || spec.startsWith('node:') || deps.has(packageOf(spec))) continue;
          found.push(`${file.slice(packages.length + 1)}: '${spec}'`);
        }
      }
    }
    expect(found, `load these through requireOptionalPeer / importOptionalPeer (@gnldev/durable):\n${found.join('\n')}`).toEqual([]);
  });

  it('the scan sees a literal load: it would have caught the one Next.js could not build', () => {
    const literal = "const { Client } = createRequire(import.meta.url)('pg');";
    expect([...literal.matchAll(/createRequire\(import\.meta\.url\)\(\s*'([^']+)'/g)].map((m) => m[1])).toEqual(['pg']);
    expect([..."await import('@gnldev/tool-schema')".matchAll(/(?<!typeof\s)\bimport\(\s*'([^']+)'\s*\)/g)].map((m) => m[1])).toEqual(['@gnldev/tool-schema']);
    expect([..."typeof import('ai').generateText".matchAll(/(?<!typeof\s)\bimport\(\s*'([^']+)'\s*\)/g)]).toEqual([]);
  });
});
