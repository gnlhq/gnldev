// The built library (`@gnldev/durable`) as `Mods`, for tests that run in this process.
import { sqliteLiveness, postgresLiveness } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { LibsqlStorage } from '@gnldev/durable/libsql';
import { PostgresStorage } from '@gnldev/durable/postgres';
import { MysqlStorage, mysqlLiveness } from '@gnldev/durable/mysql';
import { MongoStorage, mongoLiveness } from '@gnldev/durable/mongo';
import type { Mods } from './stores.js';

export const distMods: Mods = { SqliteStorage, LibsqlStorage, PostgresStorage, MysqlStorage, MongoStorage, sqliteLiveness, postgresLiveness, mysqlLiveness, mongoLiveness };
