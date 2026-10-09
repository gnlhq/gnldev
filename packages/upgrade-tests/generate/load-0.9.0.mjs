// Finds and loads the 0.9.0 packages for the generator and the mixed-version tests. GNL_090_ROOT is a
// built checkout of the 0.9.0 tag (`<root>/packages/<name>/dist`) or a directory where the published
// packages are installed (`<root>/node_modules/@gnldev/<name>/dist`). Never resolved through the
// workspace: with `link-workspace-packages=true` and the workspace at 0.9.0, pnpm links even an
// `npm:@gnldev/durable@0.9.0` alias to the CURRENT source (measured), so the old code has to come from
// outside the lockfile.
//
//   node generate/load-0.9.0.mjs <dir>     # installs the published 0.9.0 packages into <dir> (npm, ~8 s, ~31 MB)
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';

export const PACKAGES_090 = ['durable', 'queue', 'events', 'workflow', 'scheduler', 'memory', 'rag', 'evals', 'processors'];

export function packageDir090(root, name) {
  for (const d of [join(root, 'node_modules', '@gnldev', name), join(root, 'packages', name)]) if (existsSync(join(d, 'package.json'))) return d;
  throw new Error(`@gnldev/${name} not found under ${root} (looked in node_modules/@gnldev and packages/)`);
}

/** Every package under `root` is 0.9.0, or this throws naming the one that is not. */
export function assert090(root, names = PACKAGES_090) {
  for (const p of names) {
    const v = JSON.parse(readFileSync(join(packageDir090(root, p), 'package.json'), 'utf8')).version;
    if (v !== '0.9.0') throw new Error(`@gnldev/${p} at ${packageDir090(root, p)} is ${v}, not 0.9.0`);
  }
}

export function loader090(rootDir) {
  const root = resolve(rootDir);
  return (name, file = 'index.js') => import(pathToFileURL(join(packageDir090(root, name), 'dist', file)).href);
}

/** `npm install`s the published 0.9.0 packages (and the peers they need) into `dir`, or a new temp dir; returns it. */
export function install090(dir) {
  const target = dir ? resolve(dir) : mkdtempSync(join(tmpdir(), 'gnl-090-'));
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'package.json'), JSON.stringify({ name: 'gnl-090-install', private: true, type: 'module' }));
  const specs = [...PACKAGES_090.map((p) => `@gnldev/${p}@0.9.0`), 'ai@^7', 'zod@^3.25.76', 'pg@^8'];
  console.error(`installing ${specs.join(' ')} into ${target} …`);
  execSync(`npm install --no-audit --no-fund --loglevel=error ${specs.join(' ')}`, { cwd: target, stdio: 'inherit' });
  assert090(target);
  return target;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(install090(process.argv[2]));
}
