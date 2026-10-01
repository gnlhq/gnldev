#!/usr/bin/env node
// Writes the 0.9.0 fixtures: databases as 0.9.0 left them, which the tests in ../test/from-0.9.0 open
// with the current code. See ../README.md for when and how to run this.
//
//   node generate/0.9.0.mjs                      # SQLite fixtures, 0.9.0 installed from npm into a temp dir
//   GNL_090_ROOT=/path/to/0.9.0 node generate/0.9.0.mjs
//   GNL_PG_URL=postgres://… GNL_PG_DUMP='docker exec -i pg pg_dump' node generate/0.9.0.mjs --backend postgres
//   GNL_REDIS_URL=redis://… node generate/0.9.0.mjs --backend redis
//
// GNL_090_ROOT is either a checkout of the 0.9.0 tag, built (`<root>/packages/<name>/dist`), or a
// directory where the published packages are installed (`<root>/node_modules/@gnldev/<name>/dist`).
//
// The clock, Math.random and randomUUID are fixed (./deterministic.mjs), so a second run writes the
// same SQLite bytes; `--check` regenerates into a temp dir and compares with the committed files.
import { T0, resetDeterminism } from './deterministic.mjs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';
import * as S from './shapes.mjs';
import { assert090, install090, loader090 } from './load-0.9.0.mjs';
import { DatabaseSync } from 'node:sqlite';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const backend = flag('--backend') ?? 'sqlite';
const check = argv.includes('--check');
const outDir = resolve(flag('--out') ?? join(here, '..', 'fixtures', '0.9.0'));

// ── where 0.9.0 comes from ──────────────────────────────────────────────────────────────────────────
const root = process.env.GNL_090_ROOT ? resolve(process.env.GNL_090_ROOT) : install090();
assert090(root);
const load = loader090(root);
const m = {
  durable: await load('durable'),
  sqlite: await load('durable', 'sqlite-storage.js'),
  queue: await load('queue'),
  events: await load('events'),
  workflow: await load('workflow'),
  scheduler: await load('scheduler'),
  memory: await load('memory'),
  rag: await load('rag'),
  evals: await load('evals'),
  processors: await load('processors'),
};

/** What 0.9.0 did while writing each fixture, written beside it for the tests and for a human. */
const notes = {};
const pad = (n) => String(n).padStart(3, '0');

// ── scenarios ───────────────────────────────────────────────────────────────────────────────────────
// Each one takes a 0.9.0 Storage and leaves it in the state the tests start from.

async function queueScenario(s, { eraseOn090 = false } = {}) {
  const { enqueue, createWorker } = m.queue;
  const ran = [];
  for (let i = 0; i < S.QUEUE.ayseJobs; i++) await enqueue(s.work, 'plain', { n: `a${i}` }, { id: `a${i}`, resourceId: 'ayse' });
  for (let i = 0; i < S.QUEUE.plainJobs; i++) await enqueue(s.work, 'plain', { n: `p${pad(i)}` }, { id: `p${pad(i)}` });
  const w = createWorker(s, { plain: async (p) => { ran.push(p.n); } }, { owner: 'w-090', maxAttempts: 2, heartbeat: false });
  for (let i = 0; i < S.QUEUE.ayseJobs + S.QUEUE.plainDoneOn090; i++) await w.runOnce();
  for (let i = 0; i < S.QUEUE.carolJobs; i++) await enqueue(s.work, 'plain', { n: `c${i}` }, { id: `c${i}`, resourceId: 'carol' });
  if (eraseOn090) {
    // ayse erased on 0.9.0, before the upgrade: her 40 rows leave the log under 0.9.0's row-offset cursor.
    const report = await m.durable.eraseSubject(s, 'ayse', { erasers: [m.queue.jobEraser(s)] });
    notes.queueErasedOn090 = { erase: report, qcursor: await s.work.get('qcursor'), jobs: (await m.queue.listJobs(s.work)).map((j) => `${j.id}:${j.status}`) };
    return;
  }
  notes.queue = { ranOn090: ran, qcursor: await s.work.get('qcursor'), jobs: (await m.queue.listJobs(s.work)).map((j) => `${j.id}:${j.status}`) };
}

