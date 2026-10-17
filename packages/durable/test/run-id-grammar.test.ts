// ROOT 1 of audit round 2 — the run-id grammar is ONE table (run-id-grammar.ts), and everything about run
// ids is derived from it. These tests hold the derivation in place:
//  1. THE BIRTH: the gate lives where a run is born (`claimRunOwner`) — every refused family is refused
//     there, with nothing written. That every first write goes THROUGH the birth is held by the birth
//     witness every test file runs under (test/birth-witness.setup.ts), not by a list of entry points.
//  2. DECLARATION: every key a `runKeys` builder spells, and every `${runId}:<family>` literal in any
//     package's source, names a declared family. A new family added in one place only fails here.
//  3. ONE GATE: no entry point checks a run id by hand (no `assertRunIdSafe(`/`admitRunId(`/
//     `startsWith('task:')` outside the grammar and the birth), and no per-run prefix is listed or
//     deleted from an ad-hoc string.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  InMemoryJournal, STAFF, runKeys, RUN_RECORD_FAMILIES, RUN_ID_FAMILIES, RUN_KEYED_FAMILIES, admitRunId, assertRunIdSafe, claimRunOwner,
} from '../src/index.js';
import { LISTED_RUN_RECORD_FAMILIES, minted, mintOf, withMintOf } from '../src/run-id-grammar.js';

/** Ids the gate must refuse, each with the reason it is refused — derived from the table, not typed here. */
const refused: Array<[string, RegExp]> = [
  ...LISTED_RUN_RECORD_FAMILIES.flatMap((f): Array<[string, RegExp]> => [[`p:${f}`, /record separator/], [`p:${f}:z`, /record separator/], [`a:b:${f}:z`, /record separator/]]),
  ...Object.entries(RUN_ID_FAMILIES).filter(([, f]) => f.begin === 'composer').map(([root]): [string, RegExp] => [`${root}:p:c`, /composed by/]),
  ...Object.entries(RUN_ID_FAMILIES).filter(([, f]) => 'nests' in f).map(([root]): [string, RegExp] => [root, /only the root/]),
  ['mem:x', /reserved key family/],
  ['run1_deadbeef', /reserved for engine-derived ids/],
];

describe('the run-id gate is the birth: every refused family, refused where a run is born', () => {
  it.each(refused)('claimRunOwner refuses %s and writes nothing', async (runId, why) => {
    const j = new InMemoryJournal();
    await expect(claimRunOwner(j, runId, STAFF)).rejects.toThrow(why);
    expect(await j.listKeys('')).toEqual([]);
  });

  it.each(refused)("a journal's beginRun (the birth a package without this one reaches) refuses %s and writes nothing", async (runId, why) => {
    const j = new InMemoryJournal();
    await expect((j as unknown as { beginRun(id: string): Promise<void> }).beginRun(runId)).rejects.toThrow(why);
    expect(await j.listKeys('')).toEqual([]);
  });

  it('an engine-begun id is born with the engine\'s mark — bound to its id — and nothing writes the mark', async () => {
    const j = new InMemoryJournal();
    await expect(claimRunOwner(j, 'task:p:c', STAFF, withMintOf({}, minted({ runId: 'task:p:other' })))).rejects.toThrow(/composed by/);
    await claimRunOwner(j, 'task:p:c', STAFF, withMintOf({}, minted({ runId: 'task:p:c' })));
    expect(Object.getOwnPropertySymbols(await j.get(runKeys.input('task:p:c')) as object)).toEqual([]);
    // continuing it (it exists) needs no mark; the owner gate judges who
    await expect(claimRunOwner(j, 'task:p:c', STAFF)).resolves.toBeDefined();
  });

  it.each([
    'x', 'x:evening', 'x:events', 'ev:x', 'x:y:z', 'model:x:input',
    // a leaf family is reached only by its exact key: a neighbour spelled after it is an ordinary run (R2-1)
    ...Object.entries(RUN_RECORD_FAMILIES).filter(([, f]) => f.shape === 'leaf').map(([n]) => `x:${n}-2`),
    ...Object.entries(RUN_RECORD_FAMILIES).filter(([, f]) => !('listed' in f)).map(([n]) => `x:${n}`),
    // the engine's own nesting: `wf`/`net` here are the roots of embedded parent ids, not record segments
    // (an engine-begun id: its spelling is accepted, and the engine — its mark — begins it)
    'agent:wf:p:c:c2', 'agent:net:p:0:c', 'agent:task:p:c:c2', 'agent:run1_0123456789abcdef0123456789abcdef#2:tc',
  ])('%s is accepted', async (id) => {
    expect(() => assertRunIdSafe(id)).not.toThrow();
    await expect(admitRunId(id, { journal: new InMemoryJournal(), mint: mintOf(minted({ runId: id })) })).resolves.toBeUndefined();
  });

  it('an engine-begun id is admitted with the engine\'s mark, or once the run exists (continued, owner-judged)', async () => {
    const j = new InMemoryJournal();
    await expect(admitRunId('task:p:c', { journal: j })).rejects.toThrow(/composed by/);
    const args = minted({ runId: 'task:p:c' });
    await expect(admitRunId('task:p:c', { journal: j, mint: (args as any)[Object.getOwnPropertySymbols(args)[0]!] })).resolves.toBeUndefined();
    // the mark is bound to its id: the args of one run do not begin another
    await expect(admitRunId('task:p:other', { journal: j, mint: (args as any)[Object.getOwnPropertySymbols(args)[0]!] })).rejects.toThrow(/composed by/);
    await j.put(runKeys.input('task:p:c'), { at: 1 });
    await expect(admitRunId('task:p:c', { journal: j })).resolves.toBeUndefined();
  });
});

