// Child process for a-thread-deleted-under-an-append-keeps-no-row.test.ts: one Sqlite file, several
// processes. `append` appends batches to thread T; `delete` deletes T over and over and, after each
// deletion, counts the rows of T that no batch marker names (rows a retract can never take back).
//   argv: <append|delete> <db file> <ms>
import { SqliteStorage } from '../../src/sqlite-storage.js';

const [role, file, ms] = process.argv.slice(2) as [string, string, string];
const s: any = new SqliteStorage(file);
const end = Date.now() + Number(ms);
const msg = (t: string) => ({ role: 'user', text: t, ts: Date.now(), message: { role: 'user', content: t } });
const unnamed = s.db.prepare(`SELECT count(*) AS n FROM gnl_messages m WHERE m.thread_id = 'T' AND NOT EXISTS
  (SELECT 1 FROM gnl_message_batches b WHERE b.thread_id = m.thread_id AND m.seq >= b.seq_from AND m.seq < b.seq_to)`);
let n = 0;
let unnamedSeen = 0;
while (Date.now() < end) {
  if (role === 'append') {
    try { await s.memory.appendMessagesOnce('T', [msg(`q${n}`), msg(`a${n}`)], `mem-appended:${process.pid}-${n}`); } catch { /* busy: the next one */ }
  } else {
    try { await s.memory.deleteThread('T'); } catch { /* busy: the next one */ }
    if (unnamed.get().n > 0) unnamedSeen++;
  }
  n++;
  if (n % 20 === 0) await new Promise((r) => setImmediate(r));
}
if (role === 'delete') process.stdout.write(JSON.stringify({ deletions: n, unnamedSeen }));
