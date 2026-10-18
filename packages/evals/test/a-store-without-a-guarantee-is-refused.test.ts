// The datasets manager keeps experiments in the run store: one without the store's guarantees is refused
// when the manager is made, naming what it lacks (it used to check `listKeys` alone).
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, JOURNAL_GUARANTEES, type Journal } from '@gnldev/durable';
import { createDatasetsManager } from '../src/datasets-manager.js';

function without(missing: string): Journal {
  const inner = new InMemoryJournal();
  return new Proxy(inner, {
    get(t, k) { if (k === missing) return undefined; const v = Reflect.get(t, k, t); return typeof v === 'function' ? v.bind(t) : v; },
    has(t, k) { return k === missing ? false : Reflect.has(t, k); },
  }) as never;
}

describe('createDatasetsManager refuses a store without a guarantee', () => {
  for (const missing of JOURNAL_GUARANTEES) {
    it(`without \`${missing}\`: refused, naming it`, () => {
      expect(() => createDatasetsManager(without(missing))).toThrow(`\`${missing}\``);
    });
  }
  it('control: a complete store is accepted', () => { expect(() => createDatasetsManager(new InMemoryJournal())).not.toThrow(); });
});
