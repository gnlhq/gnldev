// Every `--serving` answer writes a project that TYPECHECKS — dev, own and mount, and for the two that write a
// server, every host.
//
// Measured on 0.17.0: `gnl init --serving own --host hono` wrote src/app.ts reading `config.limits`, a name the
// declared `CreateGnlConfig` does not have (it is the project file's own), so the project's first `tsc` failed with
// TS2339 on a file the generator wrote. The default scaffold (serving dev) writes no src/app.ts and compiled, and
// init-config-compiles.test.ts only ever scaffolded that one. The files of the hosts' frameworks (express,
// fastify, koa, nest) are not installed in this workspace: their own "cannot find module" is not the claim here
// and is the only error class set aside; every other error in every file counts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { scaffold } from '../src/scaffold.js';
import { HOST_IDS } from '../src/hosts.js';
import type { InitAnswers } from '../src/init-answers.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, '..', '..', '..');
const OTHER: Pick<InitAnswers, 'preset' | 'identity' | 'store'> = { preset: 'critical', identity: 'end-users', store: 'pg' };
const DEFAULTS: Pick<InitAnswers, 'preset' | 'identity' | 'store'> = { preset: 'assistant', identity: 'internal', store: 'sqlite' };

interface Case { label: string; answers: InitAnswers; host?: string; mode?: 'own' | 'mount' }
const CASES: Case[] = [
  { label: 'serving dev', answers: { ...DEFAULTS, serving: 'dev' } },
  { label: 'serving dev (critical, end-users, pg)', answers: { ...OTHER, serving: 'dev' } },
  ...HOST_IDS.flatMap((h): Case[] => [
    { label: `serving own, host ${h}`, answers: { ...DEFAULTS, serving: 'own' }, host: h, mode: 'own' },
    { label: `serving own, host ${h} (critical, end-users, pg)`, answers: { ...OTHER, serving: 'own' }, host: h, mode: 'own' },
    { label: `serving mount, host ${h}`, answers: { ...DEFAULTS, serving: 'mount' }, host: h, mode: 'mount' },
  ]),
];

function findInstalled(name: string): string | undefined {
  const roots = [join(REPO, 'node_modules'), ...readdirSync(join(REPO, 'packages')).map((p) => join(REPO, 'packages', p, 'node_modules'))];
  for (const r of roots) if (existsSync(join(r, name, 'package.json'))) return join(r, name);
  return undefined;
}

let base: string;
const dirs = new Map<string, string>();

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'gnl-serving-compiles-'));
  const nm = join(base, 'node_modules');
  mkdirSync(join(nm, '@gnldev'), { recursive: true });
  for (const p of readdirSync(join(REPO, 'packages'))) {
    const pj = join(REPO, 'packages', p, 'package.json');
    if (!existsSync(pj)) continue;
    const name = JSON.parse(readFileSync(pj, 'utf8')).name as string;
    if (name?.startsWith('@gnldev/')) symlinkSync(join(REPO, 'packages', p), join(nm, name), 'dir');
  }
  for (const dep of ['ai', 'zod', '@types/node', 'hono', '@hono/node-server', '@ai-sdk/provider', '@ai-sdk/openai', '@ai-sdk/anthropic', '@ai-sdk/openai-compatible', 'pg', '@types/pg']) {
    const at = findInstalled(dep);
    if (!at) continue;
    mkdirSync(dirname(join(nm, dep)), { recursive: true });
    symlinkSync(at, join(nm, dep), 'dir');
  }
  CASES.forEach((c, i) => {
    const dir = join(base, `p${i}`);
    scaffold(dir, { answers: c.answers, ...(c.host ? { host: c.host, hostMode: c.mode } : {}) });
    dirs.set(c.label, dir);
  });
}, 120_000);

afterAll(() => { if (base) rmSync(base, { recursive: true, force: true }); });

function projectFiles(dir: string): string[] {
  const out = [join(dir, 'gnl.config.ts')];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) out.push(p);
    }
  };
  if (existsSync(join(dir, 'src'))) walk(join(dir, 'src'));
  return out;
}

describe('every --serving answer scaffolds a project that typechecks', () => {
  it('the cases include a server file for every host in own mode (the claim is not vacuous)', () => {
    for (const h of HOST_IDS) expect(existsSync(join(dirs.get(`serving own, host ${h}`)!, 'src', 'server.ts')), h).toBe(true);
    expect(existsSync(join(dirs.get('serving own, host hono')!, 'src', 'app.ts'))).toBe(true);
    expect(existsSync(join(dirs.get('serving dev')!, 'src', 'app.ts'))).toBe(false);
  });

  it('tsc --noEmit over all of them, the template\'s compiler options, zero errors', async () => {
    const tpl = JSON.parse(readFileSync(join(REPO, 'packages', 'cli', 'templates', 'minimal', 'tsconfig.json'), 'utf8'));
    const roots = [...dirs.values()].flatMap(projectFiles);
    const tsconfig = join(base, 'tsconfig.json');
    writeFileSync(tsconfig, JSON.stringify({ compilerOptions: { ...tpl.compilerOptions, noEmit: true, types: ['node'] }, files: roots.map((r) => relative(base, r)) }));
    const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
    const child = spawn(process.execPath, [tsc, '-p', tsconfig, '--pretty', 'false'], { cwd: base });
    let out = '';
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { out += b; });
    await new Promise((r) => child.on('close', r));
    const labelOf = (file: string) => [...dirs].find(([, d]) => resolve(base, file).startsWith(d + '/'))?.[0] ?? '?';
    const errors = out.split('\n')
      .filter((l) => /error TS\d+/.test(l))
      // a host's own framework (express, fastify, koa, nest) is not installed in this workspace
      .filter((l) => !/error TS(2307|7016):/.test(l))
      .map((l) => `[${labelOf(l.split('(')[0]!)}] ${l}`);
    expect(errors).toEqual([]);
  }, 300_000);
});
