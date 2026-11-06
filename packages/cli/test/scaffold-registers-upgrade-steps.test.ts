// `gnl init --features job|schedule` writes the line that lets `storage.upgrade()` and `gnl upgrade` know
// the package's steps — where the store is built, the one place every caller reaches. Read as text and
// parsed; the typecheck against the packages is init-config-compiles.test.ts.
import { describe, it, expect } from 'vitest';
import { generateConfig } from '../src/scaffold.js';
import { RECIPES } from '../src/recipes.js';
import type { InitAnswers } from '../src/init-answers.js';

const ts = (await import('node:module')).createRequire(import.meta.url)('typescript') as typeof import('typescript');
const PG: InitAnswers = { preset: 'critical', identity: 'end-users', store: 'pg', serving: 'dev' };
const parses = (src: string) => ts.transpileModule(src, { reportDiagnostics: true, compilerOptions: { module: ts.ModuleKind.ESNext } }).diagnostics!.length === 0;

describe('the generated config registers the steps of the packages picked', () => {
  it('queue: the store is wrapped, the factory and registerUpgradeSteps are imported', () => {
    const c = generateConfig([RECIPES.job!]);
    expect(c).toContain("storage: registerUpgradeSteps(new SqliteStorage('runs.db'), [queueUpgrade]),");
    expect(c).toContain("import { registerUpgradeSteps } from '@gnldev/durable';");
    expect(c).toContain("import { queueUpgrade } from '@gnldev/queue';");
    expect(parses(c)).toBe(true);
  });

  it('scheduler on Postgres', () => {
    const c = generateConfig([RECIPES.schedule!], PG);
    expect(c).toContain('storage: registerUpgradeSteps(new PostgresStorage({ connectionString: process.env.DATABASE_URL! }), [schedulerUpgrade]),');
    expect(c).toContain("import { schedulerUpgrade } from '@gnldev/scheduler';");
    expect(parses(c)).toBe(true);
  });

  it('both, in either order, a recipe listed twice: each factory once', () => {
    const c = generateConfig([RECIPES.job!, RECIPES.schedule!, RECIPES.job!], PG);
    expect(c).toContain('[queueUpgrade, schedulerUpgrade]),');
    expect(c.match(/import \{ registerUpgradeSteps \}/g)).toHaveLength(1);
    expect(c.match(/import \{ queueUpgrade \}/g)).toHaveLength(1);
    expect(parses(c)).toBe(true);
  });

  it('CONTROL: neither picked, the store is not wrapped and nothing is imported', () => {
    const c = generateConfig([]);
    expect(c).toContain("storage: new SqliteStorage('runs.db'),");
    expect(c).not.toMatch(/registerUpgradeSteps|queueUpgrade|schedulerUpgrade/);
  });
});
