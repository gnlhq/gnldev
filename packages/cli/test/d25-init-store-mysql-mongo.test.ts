// d25 item 22: `gnl init --store mysql|mongo`.
//
// Measured on release/0.17.1: `gnl init --store mysql` -> "--store 'mysql' is not one of sqlite | pg", although
// @gnldev/durable ships MysqlStorage (`@gnldev/durable/mysql`) and MongoStorage (`@gnldev/durable/mongo`).
// Decision: add both to the store question. They are a config line + a dependency (the iron rule of
// init-answers.ts), so no existing file forks. The exact .env key name and label texts are NOT pinned here.
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { scaffold } from '../src/scaffold.js';
import { DEFAULT_ANSWERS, QUESTIONS, STORE_QUESTION, resolveAnswers, type InitAnswers } from '../src/init-answers.js';
import { captureLog } from './helpers.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, '..', '..', '..');
const durablePkg = JSON.parse(readFileSync(join(REPO, 'packages', 'durable', 'package.json'), 'utf8'));

const ANSWERS = (store: string): InitAnswers => ({ ...DEFAULT_ANSWERS, store: store as never });
const CASES = [
  { store: 'mysql', cls: 'MysqlStorage', sub: '@gnldev/durable/mysql', driver: 'mysql2', other: ['PostgresStorage', 'SqliteStorage', 'MongoStorage'] },
  { store: 'mongo', cls: 'MongoStorage', sub: '@gnldev/durable/mongo', driver: 'mongodb', other: ['PostgresStorage', 'SqliteStorage', 'MysqlStorage'] },
] as const;

const created: string[] = [];
afterAll(() => { for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true }); });
function scaffolded(store: string, extra: Record<string, unknown> = {}): { dir: string; config: string; pkg: any } {
  const base = mkdtempSync(join(tmpdir(), `gnl-store-${store}-`));
  created.push(base);
  const dir = join(base, 'app');
  scaffold(dir, { answers: ANSWERS(store), ...extra } as never);
  return { dir, config: readFileSync(join(dir, 'gnl.config.ts'), 'utf8'), pkg: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) };
}

describe('the store question and its flag', () => {
  for (const c of CASES) {
    it(`--store ${c.store} is an answer: resolveAnswers accepts it and records it as a flag`, () => {
      const r = resolveAnswers({ store: c.store });
      expect(r.answers.store).toBe(c.store);
      expect(r.from.store).toBe('flag');
    });
  }
  it('the question still lists sqlite and pg, and every option says what it means (label + hint)', () => {
    const ids = STORE_QUESTION.options.map((o) => o.id as string);
    expect(ids).toEqual(expect.arrayContaining(['sqlite', 'pg', 'mysql', 'mongo']));
    expect(ids.slice(0, 2), 'the existing two keep their place (the recommended default stays first)').toEqual(['sqlite', 'pg']);
    for (const o of STORE_QUESTION.options) { expect(o.label.length).toBeGreaterThan(3); expect(o.hint?.length ?? 0).toBeGreaterThan(3); }
  });
  it('still four questions; the default is still sqlite; an unknown store is still refused and the message lists the real set', () => {
    expect(QUESTIONS).toHaveLength(4);
    expect(DEFAULT_ANSWERS.store).toBe('sqlite');
    expect(() => resolveAnswers({ store: 'oracle' })).toThrow(/--store 'oracle' is not one of .*sqlite.*pg.*mysql.*mongo/);
  });
});

