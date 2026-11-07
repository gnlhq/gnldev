// Installs the published 0.16.0 packages outside the workspace, for the tests that run 0.16.0's own code
// beside this version's (GNL_016_ROOT): the queue's deploy window (packages/queue/test/k5-queue-upgrade.test.ts)
// and the real 0.16.0 worker. Same reason as load-0.9.0.mjs: never through the lockfile, so the old code
// cannot be linked to the current source.
//
//   node generate/load-0.16.0.mjs <dir>     # npm install of @gnldev/{durable,queue}@0.16.0 (+ pg) into <dir>
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

export const PACKAGES_016 = ['durable', 'queue'];

/** Every package under `root` is 0.16.0, or this throws naming the one that is not. */
export function assert016(root, names = PACKAGES_016) {
  for (const p of names) {
    const v = JSON.parse(readFileSync(join(root, 'node_modules', '@gnldev', p, 'package.json'), 'utf8')).version;
    if (v !== '0.16.0') throw new Error(`@gnldev/${p} under ${root} is ${v}, not 0.16.0`);
  }
}

/** `npm install`s the published 0.16.0 packages (and `pg`) into `dir`, or a new temp dir; returns it. */
export function install016(dir, extra = ['pg@^8']) {
  const target = dir ? resolve(dir) : mkdtempSync(join(tmpdir(), 'gnl-016-'));
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'package.json'), JSON.stringify({ name: 'gnl-016-install', private: true, type: 'module' }));
  const specs = [...PACKAGES_016.map((p) => `@gnldev/${p}@0.16.0`), ...extra];
  console.error(`installing ${specs.join(' ')} into ${target} …`);
  execSync(`npm install --no-audit --no-fund --loglevel=error ${specs.join(' ')}`, { cwd: target, stdio: 'inherit' });
  assert016(target);
  return target;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(install016(process.argv[2]));
}
