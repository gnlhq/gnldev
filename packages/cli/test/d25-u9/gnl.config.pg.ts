import { PostgresStorage } from '@gnldev/durable/postgres';
export default { storage: new PostgresStorage({ connectionString: process.env.GNL_PG_URL! }), agents: {} };
