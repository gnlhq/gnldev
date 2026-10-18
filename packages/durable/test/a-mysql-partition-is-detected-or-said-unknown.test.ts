// How long a MySQL-family server takes to let go of a cut-off process's lock, as far as a client can know.
//
// The server frees a process lock when it ends the holder's session, and it ends the session of a host
// that is cut off (not crashed) only when TCP keepalive gives up: the server host's
// net.ipv4.tcp_keepalive_* (Linux default: 2 h + 75 s x 9), or, on MariaDB, its tcp_keepalive_*
// variables when set. Measured (raporlar 2026-10-18-mysql-impl, ka-*.json): with 10 / 5 / 3 the lock went
// in ~25.6 s on both servers; with the defaults it was still held after 120 s. A client cannot read the
// operating system's setting, so the store says so instead of guessing — and warns only on what it can
// read: MariaDB variables set to a long detection.
//
// Runs with GNL_MYSQL_URL / GNL_MARIADB_URL. The MariaDB cases change the server's GLOBAL keepalive
// variables (they apply to connections accepted afterwards) and put them back.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { MysqlStorage } from '../src/mysql-storage.js';
import { MYSQL_SERVERS, freshDatabase } from './real-backends.js';

type Conn = { query(sql: string): Promise<[any[], unknown]>; end(): Promise<void> };
const mysql = () => createRequire(import.meta.url)('mysql2/promise') as { createConnection(uri: string): Promise<Conn> };

afterEach(() => vi.restoreAllMocks());

// Without a server the file still has a suite, skipped (a file with none is an error to vitest).
describe.skipIf(!MYSQL_SERVERS.length)('partition detection on a MySQL-family server', () => {
  for (const { name, url } of MYSQL_SERVERS) {
    describe(`partition detection, as a client can know it — ${name}`, () => {
      const open = async () => new MysqlStorage({ connectionString: await freshDatabase(url) });
      const isMaria = async () => {
        const c = await mysql().createConnection(url);
        try { return /mariadb/i.test(String((await c.query('SELECT VERSION() AS v'))[0][0].v)); } finally { await c.end(); }
      };
      /** Sets the MariaDB keepalive variables for `fn`, then puts back what was there. */
      const withKeepalive = async (time: number, interval: number, probes: number, fn: () => Promise<void>) => {
        const c = await mysql().createConnection(url);
        const [before] = await c.query(`SELECT @@global.tcp_keepalive_time AS t, @@global.tcp_keepalive_interval AS i, @@global.tcp_keepalive_probes AS p`);
        const set = (t: number, i: number, p: number) => c.query(`SET GLOBAL tcp_keepalive_time = ${t}, GLOBAL tcp_keepalive_interval = ${i}, GLOBAL tcp_keepalive_probes = ${p}`);
        try { await set(time, interval, probes); await fn(); } finally { await set(before[0].t, before[0].i, before[0].p); await c.end(); }
      };

      it('the report says how long a cut-off process holds its runs, or that it cannot be read from here', async () => {
        const s = await open();
        try {
          const r = await s.durabilityReport();
          if (await isMaria()) {
            // The servers this suite runs on leave the variables at 0: the operating system decides.
            expect(r.partitionDetection.source).toMatch(/operating system|server variables/);
          } else {
            expect(r.partitionDetection).toEqual({ seconds: null, source: 'operating system' });
          }
          if (r.partitionDetection.seconds === null) {
            expect(r.notes.join('\n')).toMatch(/net\.ipv4\.tcp_keepalive_time/);
            expect(r.notes.join('\n')).toMatch(/cannot be read by a client/);
          }
        } finally { await s.close(); }
      });

      it('MariaDB with keepalive variables of 10 / 5 / 3: 25 s, read from the server, no warning at boot', async () => {
        if (!(await isMaria())) return;           // MySQL has no such variables
        await withKeepalive(10, 5, 3, async () => {
          const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
          const s = await open();
          try {
            await s.init();
            expect((await s.durabilityReport()).partitionDetection).toEqual({ seconds: 25, source: 'server variables' });
            expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => /keepalive/.test(m))).toEqual([]);
          } finally { await s.close(); }
        });
      });

      it('MariaDB with keepalive variables of 7200 / 75 / 9: the boot warns, naming the variable and the time', async () => {
        if (!(await isMaria())) return;
        await withKeepalive(7200, 75, 9, async () => {
          const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
          const s = await open();
          try {
            await s.init();
            expect((await s.durabilityReport()).partitionDetection).toEqual({ seconds: 7875, source: 'server variables' });
            const said = warn.mock.calls.map((c) => String(c[0])).filter((m) => /keepalive/.test(m));
            expect(said).toHaveLength(1);
            expect(said[0]).toMatch(/tcp_keepalive_time/);
            expect(said[0]).toMatch(/7875 s/);
          } finally { await s.close(); }
        });
      });
    });
  }
});
