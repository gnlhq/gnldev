// `gnl init --features <any recipe or pair of recipes>` writes a gnl.config.ts that PARSES and TYPECHECKS.
//
// Measured on 0.9.0: `gnl init <dir> --features otel|cache|schedule|job --yes` wrote a lone `  ,` line
// into the config object, so the project's first `pnpm dev` failed on a syntax error. Those four recipes
// have nothing to wire into the config (a worker, a poller, a file the app imports), and said so with
// `wiring: { import: '', place: 'configField', code: '' }` — which generateConfig turned into a field line
// holding only the comma. The repo's tests read the generated config as a string and never parsed it.
//
// This test is TABLE-DRIVEN over RECIPES, so a recipe added later is covered without anyone editing it:
// every code feature alone, every pair, each one under the other set of init answers, and all of them
// together. Every config is parsed; the bare and the all-together projects are also typechecked by one
// `tsc --noEmit` (the template's own compiler options) against the workspace's built packages — the check
// a freshly installed project would make.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, setPriority } from 'node:os';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { scaffold, generateConfig } from '../src/scaffold.js';
import { FEATURE_IDS, E2E_FEATURE, RECIPES } from '../src/recipes.js';
import type { InitAnswers } from '../src/init-answers.js';
import { captureLog } from './helpers.js';

const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript');
const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, '..', '..', '..');

const CODE_FEATURES = FEATURE_IDS.filter((f) => f !== E2E_FEATURE);
const PAIRS: string[][] = CODE_FEATURES.flatMap((a, i) => CODE_FEATURES.slice(i + 1).map((b) => [a, b]));
const OTHER_ANSWERS: InitAnswers = { preset: 'critical', identity: 'end-users', store: 'pg', serving: 'dev' };

interface Case { label: string; features: string[]; answers?: InitAnswers; typecheck: boolean }
// Every case is parsed AND typechecked — every single recipe, every pair, each one under the other
// answer set, all together — in ONE `tsc` program (a child process at the lowest CPU priority, see
// below). Measured on this machine: ~460 files for the pairs, 5–10s of tsc wall time under a load of
// 20+. It used to typecheck only the bare project and all-together, arguing "a single or a pair is a
// subset of those lines" — true of the scaffold path, and exactly what let a second caller of
// generateConfig (`gnl init` in an existing project) write a config that did not parse.
const CASES: Case[] = [
  { label: 'no recipe', features: [], typecheck: true },
  { label: 'no recipe (critical, end-users, pg)', features: [], answers: OTHER_ANSWERS, typecheck: true },
  ...CODE_FEATURES.map((f) => ({ label: f, features: [f], typecheck: true })),
  ...PAIRS.map((p) => ({ label: p.join('+'), features: p, typecheck: true })),
  ...CODE_FEATURES.map((f) => ({ label: `${f} (critical, end-users, pg)`, features: [f], answers: OTHER_ANSWERS, typecheck: true })),
  { label: 'all recipes', features: [...CODE_FEATURES], typecheck: true },
  { label: 'all recipes (critical, end-users, pg)', features: [...CODE_FEATURES], answers: OTHER_ANSWERS, typecheck: true },
];

// The OTHER callers of generateConfig, in the same program. `gnl init` in an existing project builds
// its own recipe list and passes it unfiltered; `generateConfig` and `RECIPES` are public exports, so
// any recipe set — every entry at once (model recipes included), a recipe listed twice, any order —
// is a config somebody can write. Each is checked inside a project that has every recipe's file.
const INTEGRATE: string[][] = [['idempotency-tool'], ['idempotency-tool', 'rag'], ['otel', 'job', 'cache', 'schedule'], [...CODE_FEATURES]];
const GENERATED: Array<[string, () => string]> = [
  ['generateConfig(every RECIPES entry)', () => generateConfig(Object.values(RECIPES))],
  ['generateConfig(every RECIPES entry, reversed, critical/end-users/pg)', () => generateConfig(Object.values(RECIPES).reverse(), OTHER_ANSWERS)],
  ['generateConfig(each recipe twice)', () => generateConfig([...Object.values(RECIPES), ...Object.values(RECIPES)])],
];

/** Resolve a third-party package from wherever the workspace installed it. */
function findInstalled(name: string): string | undefined {
  const roots = [join(REPO, 'node_modules'), ...readdirSync(join(REPO, 'packages')).map((p) => join(REPO, 'packages', p, 'node_modules'))];
  for (const r of roots) {
    const p = join(r, name);
    if (existsSync(join(p, 'package.json'))) return p;
  }
  return undefined;
}

let base: string;
const dirs = new Map<string, string>();
const typechecked = new Set<string>();

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'gnl-init-compiles-'));
  // One node_modules above every generated project: the workspace's @gnldev packages (their package.json
  // `exports` point at the built dist) and the third-party packages the recipe files import directly.
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
    scaffold(dir, { features: c.features, ...(c.answers ? { answers: c.answers } : {}) });
    dirs.set(c.label, dir);
    if (c.typecheck) typechecked.add(c.label);
  });
  GENERATED.forEach(([label, make], i) => {
    const dir = join(base, `g${i}`);
    scaffold(dir, { features: [...CODE_FEATURES] });
    writeFileSync(join(dir, 'gnl.config.ts'), make());
    dirs.set(label, dir);
    typechecked.add(label);
  });
  // CONTROL: a project whose config carries one deliberate type error — proves the program below
  // really typechecks (a check that resolved everything to `any` would pass it).
  const control = join(base, 'control');
  scaffold(control, { features: [CODE_FEATURES[0]!] });
  const cfg = join(control, 'gnl.config.ts');
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace('  port: 3000,', "  port: 'three thousand',"));
  dirs.set(CONTROL, control);
  typechecked.add(CONTROL);
}, 120_000);

