// AUDIT C fixture: holds a Sqlite process lock (argv: dbPath idPrefix) until killed. Writes the id it got
// (the prefix plus a part of its own, process-liveness.ts `livenessIdOf`) into its ready file.
import { appendFileSync } from 'node:fs';
import { sqliteLiveness } from '../../src/process-liveness.js';
const l = sqliteLiveness(process.argv[2]!, process.argv[3]!);
appendFileSync(`${process.argv[2]}.ready-${process.argv[3]}`, l.id);
setInterval(() => {}, 1 << 30);
