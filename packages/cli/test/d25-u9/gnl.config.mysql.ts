import { MysqlStorage } from '@gnldev/durable/mysql';
export default { storage: new MysqlStorage({ connectionString: process.env.GNL_MYSQL_URL! }), agents: {} };
