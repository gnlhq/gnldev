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

const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript');
const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, '..', '..', '..');

const CODE_FEATURES = FEATURE_IDS.filter((f) => f !== E2E_FEATURE);
const PAIRS: string[][] = CODE_FEATURES.flatMap((a, i) => CODE_FEATURES.slice(i + 1).map((b) => [a, b]));
const OTHER_ANSWERS: InitAnswers = { preset: 'critical', identity: 'end-users', store: 'pg', serving: 'dev' };

interface Case { label: string; features: string[]; answers?: InitAnswers; typecheck: boolean }
// Every case is parsed. The typecheck runs over the bare project (no recipe: the branches a feature
// switches off) and ALL recipes together under both answer sets (every config line and every recipe file
// side by side — a single or a pair is a subset of those lines). Not over all 90: that took ~22s of CPU
// in one test, and in the full parallel suite it pushed a pg-mem test (19s alone, 30s limit) past its
// timeout, measured twice; three projects take ~6s.
const CASES: Case[] = [
  { label: 'no recipe', features: [], typecheck: true },
  { label: 'no recipe (critical, end-users, pg)', features: [], answers: OTHER_ANSWERS, typecheck: true },
  ...CODE_FEATURES.map((f) => ({ label: f, features: [f], typecheck: false })),
  ...PAIRS.map((p) => ({ label: p.join('+'), features: p, typecheck: false })),
  ...CODE_FEATURES.map((f) => ({ label: `${f} (critical, end-users, pg)`, features: [f], answers: OTHER_ANSWERS, typecheck: false })),
  { label: 'all recipes', features: [...CODE_FEATURES], typecheck: true },
  { label: 'all recipes (critical, end-users, pg)', features: [...CODE_FEATURES], answers: OTHER_ANSWERS, typecheck: true },
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
  it.each(CASES.filter((c) => c.label !== CONTROL).map((c) => [c.label, c] as const))('%s', (_label, c) => {
    const src = readFileSync(join(dirs.get(c.label)!, 'gnl.config.ts'), 'utf8');
    const sf = ts.createSourceFile('gnl.config.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const diags = (sf as unknown as { parseDiagnostics: import('typescript').Diagnostic[] }).parseDiagnostics.map((d) => {
      const { line } = sf.getLineAndCharacterOfPosition(d.start!);
      return `L${line + 1}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')} | ${JSON.stringify(src.split('\n')[line])}`;
    });
    expect(diags).toEqual([]);
  });
});

describe('the bare project and all recipes together: the generated project typechecks', () => {
  // `tsc` in a CHILD process at the lowest CPU priority. In-process, this program (the AI SDK's and the
  // packages' types) ran alongside the rest of the suite at full priority and, measured three runs out of
  // three, pushed a pg-mem test that takes 19s alone past its 30s timeout; without it, three of three
  // passed. At the lowest priority it yields the CPU to the suite instead of competing with it.
  it('tsc --noEmit over the bare project and all recipes together, the template\'s compiler options, zero errors', async () => {
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
