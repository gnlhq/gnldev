// Audit D (red): a SQL_ASCII Postgres whose collation is linguistic (a superuser may create one:
// `CREATE DATABASE … ENCODING 'SQL_ASCII' LC_COLLATE 'en_US.utf8'`). The boot probe that decides whether
// prefix ranges need COLLATE "C" uses U&'\FFFF', which a non-UTF8 database rejects; the error is read as
// "byte ordered", so every range scan (listKeys, readRange, deletePrefix) runs under en_US and matches
// almost nothing: `'org:a:x' < 'org:a;'` is false there.
import { describe, it, expect, afterAll } from 'vitest';
import { PostgresStorage } from '../src/postgres-storage.js';
import { createRequire } from 'node:module';

const URL0 = process.env.GNL_PG_URL;
const NAME = `ad_ascii_en_${process.pid}`;
const require = createRequire(import.meta.url);

async function admin(sql: string) {
  const pg = require('pg');
  const c = new pg.Client({ connectionString: URL0 });
  await c.connect();
  try { await c.query(sql); } finally { await c.end(); }
}

describe.skipIf(!URL0)('prefix ranges on a SQL_ASCII database with a linguistic collation', () => {
  let s: PostgresStorage | undefined;
  afterAll(async () => { await (s as any)?._pool?.end?.(); await admin(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`); });

  it('listKeys, readRange and deletePrefix see every key under the prefix', async () => {
    await admin(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
    await admin(`CREATE DATABASE ${NAME} ENCODING 'SQL_ASCII' LC_COLLATE 'en_US.utf8' LC_CTYPE 'en_US.utf8' TEMPLATE template0`);
    const u = new URL(URL0!); u.pathname = `/${NAME}`;
    s = new PostgresStorage({ connectionString: u.toString() });
    await s.init();
    const j = s.runs as any;
    await j.put('org:acme:r1:input', { a: 1 });
    await j.put('org:acme:r1:ev:0001', { e: 1 });
    await j.put('org:acme:r1:ev:0002', { e: 2 });
    const listed = await j.listKeys('org:acme:');
    const events = await j.readRange('org:acme:r1:ev:', { limit: 10 });
    const deleted = await j.deletePrefix('org:acme:');
    const left = await j.get('org:acme:r1:input');
    expect({ listed: listed.length, events: events.length, deleted, left }).toEqual({ listed: 3, events: 2, deleted: 3, left: undefined });
  });
});