describe('the generated project', () => {
  for (const c of CASES) {
    describe(`store ${c.store}`, () => {
      it('config: imports the class from its subpath, builds it as storage, from the environment, and names no other store', () => {
        const { config } = scaffolded(c.store);
        expect(config).toContain(`from '${c.sub}'`);
        expect(config).toMatch(new RegExp(`storage:[^\\n]*new ${c.cls}\\(`));
        for (const o of c.other) expect(config, `${c.store} config mentions ${o}`).not.toContain(o);
        // the connection string is read from the environment — never a literal URL in a file people commit
        expect(config).toMatch(/connectionString:\s*process\.env\.[A-Z_]+/);
        expect(config).not.toMatch(/(mysql|mongodb)(\+srv)?:\/\//);
      });
      it('package.json: ships the driver at durable\'s own peer range, and no other database driver', () => {
        const { pkg } = scaffolded(c.store);
        expect(pkg.dependencies[c.driver]).toBe(durablePkg.peerDependencies[c.driver]);
        for (const d of ['pg', c.driver === 'mysql2' ? 'mongodb' : 'mysql2']) expect(pkg.dependencies[d]).toBeUndefined();
      });
      it('the key the config reads is documented for the reader (.env.example or the config\'s own comment), and is not defaulted', () => {
        const { dir, config } = scaffolded(c.store);
        const key = /connectionString:\s*process\.env\.([A-Z_]+)/.exec(config)![1]!;
        const envExample = existsSync(join(dir, '.env.example')) ? readFileSync(join(dir, '.env.example'), 'utf8') : '';
        expect(config.includes(key) && (envExample.includes(key) || /process\.env\.[A-Z_]+!/.test(config))).toBe(true);
        expect(config, 'no silent fallback to a local value').not.toMatch(new RegExp(`process\\.env\\.${key}\\s*(\\|\\||\\?\\?)`));
      });
      it('composes with the other answers and a feature: still the same storage, still the same driver', () => {
        const { config, pkg } = scaffolded(c.store, { features: ['otel'], answers: { preset: 'critical', identity: 'end-users', store: c.store, serving: 'dev' } });
        expect(config).toMatch(new RegExp(`new ${c.cls}\\(`));
        expect(pkg.dependencies[c.driver]).toBeDefined();
      });
    });
  }

  it('REGRESSION: sqlite and pg scaffolds are exactly what they were (class, import, driver)', () => {
    const s = scaffolded('sqlite');
    expect(s.config).toContain("from '@gnldev/durable/sqlite'");
    expect(s.config).toContain("new SqliteStorage('runs.db')");
    expect(s.pkg.dependencies['pg']).toBeUndefined();
    const p = scaffolded('pg');
    expect(p.config).toContain("from '@gnldev/durable/postgres'");
    expect(p.config).toContain('new PostgresStorage({ connectionString: process.env.DATABASE_URL! })');
    expect(p.pkg.dependencies['pg']).toBe(durablePkg.peerDependencies['pg']);
    for (const x of [s, p]) for (const d of ['mysql2', 'mongodb']) expect(x.pkg.dependencies[d]).toBeUndefined();
  });
});

describe('`gnl init` itself', () => {
  async function initOut(dir: string, argv: string[]): Promise<string> {
    const { initCommand } = await import('../src/commands/init.js');
    return (await captureLog(async () => { await initCommand.run({ argv: [dir, ...argv, '--yes'] }); })).join('\n');
  }
  for (const c of CASES) {
    it(`--store ${c.store} --yes writes the project`, async () => {
      const base = mkdtempSync(join(tmpdir(), 'gnl-init-store-')); created.push(base);
      const dir = join(base, 'app');
      await initOut(dir, ['--store', c.store]);
      expect(readFileSync(join(dir, 'gnl.config.ts'), 'utf8')).toContain(c.cls);
    });
    it(`--store ${c.store} in an existing project: names the driver in the printed \`pnpm add\` line, edits no manifest`, async () => {
      const base = mkdtempSync(join(tmpdir(), 'gnl-init-existing-')); created.push(base);
      writeFileSync(join(base, 'package.json'), JSON.stringify({ name: 'existing', dependencies: { hono: '^4.6.0' } }, null, 2));
      const out = await initOut(base, ['--store', c.store]);
      const add = out.split('\n').find((l) => l.includes('pnpm add') && !l.includes('-D'))!;
      expect(add.split(/\s+/)).toContain(c.driver);
      expect(JSON.parse(readFileSync(join(base, 'package.json'), 'utf8')).dependencies).toEqual({ hono: '^4.6.0' });
    });
    it(`--store ${c.store}: the summary names the store the config really uses (not "file")`, async () => {
      const base = mkdtempSync(join(tmpdir(), 'gnl-init-summary-')); created.push(base);
      const out = await initOut(join(base, 'app'), ['--store', c.store]);
      expect(out).not.toMatch(/·\s*file\s*·/);
    });
  }
});

// The generated project must COMPILE — the check a freshly installed project would make.
const ts = createRequire(import.meta.url);
function findInstalled(name: string): string | undefined {
  const roots = [join(REPO, 'node_modules'), ...readdirSync(join(REPO, 'packages')).map((p) => join(REPO, 'packages', p, 'node_modules'))];
  for (const r of roots) { const p = join(r, name); if (existsSync(join(p, 'package.json'))) return p; }
  return undefined;
}
function projectFiles(dir: string): string[] {
  const out = [join(dir, 'gnl.config.ts')];
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts')) out.push(p); } };
  if (existsSync(join(dir, 'src'))) walk(join(dir, 'src'));
  return out;
}
describe('every generated mysql/mongo project typechecks (tsc --noEmit, the template\'s options)', () => {
  let base: string;
  const dirs = new Map<string, string>();
  const CONTROL = 'CONTROL';
  const classOf = new Map<string, string>();
  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'gnl-store-tsc-'));
    const nm = join(base, 'node_modules');
    mkdirSync(join(nm, '@gnldev'), { recursive: true });
    for (const p of readdirSync(join(REPO, 'packages'))) {
      const pj = join(REPO, 'packages', p, 'package.json');
      if (!existsSync(pj)) continue;
      const name = JSON.parse(readFileSync(pj, 'utf8')).name as string;
      if (name?.startsWith('@gnldev/')) symlinkSync(join(REPO, 'packages', p), join(nm, name), 'dir');
    }
    for (const dep of ['ai', 'zod', '@types/node', 'hono', '@hono/node-server', '@ai-sdk/provider', '@ai-sdk/openai', '@ai-sdk/anthropic', '@ai-sdk/openai-compatible', 'pg', '@types/pg', 'mysql2', 'mongodb']) {
      const at = findInstalled(dep);
      if (!at) continue;
      mkdirSync(dirname(join(nm, dep)), { recursive: true });
      symlinkSync(at, join(nm, dep), 'dir');
    }
    const other = (store: string): InitAnswers => ({ preset: 'critical', identity: 'end-users', store: store as never, serving: 'dev' });
    for (const c of CASES) {
      for (const [label, answers, features] of [[`${c.store} default`, ANSWERS(c.store), []], [`${c.store} critical/end-users + otel`, other(c.store), ['otel']]] as const) {
        const dir = join(base, label.replace(/\W+/g, '-'));
        scaffold(dir, { answers, features: [...features] } as never);
        dirs.set(label, dir);
        classOf.set(label, c.cls);
      }
    }
    const control = join(base, 'control');
    scaffold(control, { answers: ANSWERS('sqlite') });
    const cfg = join(control, 'gnl.config.ts');
    writeFileSync(cfg, readFileSync(cfg, 'utf8').replace('  port: 3000,', "  port: 'three thousand',"));
    dirs.set(CONTROL, control);
  }, 120_000);
  afterAll(() => { if (base) rmSync(base, { recursive: true, force: true }); });

  it('zero errors; the control (one deliberate type error) proves the program really typechecks', async () => {
    // not vacuous: what is compiled below really is the mysql/mongo config (a scaffold that ignored the answer would compile too)
    for (const [label, cls] of classOf) expect(readFileSync(join(dirs.get(label)!, 'gnl.config.ts'), 'utf8'), label).toContain(cls);
    const tpl = JSON.parse(readFileSync(join(REPO, 'packages', 'cli', 'templates', 'minimal', 'tsconfig.json'), 'utf8'));
    const roots = [...dirs].flatMap(([, d]) => projectFiles(d));
    const tsconfig = join(base, 'tsconfig.json');
    writeFileSync(tsconfig, JSON.stringify({ compilerOptions: { ...tpl.compilerOptions, noEmit: true, types: ['node'] }, files: roots.map((r) => relative(base, r)) }));
    const tsc = ts.resolve('typescript/bin/tsc');
    const child = spawn(process.execPath, [tsc, '-p', tsconfig, '--pretty', 'false'], { cwd: base });
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