async function deadLetterScenario(s) {
  const state = { crash: true };
  const charges = [];
  const w = m.queue.createWorker(s, {
    pay: async (_p, ctx) => {
      await ctx.run({
        model: S.toolThenTextModel({ toolName: S.DEAD.toolName, input: { amount: 20 }, state }),
        tools: { [S.DEAD.toolName]: { description: 'charge', execute: async () => { charges.push(ctx.runId); return { charged: 20 }; } } },
        prompt: 'pay the order',
      });
    },
  }, { owner: 'w-090', maxAttempts: 2, heartbeat: false });
  const ids = [];
  for (const id of S.DEAD.ids) ids.push(await m.queue.enqueue(s.work, 'pay', { order: id }, { id, resourceId: S.DEAD.owner }));
  await w.drain();
  // The operator retried dl2 on 0.9.0: a new job with no link to the dead letter's run, still pending.
  const copy = await m.queue.retryJob(s.work, ids[1]);
  notes.deadLetters = { ids, copy, chargesOn090: charges, jobs: (await m.queue.listJobs(s.work)).map((j) => `${j.id}:${j.status}`) };
}

async function eventsScenario(s, { eraseOn090 = false } = {}) {
  const { emit, createConsumer } = m.events;
  const E = S.EVENTS;
  const seen = [];
  for (let i = 0; i < E.ayseEvents; i++) await emit(s.work, E.topic, { n: `a${i}` }, { id: `a${i}`, resourceId: 'ayse' });
  for (let i = 0; i < E.deliveredOn090; i++) await emit(s.work, E.topic, { n: `e${pad(i)}` }, { id: `e${pad(i)}` });
  const c = createConsumer(s.work, E.topic, async (p) => { seen.push(p.n); }, { name: E.consumer });
  await c.poll();
  for (let i = E.deliveredOn090; i < E.deliveredOn090 + E.pendingAfter; i++) await emit(s.work, E.topic, { n: `e${pad(i)}` }, { id: `e${pad(i)}` });
  for (let i = 0; i < E.carolPending; i++) await emit(s.work, E.topic, { n: `c${i}` }, { id: `c${i}`, resourceId: 'carol' });
  if (eraseOn090) {
    const report = await m.durable.eraseSubject(s, 'ayse', { erasers: [m.events.eventEraser(s.work)] });
    notes.eventsErasedOn090 = { erase: report, cursor: await s.work.get(`evtcursor:${E.topic}:${E.consumer}`) };
    return;
  }
  await emit(s.work, E.poisonTopic, { n: 'poison' }, { id: E.poisonId });
  const c2 = createConsumer(s.work, E.poisonTopic, async () => { throw new Error('handler bug (fixture)'); }, { name: E.poisonConsumer, maxAttempts: 1, retryDelayMs: 0 });
  await c2.poll();
  await c2.poll();
  notes.events = {
    deliveredOn090: seen,
    cursor: await s.work.get(`evtcursor:${E.topic}:${E.consumer}`),
    dead: (await m.events.listDeadEvents(s.work, E.poisonTopic, E.poisonConsumer)).map((d) => d.id ?? d.eventId),
  };
}

async function workflowScenario(s) {
  const j = m.durable.toJournal(s.runs);
  const calls = [];
  const a = await S.voidWorkflow(m.workflow, calls).runResumable(1, { runId: S.WORKFLOW_RUNS.void, journal: j });
  const b = await S.nestedWorkflow(m.workflow, calls).runResumable(2, { runId: S.WORKFLOW_RUNS.nested, journal: j });
  notes.workflow = {
    callsOn090: calls,
    results: [a, b].map((r) => r.status ?? r),
    keys: { void: await j.listKeys(`${S.WORKFLOW_RUNS.void}:`), nested: await j.listKeys(`${S.WORKFLOW_RUNS.nested}:`) },
  };
}

