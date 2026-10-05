// Every options object a GNL package takes refuses a name it does not take (@gnldev/options).
//
// The rule was wired by hand into 23 packages, and that was measured not to be enough twice over: the
// hand sweep missed 13 option bags (methods such as `cache.set(k, v, { ttlMs })`, subpath entries
// such as `@gnldev/otel/live`, nested bags such as `exportRunToOtlp({ retry })`), and a new exported
// function with an unchecked options bag passed every other gate while dropping a misspelled name.
// A rule that holds only while someone remembers it does not hold. Three checks, all from the source:
//
//   1. Every exported options TYPE (`*Options`, `*Config`, `*Opts`) is held to a name list — the type
//      argument of some optionNames<T>() / variantNames<T>() / doorOptionKeys<T>() call.
//   2. Every exported function, class constructor and public class method that takes an options bag
//      (named or written inline) hands that parameter to a refuse… call in its own body.
//   3. Every name list is read by some refuse… call: a list nothing reads checks nothing.
//
// Not options bags, so not held: an implementation of an interface (a parameter type with a required
// method — a journal, a store, a provider), arrays, and the `detail` of an Error subclass (gnl builds
// it). A declaration tagged `@internal — <why>` is gnl's own plumbing between its packages, not a
// host's API, and is skipped; the tag carries the reason next to the code, where a reviewer sees it.
import ts from 'typescript';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

const root = resolve(process.argv[2] ?? '.');
const pkgsDir = join(root, 'packages');

/** Every source file of every package, and each package's entry files from its `exports` map. */
const files = [];
const entries = [];
const walk = (d) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) { if (!['node_modules', 'dist', 'test'].includes(n)) walk(p); }
    else if (/\.tsx?$/.test(n) && !n.endsWith('.d.ts')) files.push(p);
  }
};
for (const pkg of readdirSync(pkgsDir)) {
  const src = join(pkgsDir, pkg, 'src');
  if (!existsSync(src)) continue;
  walk(src);
  const manifest = JSON.parse(readFileSync(join(pkgsDir, pkg, 'package.json'), 'utf8'));
  if (manifest.private === true && !manifest.publishConfig) continue;
  const targets = [];
  const collect = (v) => { if (typeof v === 'string') targets.push(v); else if (v && typeof v === 'object') for (const x of Object.values(v)) collect(x); };
  collect(manifest.exports ?? manifest.main ?? './dist/index.js');
  for (const t of targets) {
    const m = /^\.\/dist\/(.+)\.js$/.exec(t);
    if (!m) continue;
    for (const ext of ['.ts', '.tsx']) { const f = join(pkgsDir, pkg, 'src', m[1] + ext); if (existsSync(f)) entries.push(f); }
  }
}

const program = ts.createProgram(files, {
  strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext, skipLibCheck: true, jsx: ts.JsxEmit.ReactJSX, noEmit: true,
});
const checker = program.getTypeChecker();
const rel = (f) => f.slice(pkgsDir.length + 1);
const isInternal = (node) => ts.getJSDocTags(node).some((t) => t.tagName.text === 'internal');
const BUILTIN = /^(Request|Response|Headers|URL|Date|Map|Set|WeakMap|Promise|RegExp|Error|Uint8Array|ArrayBuffer|ReadableStream|WritableStream|AbortSignal|Buffer|Function)$/;

/** Is this type an options bag? Object-typed, not callable, not an array, and not an implementation. */
function isBag(type) {
  const t = checker.getNonNullableType(type);
  for (const p of t.isUnion() ? t.types : [t]) {
    if (!(p.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection))) continue;
    if (p.getCallSignatures().length || p.getConstructSignatures().length) continue;
    if (checker.isArrayType(p) || checker.isTupleType(p)) continue;
    const name = (p.aliasSymbol ?? p.getSymbol())?.name ?? '';
    if (BUILTIN.test(name)) continue;
    // A record with free keys (JWT claims, a context map) has no names to hold.
    if (checker.getIndexInfosOfType(p).length) continue;
    const props = checker.getPropertiesOfType(p);
    if (!props.length) continue;
    const requiredMethod = props.some((pr) => {
      if (pr.flags & ts.SymbolFlags.Optional) return false;
      const d = pr.valueDeclaration ?? pr.declarations?.[0];
      if (!d) return false;
      if (ts.isMethodSignature(d) || ts.isMethodDeclaration(d)) return true;
      return checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(pr, d)).getCallSignatures().length > 0;
    });
    // A named options type is a bag even when it carries a required callback (`{ embed, journal }`).
    if (requiredMethod && !/(Options|Config|Opts|Spec)$/.test(name)) continue;
    // A named type is a bag when it is named as one (`*Options`, `*Config`, …) — a Principal, a Caller or
    // a RunIdentity is data. A type written inline is a bag when it has an optional field; one whose
    // fields are all required is a data shape (`{ method, path, body }`).
    const anonymous = name === '__type' || name === '__object' || name === '';
    const bag = anonymous ? props.some((pr) => pr.flags & ts.SymbolFlags.Optional) : /(Options|Config|Opts|Spec|Definition|Init)$/.test(name);
    if (!bag) continue;
    return true;
  }
  return false;
}

