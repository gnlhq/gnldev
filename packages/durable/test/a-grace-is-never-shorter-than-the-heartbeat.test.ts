// `reconnectGraceMs` is never shorter than the liveness's `heartbeatMs`.
//
// The grace is the time a live process has to take its lock back after its session ends
// (a-cut-session-keeps-its-call). A session that ends silently is noticed by the process only at its next
// heartbeat, so a shorter grace reads a live process as dead before it can know it lost anything — and
// its call runs beside it. `reconnectGraceMs: 0` did exactly that: the old reading, 2 effects in 5 of 5
// rounds (raporlar/2026-10-18-session-cut). Each factory refuses it before it connects.
import { describe, it, expect } from 'vitest';
import { postgresLiveness } from '../src/process-liveness.js';
import { mysqlLiveness } from '../src/mysql-storage.js';
import { mongoLiveness } from '../src/mongo-storage.js';

const factories = [
  ['postgresLiveness', (o: { reconnectGraceMs?: number; heartbeatMs?: number }) => postgresLiveness({ connectionString: 'postgres://nobody@127.0.0.1:1/none', ...o })],
  ['mysqlLiveness', (o: { reconnectGraceMs?: number; heartbeatMs?: number }) => mysqlLiveness({ connectionString: 'mysql://nobody@127.0.0.1:1/none', ...o })],
  ['mongoLiveness', (o: { reconnectGraceMs?: number; heartbeatMs?: number }) => mongoLiveness({ connectionString: 'mongodb://127.0.0.1:1/none', ...o })],
] as const;

describe('reconnectGraceMs is never shorter than heartbeatMs', () => {
  for (const [name, open] of factories) {
    it(`${name}: 0 is refused`, async () => {
      await expect(open({ reconnectGraceMs: 0 })).rejects.toThrow(/reconnectGraceMs must be at least heartbeatMs/);
    });
    it(`${name}: a grace under the heartbeat is refused`, async () => {
      await expect(open({ reconnectGraceMs: 999, heartbeatMs: 1_000 })).rejects.toThrow(/reconnectGraceMs must be at least heartbeatMs \(1000 ms\); got 999/);
    });
    it(`${name}: a grace equal to the heartbeat passes the check`, async () => {
      // Passes the option check and fails only on the unreachable server.
      await expect(open({ reconnectGraceMs: 1_000, heartbeatMs: 1_000 })).rejects.not.toThrow(/reconnectGraceMs/);
    });
  }
});