async function schedulerScenario(s) {
  const j = m.durable.toJournal(s.runs);
  const registered = {};
  for (const spec of S.SCHEDULES) {
    try {
      registered[spec.id] = await m.scheduler.scheduleWorkflow(j, spec, S.SCHED_T0);
    } catch (e) {
      registered[spec.id] = `threw: ${e.message}`;
    }
  }
  const fired = [];
  let pollError;
  try {
    await m.scheduler.pollScheduler(j, { runWorkflow: async (name, _in, o) => { fired.push(`${name}@${o?.runId}`); return { runId: o?.runId ?? 'x' }; } }, S.SCHED_T0 + 1500);
  } catch (e) {
    pollError = e.message;
  }
  notes.scheduler = { registered, firedOn090: fired, pollError, keys: await j.listKeys('sched:') };
}

async function memoryScenario(s) {
  const { AgentMemory } = m.memory;
  const M = S.MEMORY;
  const mark = (what) => `${S.U1_MARK}-${what}`;
  const plain = new AgentMemory({ storage: s, embed: S.fixtureEmbed });
  await plain.createThread({ id: M.rootThread, resourceId: 'u1' });
  await plain.append(M.rootThread, [{ role: 'user', content: `${mark('ROOT')} hello` }, { role: 'assistant', content: 'hi u1' }]);
  for (const id of M.orgPrefixedRootThreads) {
    await plain.createThread({ id, resourceId: 'u1' });
    await plain.append(id, [{ role: 'user', content: `${mark('ORGPREFIX')} in ${id}` }]);
  }
  await plain.createThread({ id: M.otherUserThread, resourceId: 'u2' });
  await plain.append(M.otherUserThread, [{ role: 'user', content: 'U2-KEEP hello' }]);

  const orgStorage = m.durable.withOrgStorage(s, M.orgId);
  const org = new AgentMemory({ storage: orgStorage, embed: S.fixtureEmbed });
  await org.createThread({ id: M.orgThread, resourceId: 'u1' });
  await org.append(M.orgThread, [{ role: 'user', content: `${mark('ACME')} org hello` }]);
  // acme's run-backed thread (acme's own owner record) and a memory-only one; then a ROOT request names
  // each by its physical id. 0.9.0 refuses it — and backfills a root owner record first.
  const { echoModel: echo } = await load('durable', 'mock-model.js');
  await m.durable.runDurable({
    runId: 'r-acme-run', journal: m.durable.toJournal(orgStorage.runs), model: echo(), prompt: `${mark('ACMERUN')} acme run`,
    memory: org, threadId: M.orgRunThread, resourceId: 'u1',
  });
  await org.createThread({ id: M.orgMemThread, resourceId: 'u1' });
  await org.append(M.orgMemThread, [{ role: 'user', content: `${mark('ACMEMEM')} acme memory only` }]);
  const refused = {};
  for (const t of [M.orgRunThread, M.orgMemThread]) {
    try {
      await m.durable.runDurable({
        runId: `r-intrude-${t}`, journal: m.durable.toJournal(s.runs), model: echo(), prompt: 'intruder asks',
        memory: plain, threadId: `org:${M.orgId}:${t}`, resourceId: M.intruder,
      });
      refused[t] = false;
    } catch (e) {
      refused[t] = e.name ?? 'Error';
    }
  }

  const wm = new AgentMemory({ storage: s, embed: S.fixtureEmbed, workingMemory: { scope: 'resource', template: '# Notes' } });
  await wm.createThread({ id: M.wmThread, resourceId: 'u1' });
  await wm.applyWorkingMemoryUpdate(M.wmThread, { note: mark('WM') }, 'u1');
  const wmThread = new AgentMemory({ storage: s, embed: S.fixtureEmbed, workingMemory: { scope: 'thread', template: '# Notes' } });
  await wmThread.setWorkingMemory(M.wmThread, `${mark('WMTHREAD')} thread notes`);

  const om = new AgentMemory({
    storage: s,
    embed: S.fixtureEmbed,
    observationalMemory: { enabled: true, observerModel: S.textModel(`- ${mark('OBS')} prefers tea`), observation: { messageThreshold: 4 } },
  });
  await om.createThread({ id: M.omThread, resourceId: 'u1' });
  for (let i = 0; i < 6; i++) await om.append(M.omThread, [{ role: i % 2 ? 'assistant' : 'user', content: `${mark('OM')} message ${i}` }]);
  await om.compact(M.omThread);

  const j = m.durable.toJournal(s.runs);
  const bm = new m.durable.BasicMemory(j);
  const sm = new m.rag.SemanticMemory({ journal: j, embed: S.fixtureEmbed });
  const { echoModel } = await load('durable', 'mock-model.js');
  await m.durable.runDurable({ runId: 'r-basic', journal: j, model: echoModel(), prompt: `${mark('BASIC')} my email is u1@example.com`, memory: bm, threadId: M.basicThread, resourceId: 'u1' });
  await m.durable.runDurable({ runId: 'r-sem', journal: j, model: echoModel(), prompt: `${mark('SEM')} semantic hello`, memory: sm, threadId: M.semanticThread, resourceId: 'u1' });
  await bm.append(M.basicOldThread, [{ role: 'user', content: 'old basic message', ts: M.oldTs }]);
  await sm.append(M.semanticOldThread, [{ role: 'user', content: 'old semantic message', ts: M.oldTs }]);
  notes.memory = {
    rootListThreads: (await plain.listThreads({ resourceId: 'u1' })).map((t) => t.id),
    observations: (await s.memory.getObservations(M.omThread)).map((o) => o.text),
    basicShape: Array.isArray(await j.get(`mem:${M.basicThread}:messages`)) ? 'array' : typeof (await j.get(`mem:${M.basicThread}:messages`)),
    intruderRefused: refused,
    ownerRecords: Object.fromEntries(await Promise.all((await j.listKeys('')).filter((k) => k.endsWith(':owner') && k.includes(`${M.orgId}:`)).sort().map(async (k) => [k, await j.get(k)]))),
  };
}

