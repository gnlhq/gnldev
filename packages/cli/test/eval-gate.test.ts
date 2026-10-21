// gnl eval — *.eval.ts suites held to their thresholds, and a non-zero exit when one falls short, so a
// CI step fails on a quality regression. Driven twice: the core (evalCore) for what it decides, and the
// built CLI in a subprocess for the exit code a CI runner reads.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as Evals from '@gnldev/evals';
import { InMemoryJournal } from '@gnldev/durable';
import { evalCore, findEvalFiles } from '../src/commands/eval.js';

const FIX = join(__dirname, 'fixtures', 'evals');
const CLI = join(__dirname, '..', 'dist', 'cli.js');
const calls = () => (globalThis as { __gnlEvalCalls?: number }).__gnlEvalCalls ?? 0;

describe('evalCore', () => {
  it('finds *.eval.ts under a directory, and holds each suite to its own thresholds', async () => {
    const files = findEvalFiles([FIX]);
    expect(files.map((f) => f.slice(FIX.length + 1)).sort()).toEqual(['broken/none.eval.ts', 'ok/echo.eval.ts', 'short/half.eval.ts', 'typo/typo.eval.ts']);
    const { outcomes, pass } = await evalCore({ files, evals: Evals, invocation: 't1' });
    expect(pass).toBe(false);
    const by = (s: string) => outcomes.find((o) => o.file.endsWith(s))!;
    expect(by('echo.eval.ts')).toMatchObject({ datasetId: 'echo', failures: [] });
    expect(by('echo.eval.ts').result!.aggregate).toEqual({ contains: 1 });
    expect(by('half.eval.ts').failures).toEqual([
      { scorer: 'contains', rule: 'mean', want: 0.9, got: 0.5 },
      expect.objectContaining({ scorer: 'contains', rule: 'every', caseId: 'bad', got: 0 }),
    ]);
    expect(by('typo.eval.ts').failures).toEqual([{ scorer: 'contians', rule: 'missing' }]);
    expect(by('none.eval.ts').error).toMatch(/no default export/);
  });

  it('each invocation runs its cases again; --resume of the same invocation replays them', async () => {
    const journal = new InMemoryJournal();
    const file = [join(FIX, 'ok', 'echo.eval.ts')];
    const before = calls();
    await evalCore({ files: file, evals: Evals, journal, invocation: 'a' });
    expect(calls() - before).toBe(2);
    await evalCore({ files: file, evals: Evals, journal, invocation: 'b' }); // a new invocation: the code may have changed
    expect(calls() - before).toBe(4);
    await evalCore({ files: file, evals: Evals, journal, invocation: 'b' }); // --resume b: already done
    expect(calls() - before).toBe(4);
  });
});

describe('gnl eval, the built CLI', () => {
  const run = (...args: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-gate-'));
    try {
      const out = execFileSync('node', [CLI, 'eval', ...args, '--journal', join(dir, 'evals.db')], { cwd: join(__dirname, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
      return { code: 0, out, stdout: out };
    } catch (e: any) {
      return { code: e.status ?? 1, out: String(e.stdout ?? '') + String(e.stderr ?? ''), stdout: String(e.stdout ?? '') };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('exits 0 when every suite meets its thresholds', () => {
    const r = run(join(FIX, 'ok'));
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/✓ test\/fixtures\/evals\/ok\/echo\.eval\.ts/);
    expect(r.out).toMatch(/contains\s+1\.000\s+\(mean ≥ 1\)/);
  });

  it('exits 1 when one falls short, naming the scorer, the rule and the case', () => {
    const r = run(join(FIX, 'ok'), join(FIX, 'short'));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/✗ contains: mean 0\.500 < 0\.9/);
    expect(r.out).toMatch(/✗ contains: case bad scored 0\.000 < 1/);
  });

  it('--json reports the same, for a CI step that reads it', () => {
    const r = run(join(FIX, 'typo'), '--json');
    expect(r.code).toBe(1);
    const report = JSON.parse(r.stdout);
    expect(report.pass).toBe(false);
    expect(report.outcomes[0].failures).toEqual([{ scorer: 'contians', rule: 'missing' }]);
  });

  it('with no eval files, says so and exits 1', () => {
    const empty = mkdtempSync(join(tmpdir(), 'eval-gate-empty-'));
    try {
      const r = run(empty);
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/no \*\.eval\.ts files found/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
