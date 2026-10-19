// Child process: opens and closes a MongoDB liveness <rounds> times, asking a second liveness right after
// each close whether the closed one is still alive; prints how many were.
//
//   argv: <url> <rounds>
import { armFixtureWatchdog } from './watchdog.js';
import { mongoLiveness } from '../../src/mongo-storage.js';

armFixtureWatchdog(110_000);
const [url, rounds] = process.argv.slice(2) as [string, string];
const other = await mongoLiveness({ connectionString: url });
let alive = 0;
for (let i = 0; i < Number(rounds); i++) {
  const mine = await mongoLiveness({ connectionString: url });
  if (!(await other.isAlive(mine.id))) throw new Error('a held liveness read dead');
  await mine.close();
  if (await other.isAlive(mine.id)) alive++;
}
await other.close();
process.stdout.write(`${alive}\n`);