async function ragScenario(s) {
  const docs = m.rag.chunkDocuments(S.RAG_DOCS, S.RAG_CHUNK);
  // One document at a time, in order, so `x#1` lands after `x` (and overwrites x's chunk 1, as on 0.9.0).
  for (const d of docs) await m.rag.indexDocuments(s.vectors, S.fixtureEmbed, [d]);
  await m.rag.indexDocuments(s.vectors, S.fixtureEmbed, S.RAG_RAW);
  notes.rag = { ids: s.db.prepare('SELECT id, metadata FROM gnl_vectors ORDER BY id').all().map((r) => `${r.id} ${r.metadata}`) };
}

async function evalsScenario(s) {
  const j = m.durable.toJournal(s.runs);
  const { echoModel } = await load('durable', 'mock-model.js');
  await m.durable.runDurable({ runId: S.EVAL.runId, journal: j, model: echoModel(), prompt: S.EVAL.prompt });
  const judgeCalls = { n: 0 };
  const r = await m.evals.scoreRun(j, S.EVAL.runId, [m.evals.answerRelevancy({ model: S.textModel(S.EVAL.judgeText, judgeCalls) }), m.evals.contains('France')]);
  notes.evals = { scoresOn090: r.scores ?? r, judgeCallsOn090: judgeCalls.n, keys: await j.listKeys(`${S.EVAL.runId}:proc:`) };
}