const CONTROL = 'CONTROL (deliberate type error)';

beforeAll(async () => {
  const { initCommand } = await import('../src/commands/init.js');
  for (const [i, features] of INTEGRATE.entries()) {
    const dir = join(base, `i${i}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `existing-${i}`, type: 'module', dependencies: {} }, null, 2));
    await captureLog(() => initCommand.run({ argv: [dir, '--features', features.join(','), '--yes'] }));
    const label = `gnl init in an existing project --features ${features.join(',')}`;
    dirs.set(label, dir);
    typechecked.add(label);
  }
}, 120_000);

afterAll(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

/** Every .ts file of a generated project that its tsconfig includes (`src` + `gnl.config.ts`). */
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

describe('every recipe and every pair of recipes: gnl.config.ts parses', () => {
  it.each([...CASES.map((c) => c.label), ...GENERATED.map(([l]) => l)])('%s', (label) => {
    const src = readFileSync(join(dirs.get(label)!, 'gnl.config.ts'), 'utf8');
    const sf = ts.createSourceFile('gnl.config.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const diags = (sf as unknown as { parseDiagnostics: import('typescript').Diagnostic[] }).parseDiagnostics.map((d) => {
      const { line } = sf.getLineAndCharacterOfPosition(d.start!);
      return `L${line + 1}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')} | ${JSON.stringify(src.split('\n')[line])}`;
    });
    expect(diags).toEqual([]);
  });
});

describe('every generated project typechecks', () => {
  // `tsc` in a CHILD process at the lowest CPU priority. In-process, this program (the AI SDK's and the
  // packages' types) ran alongside the rest of the suite at full priority and, measured three runs out of
  // three, pushed a pg-mem test that takes 19s alone past its 30s timeout; without it, three of three
  // passed. At the lowest priority it yields the CPU to the suite instead of competing with it.
  it('tsc --noEmit over every case above, the template\'s compiler options, zero errors', async () => {
    const tpl = JSON.parse(readFileSync(join(REPO, 'packages', 'cli', 'templates', 'minimal', 'tsconfig.json'), 'utf8'));
    const roots = [...dirs].filter(([label]) => typechecked.has(label)).flatMap(([, d]) => projectFiles(d));
    const tsconfig = join(base, 'tsconfig.json');
    writeFileSync(tsconfig, JSON.stringify({
      compilerOptions: { ...tpl.compilerOptions, noEmit: true, types: ['node'] },
      files: roots.map((r) => relative(base, r)),
    }));
    const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
    const child = spawn(process.execPath, [tsc, '-p', tsconfig, '--pretty', 'false'], { cwd: base });
    try { setPriority(child.pid!, 19); } catch { /* not permitted here: it runs at normal priority */ }
    let out = '';
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { out += b; });
    await new Promise((r) => child.on('close', r));
    const labelOf = (file: string) => [...dirs].find(([, d]) => resolve(base, file).startsWith(d + '/'))?.[0] ?? '?';
    const errors = out.split('\n').filter((l) => /error TS\d+/.test(l)).map((l) => `[${labelOf(l.split('(')[0]!)}] ${l}`);
    expect(errors.filter((e) => e.startsWith(`[${CONTROL}]`)).join('\n')).toMatch(/gnl\.config\.ts\(\d+,\d+\): error TS2322/);
    expect(errors.filter((e) => !e.startsWith(`[${CONTROL}]`))).toEqual([]);
  }, 240_000);
});

describe('a recipe with nothing to wire contributes nothing to the config', () => {
  it('no recipe declares an empty wiring (omit `wiring` instead)', () => {
    const empty = Object.entries(RECIPES)
      .filter(([, r]) => r.wiring !== undefined && (r.wiring.code.trim() === '' || r.wiring.import.trim() === ''))
      .map(([id]) => id);
    expect(empty).toEqual([]);
  });

  it('generateConfig over every recipe at once writes no blank field and no blank import', () => {
    const src = generateConfig(Object.values(RECIPES));
    expect(src.split('\n').filter((l) => /^\s*,\s*$/.test(l))).toEqual([]);
    const importBlock = src.split('\n').slice(0, src.split('\n').indexOf(''));
    expect(importBlock.every((l) => l.startsWith('import '))).toBe(true);
  });
});

describe('generateConfig does not wire again what the base wires', () => {
  const count = (src: string, re: RegExp) => (src.match(re) ?? []).length;
  it('the idempotency-tool recipe, however it is passed: one chargeOrder import, on the charge-demo agent only', () => {
    for (const set of [[RECIPES['idempotency-tool']!], [RECIPES['idempotency-tool']!, RECIPES['idempotency-tool']!, RECIPES.rag!], Object.values(RECIPES)]) {
      const src = generateConfig(set);
      expect(count(src, /^import \{ chargeOrder \}/gm)).toBe(1);
      expect(src).not.toMatch(/assistant: \{ \.\.\.assistant, tools: \{[^}]*chargeOrder/);
    }
  });

  it('a model recipe adds nothing to gnl.config.ts — the model is set on the agent', () => {
    const bare = generateConfig([]);
    for (const r of Object.values(RECIPES).filter((x) => x.id.startsWith('model-'))) {
      expect(generateConfig([r])).toBe(bare);
      expect(r.humanWire).toMatch(/^Nothing to add to gnl\.config\.ts/);
    }
  });

  it('"nothing to add" in the printed instruction agrees with the generator, for every recipe', () => {
    const bare = generateConfig([]);
    for (const r of Object.values(RECIPES)) {
      if (/^Nothing to add to gnl\.config\.ts/.test(r.humanWire)) expect(generateConfig([r]), r.id).toBe(bare);
    }
  });
});