const REFUSE = /\brefuse\w*\(|\brefuseMisplacedOptions\(/;
/** Does `body` hand `param` to a refuse… call? */
function bodyRefuses(body, param) {
  if (!body) return false;
  let found = false;
  const visit = (n) => {
    if (found) return;
    if (ts.isCallExpression(n) && REFUSE.test(n.expression.getText() + '(') && n.arguments.some((a) => new RegExp(`(^|[^\\w.])${param}\\b`).test(a.getText()))) found = true;
    ts.forEachChild(n, visit);
  };
  visit(body);
  return found;
}

const problems = [];
const seenDecl = new Set();

function checkSignature(label, decl, file) {
  if (seenDecl.has(decl)) return;
  seenDecl.add(decl);
  if (isInternal(decl)) return;
  decl.parameters.forEach((p) => {
    if (!isBag(checker.getTypeAtLocation(p))) return;
    if (!ts.isIdentifier(p.name)) { problems.push(`${rel(file)}: ${label} takes an options bag through a destructured parameter — name it and refuse it first`); return; }
    if (!bodyRefuses(decl.body, p.name.text)) problems.push(`${rel(file)}: ${label}(${p.name.text}) — the options bag is not handed to a refuse… call`);
  });
}

// ── 2. functions, constructors, public methods reachable from the entries ──
const heldTypes = new Set();
const exportedTypes = new Map();
for (const entry of entries) {
  const sf = program.getSourceFile(entry);
  const mod = sf && checker.getSymbolAtLocation(sf);
  if (!mod) continue;
  for (const ex of checker.getExportsOfModule(mod)) {
    const sym = ex.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(ex) : ex;
    for (const decl of sym.declarations ?? []) {
      const file = decl.getSourceFile().fileName;
      if (!file.startsWith(pkgsDir) || file.includes('/node_modules/')) continue;
      if (ts.isFunctionDeclaration(decl) && decl.body) checkSignature(sym.name, decl, file);
      if (ts.isClassDeclaration(decl) && !isInternal(decl)) {
        const extendsError = decl.heritageClauses?.some((h) => h.types.some((t) => /Error$/.test(t.expression.getText())));
        for (const m of decl.members) {
          const priv = m.modifiers?.some((x) => [ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword].includes(x.kind)) || (m.name && ts.isPrivateIdentifier(m.name));
          if (priv) continue;
          if (ts.isConstructorDeclaration(m) && m.body && !extendsError) checkSignature(`new ${sym.name}`, m, file);
          if (ts.isMethodDeclaration(m) && m.body && m.name && !m.name.getText().startsWith('_')) checkSignature(`${sym.name}#${m.name.getText()}`, m, file);
        }
      }
      if ((ts.isInterfaceDeclaration(decl) || ts.isTypeAliasDeclaration(decl)) && /(Options|Config|Opts)$/.test(decl.name.text) && !isInternal(decl)) {
        const target = checker.getTypeAtLocation(decl.name);
        exportedTypes.set(sym, { label: `${rel(file)}: ${decl.name.text}`, also: [target.aliasSymbol, target.getSymbol()].filter(Boolean) });
      }
    }
  }
}

// ── 1 & 3. name lists: which types they hold, and whether anything reads them ──
const listConsts = new Map(); // const name -> file
for (const f of files) {
  const sf = program.getSourceFile(f);
  if (!sf) continue;
  const visit = (n) => {
    if (ts.isCallExpression(n) && ts.isCallExpression(n.expression) && ts.isIdentifier(n.expression.expression)
        && /^(optionNames|variantNames|doorOptionKeys)$/.test(n.expression.expression.text) && n.expression.typeArguments?.[0]) {
      const node = n.expression.typeArguments[0];
      const t = checker.getTypeFromTypeNode(node);
      for (const p of t.isUnion() ? t.types : [t]) for (const s of [p.aliasSymbol, p.getSymbol()]) if (s) heldTypes.add(s);
      // Omit<T,…> / Pick<T,…> / Parameters<typeof fn>[i]: the named types written in the argument are held too.
      const walkType = (tn) => { if (ts.isTypeReferenceNode(tn)) { const s = checker.getSymbolAtLocation(tn.typeName); if (s) heldTypes.add(s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s); } ts.forEachChild(tn, walkType); };
      walkType(node);
      const fnSig = (tn) => { if (ts.isTypeQueryNode(tn)) { const s = checker.getSymbolAtLocation(tn.exprName); const d = s && (s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s).valueDeclaration; if (d && ts.isFunctionLike(d)) for (const p of d.parameters) for (const ty of [checker.getTypeAtLocation(p)]) { const nn = checker.getNonNullableType(ty); for (const x of nn.isUnion() ? nn.types : [nn]) for (const s2 of [x.aliasSymbol, x.getSymbol()]) if (s2) heldTypes.add(s2); } } ts.forEachChild(tn, fnSig); };
      fnSig(node);
    }
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && /_NAMES$/.test(n.name.text)) listConsts.set(n.name.text, f);
    ts.forEachChild(n, visit);
  };
  visit(sf);
}
// An alias (`StudioOptions = StudioApiOptions`) is held when the type it names is.
for (const [sym, { label, also }] of exportedTypes) if (!heldTypes.has(sym) && !also.some((s) => heldTypes.has(s))) problems.push(`${label} — an exported options type held to no name list`);

const allSource = files.map((f) => readFileSync(f, 'utf8')).join('\n');
for (const [name, f] of listConsts) {
  const uses = allSource.match(new RegExp(`\\b${name}\\b`, 'g'))?.length ?? 0;
  if (uses < 2) problems.push(`${rel(f)}: ${name} — a name list nothing reads`);
}

if (problems.length) {
  console.error(`✗ ${problems.length} options object(s) not held to the name rule (@gnldev/options):\n`);
  for (const p of [...new Set(problems)].sort()) console.error(`    ${p}`);
  console.error('\n  Hand the bag to refuseUnknownNames(where, opts, NAMES) with NAMES = optionNames<T>()([...]), or');
  console.error('  tag the declaration `@internal — <why>` if it is gnl plumbing between packages, not a host API.');
  process.exit(1);
}
console.log(`✓ every exported options object refuses a name it does not take (${seenDecl.size} signatures, ${exportedTypes.size} option types, ${listConsts.size} name lists)`);
