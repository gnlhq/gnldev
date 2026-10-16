// `drainOnSignal` is installed once per process. A second call with OTHER options was answered with the
// first one's uninstaller and its options silently dropped — a second `onDrained` (closing a pool) never
// ran, a longer deadline was never waited (audit C hypothesis 7). Now: the same options return the same
// installation; other options are refused, with the way out (uninstall the first).
import { describe, it, expect } from 'vitest';
import { drainOnSignal } from '../src/drain.js';

describe('drainOnSignal installed twice', () => {
  it('the same options: the same installation', () => {
    const onDrained = async () => {};
    const off = drainOnSignal({ deadlineMs: 1_000, signals: ['SIGUSR2'], onDrained });
    try {
      expect(drainOnSignal({ deadlineMs: 1_000, signals: ['SIGUSR2'], onDrained })).toBe(off);
    } finally { off(); }
  });

  it('other options: refused, naming the way out — not silently dropped', () => {
    const off = drainOnSignal({ deadlineMs: 1_000, signals: ['SIGUSR2'] });
    try {
      expect(() => drainOnSignal({ deadlineMs: 5_000, signals: ['SIGUSR2'] })).toThrow(/already installed.*uninstall/i);
      expect(() => drainOnSignal({ deadlineMs: 1_000, signals: ['SIGUSR2'], onDrained: async () => {} })).toThrow(/already installed/i);
    } finally { off(); }
    // Uninstalled, it installs anew with the other options.
    const again = drainOnSignal({ deadlineMs: 5_000, signals: ['SIGUSR2'] });
    again();
  });
});
