// Makes a generator process reproducible: the clock, Math.random and node:crypto's randomUUID all come
// from fixed seeds, so writing the fixtures twice gives the same rows (and, for SQLite, the same bytes).
//
// Imported FIRST, before any GNL module: `import { randomUUID } from 'node:crypto'` binds when the
// importing module links, and syncBuiltinESMExports() is what carries a patched default export over to
// those named bindings.
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';

/** 2026-09-30T12:00:00Z, the day 0.9.0 was released. Every fixture's clock starts here. */
export const T0 = Date.UTC(2026, 8, 30, 12, 0, 0);

let clock = T0;
/** Each read of the clock moves it 1 ms, so two records never share a timestamp by accident. */
const tick = () => clock++;
/** Jump the clock (a scenario that needs "a day later"). Never moves it backwards. */
export function setClock(ms) {
  if (ms > clock) clock = ms;
}
export const now = () => clock;

const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(tick());
    else super(...args);
  }
  static now() {
    return tick();
  }
}
globalThis.Date = FixedDate;

// mulberry32: small, seedable, good enough for ids and jitter.
let seed = 0x9e3779b9;
Math.random = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

let uuidCounter = 0;

/**
 * Back to the starting clock, seed and id counter. The generator calls it before each fixture, so one
 * fixture's bytes do not depend on what the fixtures written before it did.
 */
export function resetDeterminism() {
  clock = T0;
  seed = 0x9e3779b9;
  uuidCounter = 0;
}
crypto.randomUUID = () => {
  const n = (++uuidCounter).toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${n}`;
};
if (globalThis.crypto && typeof globalThis.crypto === 'object') {
  try {
    Object.defineProperty(globalThis.crypto, 'randomUUID', { value: crypto.randomUUID, configurable: true });
  } catch {
    // A read-only webcrypto: GNL imports randomUUID from node:crypto, which is patched above.
  }
}
syncBuiltinESMExports();
