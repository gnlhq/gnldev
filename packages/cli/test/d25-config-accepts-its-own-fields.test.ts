// d25 A13 (cli/KARAR-1, option B: the clause is bound to GnlDevConfig, its one owner). Copied from fix/d25-cli 1138abc6
// and strengthened: an end-users scaffold too, and a NEGATIVE case — a misspelled field (`limitz`, TS2561 "did you mean")
// and an unrelated unknown one (`qwxNotAField`, TS2353) must still be refused, so "accept everything" is not a way to pass.
//
// d25 (cli cluster, finding 1): every field `GnlDevConfig` declares is accepted by the `satisfies` clause of the
// gnl.config.ts the generator writes. Measured on 0.17.1 (U13 fixed src/app.ts reading `config.limits`): writing
// `limits: { maxCostUsd: 0.5 }` into the GENERATED gnl.config.ts still failed `tsc` with TS2353, because the clause
// was a hand-copied subset of GnlDevConfig (port, studio, subjects + per-recipe extensions) with no `limits`,
// `title`, `license*`. The clause and the declared type are one rule with two owners; it has one now.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { scaffold } from '../src/scaffold.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, '..', '..', '..');
let base: string;

function findInstalled(name: string): string | undefined {
  const roots = [join(REPO, 'node_modules'), ...readdirSync(join(REPO, 'packages')).map((p) => join(REPO, 'packages', p, 'node_modules'))];
  for (const r of roots) if (existsSync(join(r, name, 'package.json'))) return join(r, name);
  return undefined;
}

const FIELDS: Record<string, string> = {
  limits: '  limits: { maxCostUsd: 0.5, maxToolCalls: 10 },',
  title: "  title: 'my api',",
  license: "  license: 'key',",
  licenseStrict: '  licenseStrict: true,',
  licensePublicKey: "  licensePublicKey: 'k',",
  authAndSurfaces: "  auth: { admin: { token: 'x' } },\n  surfaces: [],",
};
// TypeScript reports only the FIRST unknown property of an object literal, so each negative case gets its own config.
const NEGATIVES: Record<string, string> = { limitz: '  limitz: { maxCostUsd: 0.5 },', qwxNotAField: '  qwxNotAField: 1,' };

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'gnl-config-fields-'));
  const nm = join(base, 'node_modules');
  mkdirSync(join(nm, '@gnldev'), { recursive: true });
  for (const p of readdirSync(join(REPO, 'packages'))) {
    const pj = join(REPO, 'packages', p, 'package.json');
    if (!existsSync(pj)) continue;
    const name = JSON.parse(readFileSync(pj, 'utf8')).name as string;
    if (name?.startsWith('@gnldev/')) symlinkSync(join(REPO, 'packages', p), join(nm, name), 'dir');
  }
  for (const dep of ['ai', 'zod', '@types/node', '@ai-sdk/provider', '@ai-sdk/openai', 'pg', '@types/pg']) {
    const at = findInstalled(dep);
    if (!at) continue;
    mkdirSync(dirname(join(nm, dep)), { recursive: true });
    symlinkSync(at, join(nm, dep), 'dir');
  }
  const variants = [['sqlite', 'internal'], ['pg', 'internal'], ['sqlite', 'end-users']] as const;
  for (const [label, line] of [...Object.entries(FIELDS), ...Object.entries(NEGATIVES).map(([f, l]) => [`typo_${f}`, l] as const)]) {
    for (const [store, identity] of variants) {
      const dir = join(base, label.startsWith('typo_') ? `typo-${label.slice(5)}-${store}-${identity}` : `${label}-${store}-${identity}`);
      scaffold(dir, { answers: { preset: 'assistant', identity, serving: 'dev', store } });
      const f = join(dir, 'gnl.config.ts');
      const text = readFileSync(f, 'utf8');
      expect(text).toContain('  port: 3000,');
      writeFileSync(f, text.replace('  port: 3000,', `${line}\n  port: 3000,`));
    }
  }
}, 120_000);
afterAll(() => { if (base) rmSync(base, { recursive: true, force: true }); });

describe('the generated gnl.config.ts accepts every field GnlDevConfig declares', () => {
  it('tsc --noEmit: zero errors for limits / title / license* / auth / surfaces, on sqlite and pg configs', async () => {
    const tpl = JSON.parse(readFileSync(join(REPO, 'packages', 'cli', 'templates', 'minimal', 'tsconfig.json'), 'utf8'));
    const roots = readdirSync(base).filter((d) => !d.startsWith('typo-') && existsSync(join(base, d, 'gnl.config.ts'))).map((d) => `${d}/gnl.config.ts`);
    expect(roots.length).toBe(Object.keys(FIELDS).length * 3);
    writeFileSync(join(base, 'tsconfig.json'), JSON.stringify({ compilerOptions: { ...tpl.compilerOptions, noEmit: true, types: ['node'] }, files: roots }));
    const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
    const child = spawn(process.execPath, [tsc, '-p', join(base, 'tsconfig.json'), '--pretty', 'false'], { cwd: base });
    let out = '';
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { out += b; });
    await new Promise((r) => child.on('close', r));
    expect(out.split('\n').filter((l) => /error TS\d+/.test(l))).toEqual([]);
  }, 300_000);
  it('negative: a misspelled field (limitz) and an unknown one (qwxNotAField) are still refused (TS2353 or TS2561) in every variant', async () => {
    const tpl = JSON.parse(readFileSync(join(REPO, 'packages', 'cli', 'templates', 'minimal', 'tsconfig.json'), 'utf8'));
    const roots = readdirSync(base).filter((d) => d.startsWith('typo-')).map((d) => `${d}/gnl.config.ts`);
    expect(roots.length).toBe(Object.keys(NEGATIVES).length * 3);
    writeFileSync(join(base, 'tsconfig.typo.json'), JSON.stringify({ compilerOptions: { ...tpl.compilerOptions, noEmit: true, types: ['node'] }, files: roots }));
    const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
    const child = spawn(process.execPath, [tsc, '-p', join(base, 'tsconfig.typo.json'), '--pretty', 'false'], { cwd: base });
    let out = '';
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { out += b; });
    await new Promise((r) => child.on('close', r));
    const errs = out.split('\n').filter((l) => /error TS\d+/.test(l));
    for (const r of roots) {
      const dir = r.split('/')[0]!;
      const field = Object.keys(NEGATIVES).find((f) => dir.startsWith(`typo-${f}-`))!;
      expect(errs.some((l) => l.startsWith(`${dir}/`) && /TS(2353|2561)/.test(l) && l.includes(`'${field}'`)), `${r} / ${field}: ${errs.join('\n')}`).toBe(true);
    }
  }, 300_000);
});
