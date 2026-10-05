// `gnl add <feature>` wires the feature into gnl.config.ts the way `gnl init --features <feature>`
// would have: adding later and picking at init give the same file. It used to print the lines and
// leave them to the reader — measured: after `gnl add rag` the config never named `searchDocs`, the
// feature did nothing, and neither `gnl dev` nor `gnl doctor` said so.
import { describe, it, expect } from 'vitest';
import { RECIPES, configWiring } from '../src/recipes.js';
import { generateConfig, wireRecipe } from '../src/scaffold.js';

const wired = Object.values(RECIPES).filter((r) => configWiring(r) !== undefined);

describe('adding a feature later = picking it at init', () => {
  it('PRECONDITION: there are recipes to wire, of both places', () => {
    expect(wired.some((r) => configWiring(r)!.place === 'agentTool')).toBe(true);
    expect(wired.some((r) => configWiring(r)!.place === 'configField')).toBe(true);
  });
  for (const r of wired) {
    it(`${r.id}: init + add = init --features ${r.id}`, () => {
      expect(wireRecipe(generateConfig([]), r)).toBe(generateConfig([r]));
    });
    it(`${r.id}: adding it twice wires it once`, () => {
      const once = wireRecipe(generateConfig([]), r)!;
      expect(wireRecipe(once, r)).toBe(once);
    });
  }
  it('every pair, added in order, = picked together', () => {
    for (let i = 0; i < wired.length; i++) for (let j = i + 1; j < wired.length; j++) {
      const a = wired[i]!; const b = wired[j]!;
      expect(wireRecipe(wireRecipe(generateConfig([]), a)!, b), `${a.id} then ${b.id}`).toBe(generateConfig([a, b]));
    }
  });
  it('a config saved with CRLF endings is wired with CRLF endings', () => {
    for (const r of wired) {
      const crlf = (text: string) => text.replace(/\n/g, '\r\n');
      expect(wireRecipe(crlf(generateConfig([])), r), r.id).toBe(crlf(generateConfig([r])));
    }
  });
  it('a config edited by hand out of shape is left alone: undefined, and the caller prints the lines', () => {
    // Not chargeOrder: every config already wires it, so adding it is a no-op whatever the shape.
    const tool = wired.find((r) => configWiring(r)!.place === 'agentTool' && configWiring(r)!.code.trim() !== 'chargeOrder')!;
    const field = wired.find((r) => configWiring(r)!.place === 'configField' && configWiring(r)!.code.trim() !== 'memoryFactory')!;
    const handEdited = generateConfig([]).replace(/  agents: \{ assistant, /, '  agents: {\n    assistant, ').replace(/  \/\/ Features `gnl add` wires go here, one per line\.\n/, '');
    expect(wireRecipe(handEdited, tool)).toBeUndefined();
    expect(wireRecipe(handEdited, field)).toBeUndefined();
  });
});

describe('gnl doctor names a feature written but not wired', () => {
  it('a recipe file the config never imports is named; one it imports is not', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { unwiredRecipes } = await import('../src/scaffold.js');
    const dir = mkdtempSync(join(tmpdir(), 'gnl-unwired-'));
    const rag = RECIPES['rag']!;
    mkdirSync(join(dir, 'src/tools'), { recursive: true });
    writeFileSync(join(dir, rag.file), '// recipe');
    expect(unwiredRecipes(dir, generateConfig([])).map((r) => r.id)).toEqual(['rag']);
    expect(unwiredRecipes(dir, wireRecipe(generateConfig([]), rag)!)).toEqual([]);
    // An import someone commented out wires nothing.
    const imp = configWiring(rag)!.import.trim();
    const off = wireRecipe(generateConfig([]), rag)!.replace(imp, `// ${imp}`).replace(/tools: \{ searchDocs \}/, 'tools: {}');
    expect(unwiredRecipes(dir, off).map((r) => r.id)).toEqual(['rag']);
  });
});

describe('the same holds for every answer `gnl init` asks', () => {
  it('identity × store × serving × preset: init + add = init --features, for every wired recipe', async () => {
    const { DEFAULT_ANSWERS } = await import('../src/init-answers.js');
    let checked = 0;
    for (const preset of ['assistant', 'headless', 'critical'] as const)
      for (const identity of ['internal', 'end-users'] as const)
        for (const store of ['sqlite', 'pg'] as const)
          for (const serving of ['dev', 'own', 'mount'] as const) {
            const a = { ...DEFAULT_ANSWERS, preset, identity, store, serving } as any;
            for (const r of wired) {
              expect(wireRecipe(generateConfig([], a), r), `${r.id} @ ${JSON.stringify(a)}`).toBe(generateConfig([r], a));
              checked++;
            }
          }
    expect(checked).toBeGreaterThan(36);
  });
});