async function piiScenario(s) {
  const j = m.durable.toJournal(s.runs);
  const state = { crash: true };
  const executed = [];
  let error;
  try {
    await m.durable.runDurable({
      runId: S.PII.runId,
      journal: j,
      resourceId: S.PII.resourceId,
      model: S.toolThenTextModel({ toolName: S.PII.toolName, input: { who: S.PII.resourceId }, state }),
      tools: { [S.PII.toolName]: { description: 'lookup', execute: async () => { executed.push(1); return { ...S.PII.toolResult }; } } },
      processors: [m.processors.piiRedactor({ redactToolResults: true })],
      prompt: 'look the customer up',
    });
  } catch (e) {
    error = e.message;
  }
  const rows = s.db.prepare('SELECT key, value FROM gnl_run_journal').all().filter((r) => String(r.value).includes(S.PII.email)).map((r) => r.key);
  notes.pii = { executedOn090: executed.length, error, keysHoldingPlainEmail: rows };
}

// ── SQLite ──────────────────────────────────────────────────────────────────────────────────────────
const SQLITE = {
  'queue.db': queueScenario,
  'queue-erased.db': (s) => queueScenario(s, { eraseOn090: true }),
  'queue-dead.db': deadLetterScenario,
  'events.db': eventsScenario,
  'events-erased.db': (s) => eventsScenario(s, { eraseOn090: true }),
  'workflow.db': workflowScenario,
  'scheduler.db': schedulerScenario,
  'memory.db': memoryScenario,
  'rag.db': ragScenario,
  'evals.db': evalsScenario,
  'pii.db': piiScenario,
};

async function writeSqlite(dir) {
  const work = mkdtempSync(join(tmpdir(), 'gnl-090-sqlite-'));
  mkdirSync(dir, { recursive: true });
  for (const [file, scenario] of Object.entries(SQLITE)) {
    resetDeterminism();
    const s = new m.sqlite.SqliteStorage(join(work, file));
    await scenario(s);
    // VACUUM INTO writes one self-contained file (no -wal/-shm) with a canonical page layout.
    const target = join(dir, file);
    rmSync(target, { force: true });
    s.db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    await s.close?.();
    // Smallest pages and no WAL: a fixture of a few dozen near-empty tables is KBs, not 128 KiB.
    const out = new DatabaseSync(target);
    out.exec('PRAGMA journal_mode = DELETE; PRAGMA page_size = 512; VACUUM;');
    out.close();
  }
  rmSync(work, { recursive: true, force: true });
}

// ── Postgres / Redis: the work store only (queue and events), where the stores differ ───────────────
/** `work`: as queue.db + events.db; `work-erased`: as queue-erased.db + events-erased.db (0.9.0 erased ayse). */
const WORK_VARIANTS = [['work', false], ['work-erased', true]];
async function workScenarios(s, eraseOn090) {
  resetDeterminism();
  await queueScenario(s, { eraseOn090 });
  resetDeterminism();
  await eventsScenario(s, { eraseOn090 });
}

async function writePostgres(dir) {
  const url = process.env.GNL_PG_URL;
  if (!url) throw new Error('--backend postgres needs GNL_PG_URL (a server where this may create and drop a database)');
  const dump = process.env.GNL_PG_DUMP ?? 'pg_dump';
  const { default: pg } = await import(pathToFileURL(join(root, 'node_modules', 'pg', 'lib', 'index.js')).href).catch(() => import('pg'));
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  const { PostgresStorage } = await load('durable', 'postgres-storage.js');
  for (const [name, eraseOn090] of WORK_VARIANTS) {
    const db = 'gnl_fixture_090';
    await admin.query(`DROP DATABASE IF EXISTS ${db}`);
    await admin.query(`CREATE DATABASE ${db}`);
    const u = new URL(url);
    u.pathname = `/${db}`;
    const s = new PostgresStorage({ connectionString: u.toString() });
    await s.init();
    await workScenarios(s, eraseOn090);
    await s.close();
    // Plain SQL, no owner or privilege statements, so it loads into any database as any role.
    const sql = execSync(`${dump} --no-owner --no-privileges --no-comments --inserts --rows-per-insert=1 -U ${u.username || 'postgres'} ${db}`, { encoding: 'utf8', maxBuffer: 64 << 20 });
    await admin.query(`DROP DATABASE IF EXISTS ${db}`);
    // Drop what varies between pg_dump versions and runs but carries no data.
    const kept = sql.split('\n').filter((l) => !/^(--|SET |SELECT pg_catalog\.set_config|\\restrict|\\unrestrict)/.test(l)).join('\n').replace(/\n{3,}/g, '\n\n');
    writeFileSync(join(dir, `postgres-${name}.sql`), `-- Written by packages/upgrade-tests/generate/0.9.0.mjs --backend postgres. Do not edit.\n${kept.trim()}\n`);
  }
  await admin.end();
}