// ── declaration ──────────────────────────────────────────────────────────────────────────────────────

const PACKAGES = join(__dirname, '..', '..');
function sources(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith('.ts') && !n.endsWith('.d.ts')) out.push([p.slice(PACKAGES.length + 1), readFileSync(p, 'utf8')]);
    }
  };
  for (const pkg of readdirSync(PACKAGES)) {
    const src = join(PACKAGES, pkg, 'src');
    try { if (statSync(src).isDirectory()) walk(src); } catch { /* a package without src */ }
  }
  return out;
}
/** Code lines only: a comment may quote a literal (`${runId}:swept` in a doc comment is not a key). */
const codeLines = (text: string) => text.split('\n').map((l, i) => [i + 1, l] as const).filter(([, l]) => !/^\s*(\*|\/\/|\/\*)/.test(l));

describe('every run-keyed spelling is declared in the grammar', () => {
  it('every runKeys builder spells a declared family', () => {
    const R = 'R';
    const undeclared: string[] = [];
    const outside = [...Object.values(RUN_KEYED_FAMILIES).map((f) => f.prefix(R)), 'xrun:', 'xthr:', 'mem-appended:', 'mem-user-appended:'];
    for (const [name, build] of Object.entries(runKeys)) {
      if (typeof build !== 'function' || name.startsWith('is')) continue;
      let key: unknown;
      try { key = (build as (...a: string[]) => unknown)(R, 'tool', 'h'); } catch { key = (build as (...a: string[]) => unknown)(`${R}:tool:c`); }
      if (typeof key !== 'string') continue;
      if (key.startsWith(`${R}:`)) {
        const family = key.slice(2).split(':', 1)[0]!;
        if (!(family in RUN_RECORD_FAMILIES)) undeclared.push(`${name} → ${key}`);
      } else if (!outside.some((p) => key.startsWith(p.startsWith('xreq:') ? 'xreq:' : p))) undeclared.push(`${name} → ${key}`);
    }
    expect(undeclared).toEqual([]);
  });

  it('every `${<run id>}:<family>` literal in any package names a declared family (or is not a key)', () => {
    // Not journal keys: ids of messages and artifacts a door hands its client, and the rerun suffixes
    // `rerunRunId` spells (named in run-id-grammar.ts, not record families).
    const NOT_KEYS = new Set(['msg', 'text', 'answer', 'call']);
    const found: string[] = [];
    for (const [file, text] of sources()) {
      if (file.endsWith('run-id-grammar.ts')) continue;
      for (const [n, line] of codeLines(text)) {
        for (const m of line.matchAll(/\$\{[A-Za-z_.]*(?:[rR]unId|RunId)\}:([a-z][a-z-]*)/g)) {
          const family = m[1]!;
          if (!(family in RUN_RECORD_FAMILIES) && !NOT_KEYS.has(family)) found.push(`${file}:${n} :${family}`);
        }
      }
    }
    expect(found).toEqual([]);
  });
});

describe('one gate, one spelling', () => {
  it('no entry point checks a run id by hand: the gate is called, the families are not tested by string', () => {
    const byHand: string[] = [];
    for (const [file, text] of sources()) {
      if (file.endsWith('run-id-grammar.ts')) continue;
      for (const [n, line] of codeLines(text)) {
        if (/\bassertRunIdSafe\(/.test(line) && !/^\s*export /.test(line)) byHand.push(`${file}:${n} assertRunIdSafe(`);
        // the gate is called by the birth alone (run-identity.ts claimRunOwner), never by an entry point
        if (/\badmitRunId\(/.test(line) && !/^\s*export /.test(line) && !file.endsWith('durable/src/run-identity.ts')) byHand.push(`${file}:${n} admitRunId(`);
        if (/startsWith\('(task|cont|agent|wf|net):'\)/.test(line)) byHand.push(`${file}:${n} ${line.trim().slice(0, 80)}`);
        if (/\(model\|tool(\|ev)?\)/.test(line)) byHand.push(`${file}:${n} ${line.trim().slice(0, 80)}`);
      }
    }
    expect(byHand).toEqual([]);
  });

  it('no per-run prefix is listed or deleted from an ad-hoc string (only @gnldev/workflow mirrors its own `wf` family)', () => {
    const adHoc: string[] = [];
    for (const [file, text] of sources()) {
      if (file.endsWith('run-id-grammar.ts') || file.startsWith('workflow/')) continue;
      for (const [n, line] of codeLines(text)) {
        if (/(deletePrefix|listKeys|readRange|\bdel)\??\.?\(\s*`\$\{[A-Za-z_.]*\}:[a-z-]+/.test(line)) adHoc.push(`${file}:${n} ${line.trim().slice(0, 90)}`);
        if (/(const|let) [A-Za-z]*[pP]re(fix)? = `\$\{[A-Za-z_.]*\}:[a-z-]+/.test(line)) adHoc.push(`${file}:${n} ${line.trim().slice(0, 90)}`);
      }
    }
    expect(adHoc).toEqual([]);
  });

  it('every listed family the workflow package mirrors is one the gate protects', () => {
    expect(LISTED_RUN_RECORD_FAMILIES).toContain('wf');
    expect(readFileSync(join(PACKAGES, 'workflow', 'src', 'workflow.ts'), 'utf8')).toMatch(/\$\{[a-zA-Z.]*[rR]unId\}:wf:/);
  });
});
