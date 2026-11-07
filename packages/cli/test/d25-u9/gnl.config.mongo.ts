import { MongoStorage } from '@gnldev/durable/mongo';
export default { storage: new MongoStorage({ connectionString: process.env.GNL_MONGO_URL! }), agents: {} };