async function writeRedis(dir) {
  const url = process.env.GNL_REDIS_URL;
  if (!url) throw new Error('--backend redis needs GNL_REDIS_URL');
  const { default: Redis } = await import(pathToFileURL(join(root, 'node_modules', 'ioredis', 'built', 'index.js')).href).catch(() => import('ioredis'));
  const prefix = 'gnlfx090:';
  const client = new Redis(url);
  for (const [name, eraseOn090] of WORK_VARIANTS) {
    const old = await client.keys(`${prefix}*`);
    if (old.length) await client.del(...old);
    const s = new m.durable.RedisStorage({ client, keyPrefix: prefix });
    await workScenarios(s, eraseOn090);
    // Every key under the prefix, with its type and value, prefix stripped: loadable under any prefix.
    const keys = (await client.keys(`${prefix}*`)).sort();
    const out = [];
    for (const key of keys) {
      const type = await client.type(key);
      const k = key.slice(prefix.length);
      if (type === 'string') out.push({ k, type, v: await client.get(key) });
      else if (type === 'hash') out.push({ k, type, v: Object.fromEntries(Object.entries(await client.hgetall(key)).sort(([a], [b]) => (a < b ? -1 : 1))) });
      else if (type === 'zset') {
        // Scores here are the SERVER's clock (Lua TIME), which the fixed clock cannot reach: kept as
        // order only (T0 + rank), so the dump is stable and every member keeps its place.
        const members = await client.zrange(key, 0, -1);
        const v = members.map((member, rank) => [member, String(T0 + rank)]);
        out.push({ k, type, v });
      } else if (type === 'list') out.push({ k, type, v: await client.lrange(key, 0, -1) });
      else if (type === 'set') out.push({ k, type, v: (await client.smembers(key)).sort() });
      else throw new Error(`unexpected Redis type ${type} at ${key}`);
      const ttl = await client.pttl(key);
      if (ttl > 0) out.at(-1).ttl = true;
    }
    await client.del(...keys);
    writeFileSync(join(dir, `redis-${name}.json`), `${JSON.stringify({ writtenBy: 'packages/upgrade-tests/generate/0.9.0.mjs --backend redis', keys: out }, null, 1)}\n`);
  }
  await client.quit();
}

// ── main ────────────────────────────────────────────────────────────────────────────────────────────
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const target = check ? mkdtempSync(join(tmpdir(), 'gnl-090-check-')) : outDir;
mkdirSync(target, { recursive: true });
if (backend === 'sqlite') await writeSqlite(target);
else if (backend === 'postgres') await writePostgres(target);
else if (backend === 'redis') await writeRedis(target);
else throw new Error(`unknown --backend ${backend} (sqlite | postgres | redis)`);

const notesFile = join(target, `notes-${backend}.json`);
writeFileSync(notesFile, `${JSON.stringify({ writtenBy: 'packages/upgrade-tests/generate/0.9.0.mjs', clockStart: new Date(T0).toISOString(), notes }, null, 1)}\n`);

if (check) {
  let diff = 0;
  for (const f of readdirSync(target)) {
    const committed = join(outDir, f);
    const same = existsSync(committed) && sha(committed) === sha(join(target, f));
    if (!same) diff++;
    console.log(`${same ? 'same   ' : 'DIFFERS'} ${f}`);
  }
  rmSync(target, { recursive: true, force: true });
  process.exit(diff ? 1 : 0);
}
for (const f of readdirSync(target)) console.log(`${sha(join(target, f)).slice(0, 12)}  ${f}`);
