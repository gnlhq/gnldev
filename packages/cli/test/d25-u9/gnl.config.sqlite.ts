import { SqliteStorage } from '@gnldev/durable/sqlite';
export default { storage: new SqliteStorage(':memory:'), agents: {} };
