// A process that starts turn t1 and is killed (SIGKILL) inside the tool body. Env: BACKEND, DB, EFFECTS, CALLS (1|2).
import { buildApi, openStorage, runRequest, turnBody } from './lib.js';
const env = process.env;
const storage = await openStorage(env.BACKEND ?? 'sqlite', env.DB!);
const api = buildApi(storage, env.EFFECTS!, 'crash', Number(env.CALLS ?? 1), Number(env.KILL_AFTER_MS ?? 0));
const res = await api(runRequest('run', turnBody()));
console.log('SURVIVED', res.status, (await res.text()).slice(0, 300));
process.exit(0);
