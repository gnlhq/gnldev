// Invariant: generateConfig emits a gnl.config.ts that PARSES for any recipe set the exported types allow.
//
// Round 1 fixed the four built-in recipes (they now omit `wiring`) and made `Recipe.wiring` optional, but
// the generator still trusted every `wiring` it was handed — and `RecipeWiring.code` is a plain string, so
// `{ import: '', place: 'configField', code: '' }` (the 0.9 shape, still type-legal) wrote the same lone
// `,` line. "Nothing to wire" is now decided by the generator, not by the recipe table.
// K1 = the panel's case; K2/K3 = siblings.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { generateConfig } from '../src/scaffold.js';
import { RECIPES, type Recipe } from '../src/recipes.js';

const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript');
const parseErrors = (src: string) => {
  const sf = ts.createSourceFile('gnl.config.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return ((sf as any).parseDiagnostics as any[]).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
};
const base = Object.values(RECIPES)[0] as Recipe;
const withWiring = (id: string, wiring: Recipe['wiring']): Recipe => ({ ...base, id, wiring });

describe('generateConfig owns "nothing to wire"', () => {
  it('K1: a configField wiring with empty code parses, and adds no field line', () => {
    const src = generateConfig([withWiring('x', { import: '', place: 'configField', code: '' })]);
    expect(parseErrors(src)).toEqual([]);
    expect(src).not.toMatch(/^\s*,\s*$/m);
  });

  it('K1: a whitespace-only agentTool wiring parses, and the assistant keeps its plain entry', () => {
    const src = generateConfig([withWiring('x', { import: '', place: 'agentTool', code: '   ' })]);
    expect(parseErrors(src)).toEqual([]);
    expect(src).toContain('agents: { assistant, ');
  });

  it('K2: a blank agentTool next to a real one leaves no empty slot in the tools object', () => {
    const src = generateConfig([
      withWiring('a', { import: "import { searchDocs } from './src/tools/rag.js';", place: 'agentTool', code: 'searchDocs' }),
      withWiring('b', { import: '', place: 'agentTool', code: '' }),
    ]);
    expect(parseErrors(src)).toEqual([]);
    expect(src).toContain('tools: { searchDocs } }');
  });

  it('K3: an import-only wiring keeps its import line and adds nothing else; a blank import writes no line', () => {
    const src = generateConfig([
      withWiring('a', { import: "import './src/otel.js';", place: 'configField', code: '' }),
      withWiring('b', { import: '  ', place: 'configField', code: '' }),
    ]);
    expect(parseErrors(src)).toEqual([]);
    expect(src).toContain("import './src/otel.js';");
    expect(src.split('\n').filter((l) => l === '  ').length).toBe(0);
  });
});
