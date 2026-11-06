// The sources of `@gnldev/durable` as `Mods`, for the child processes of the takeover scenarios.
import { sqliteLiveness, postgresLiveness } from '../../../src/index.js';
import { SqliteStorage } from '../../../src/sqlite-storage.js';
import { LibsqlStorage } from '../../../src/libsql-storage.js';
import { PostgresStorage } from '../../../src/postgres-storage.js';
import { MysqlStorage, mysqlLiveness } from '../../../src/mysql-storage.js';
import { MongoStorage, mongoLiveness } from '../../../src/mongo-storage.js';
import type { Mods } from '../stores.js';

export const srcMods: Mods = { SqliteStorage, LibsqlStorage, PostgresStorage, MysqlStorage, MongoStorage, sqliteLiveness, postgresLiveness, mysqlLiveness, mongoLiveness };
