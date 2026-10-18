#!/usr/bin/env node
// How long a MongoDB replica set keeps a cut-off process's runs — measured, not assumed. A local probe: it
// needs Docker (a network it can disconnect a container from), so it is not part of CI.
//
// A holder, in its own container on a Docker network, takes a side-effect call's claim and stays in the
// body; this process (B, on the host) tries the same call every second and watches the holder's liveness
// connection (`$currentOp`, by its appName).
//   partition  the holder's container is disconnected from the network (its kernel answers nothing):
//              when the server drops the connection, when B takes over; 1 effect. The holder is then
//              connected again: its old id must not come back, and its liveness must not confirm.
//   stall      the holder is SIGSTOPped for <seconds>, then continued: B must never take over (the
//              holder's kernel still answers keepalives); the holder finishes; 1 effect.
//   kill       stall's falsifier: the holder is killed, B takes over at once.
//
// Setup (a single-node replica set on a network the holder joins, its port published for B; the root
// password must be `t`):
//   pnpm -r build
//   docker network create gnl-ka-net
//   docker run --rm -d --name mo-ka --network gnl-ka-net -p 127.0.0.1:37117:27017 \
//     --sysctl net.ipv4.tcp_keepalive_time=10 --sysctl net.ipv4.tcp_keepalive_intvl=5 \
//     --sysctl net.ipv4.tcp_keepalive_probes=3 mongo:8.0 --replSet rs0 --bind_ip_all
//   docker exec mo-ka mongosh --quiet --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"mo-ka:27017"}]})'
//   node scripts/mongo-partition-probe.mjs mo-ka 37117 partition 120 3
// (No access control on this throwaway server: every connection is visible to every other.)
// Measured on 18 Oct 2026 (raporlar/2026-10-18-mongo-impl): ~13–14 s with 10 / 5 / 3.
if (process.argv[2] === '--holder') {
  const [, root, uri, runId, bodyS] = process.argv.slice(2);
  const durable = await import(`${root}/packages/durable/dist/index.js`);
  const { MongoStorage } = await import(`${root}/packages/durable/dist/mongo-storage.js`);
  const s = new MongoStorage({ connectionString: uri });
  await s.init();
  const liveness = await s.processLiveness();
  console.log(`LIVENESS ${liveness.id}`);
  // After a partition heals: the id this process holds now, and whether it would start anything.
  setInterval(async () => { console.log(`NOW ${liveness.id || '-'} ${await liveness.confirm(0).catch(() => false)}`); }, 1000).unref();
  const bodyMs = Number(bodyS);
  const tool = {
    description: 'charge', sideEffect: true, claimTtlMs: 1500, recover: async () => ({ done: false }),
    execute: async () => {
      console.log('IN');
      await new Promise((r) => { if (bodyMs >= 0) setTimeout(r, bodyMs); });
      await s.runs.incrBy(`effects:${runId}`, { n: 1 });
      return { by: 'A' };
    },
  };
  const out = await durable.durableTool(tool, { journal: s.runs, runId }, 'charge').execute({ amount: 1 }, { toolCallId: 'c1' }).catch((e) => `ERR ${e?.name}`);
  console.log('OUT ' + JSON.stringify(out));
  await s.close();
  process.exit(0);
}

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const [server, port, mode, secondsS, roundsS] = process.argv.slice(2);
const durable = await import(`${root}/packages/durable/dist/index.js`);
const { MongoStorage } = await import(`${root}/packages/durable/dist/mongo-storage.js`);
const { MongoClient } = createRequire(`${root}/packages/durable/package.json`)('mongodb');
const docker = (...a) => execFileSync('docker', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const limitMs = Number(secondsS) * 1000;
const hostUrl = `mongodb://127.0.0.1:${port}/gnl?directConnection=true`;
const b = new MongoStorage({ connectionString: hostUrl });
await b.init();
const watcher = new MongoClient(hostUrl);
const alive = async (id) => (await watcher.db('admin').aggregate([{ $currentOp: { allUsers: true, idleConnections: true } }, { $match: { appName: id } }, { $limit: 1 }]).toArray()).length > 0;
const holder = 'gnl-ka-holder';
const holderUrl = `mongodb://${server}:27017/gnl?directConnection=true`;
const rows = [];
for (let round = 0; round < Number(roundsS); round++) {
  const runId = `ka-${mode}-${Date.now()}-${round}`;
  try { docker('rm', '-f', holder); } catch { /* none */ }
  docker('run', '-d', '--name', holder, '--network', 'gnl-ka-net', '-v', `${root}:${root}:ro`, 'node:22-slim',
    'node', `${root}/scripts/mongo-partition-probe.mjs`, '--holder', root, holderUrl, runId, mode === 'stall' ? '1000' : '-1');
  let logs = '';
  for (let i = 0; !logs.includes('IN') && i < 600; i++) { await sleep(100); logs = docker('logs', holder); }
  if (!logs.includes('IN')) { rows.push({ round, error: 'holder never entered the body', logs }); continue; }
  const id = /LIVENESS (\S+)/.exec(logs)[1];
  const t0 = performance.now();
  if (mode === 'partition') docker('network', 'disconnect', 'gnl-ka-net', holder);
  if (mode === 'stall') docker('kill', '--signal=SIGSTOP', holder);
  if (mode === 'kill') docker('kill', holder);
  const stateOf = () => { try { return docker('exec', holder, 'sh', '-c', 'grep State /proc/1/status').trim(); } catch { return 'n/a'; } };
  const stopped = mode === 'stall' ? stateOf() : undefined;
  let releasedMs; let takeoverMs; let attempts = 0; let busy = 0; let lastAttempt = -Infinity;
  const tool = { description: 'charge', sideEffect: true, claimTtlMs: 1500, recover: async () => ({ done: false }),
    execute: async () => { await b.runs.incrBy(`effects:${runId}`, { n: 1 }); return { by: 'B' }; } };
  while (performance.now() - t0 < limitMs && takeoverMs === undefined) {
    if (releasedMs === undefined && !(await alive(id))) releasedMs = Math.round(performance.now() - t0);
    if (performance.now() - lastAttempt >= 1000) {
      lastAttempt = performance.now();
      attempts++;
      const out = await durable.durableTool(tool, { journal: b.runs, runId }, 'charge').execute({ amount: 1 }, { toolCallId: 'c1' }).catch((e) => `ERR ${e?.name}`);
      if (typeof out === 'object') takeoverMs = Math.round(performance.now() - t0); else busy++;
    }
    await sleep(250);
  }
  let holderOut = 'cut off / killed';
  let healed;
  if (mode === 'partition') {
    // Back on the network: the old id must stay dead, and the holder must not confirm under it.
    docker('network', 'connect', 'gnl-ka-net', holder);
    await sleep(20_000);
    const lines = docker('logs', holder).split('\n').filter((l) => l.startsWith('NOW '));
    const after = lines.slice(-5);
    healed = { oldIdAliveAgain: await alive(id), confirmedUnderOldId: after.some((l) => l === `NOW ${id} true`), last: after.at(-1) };
  }
  if (mode === 'stall') {
    docker('kill', '--signal=SIGCONT', holder);
    for (let i = 0; i < 300 && !/OUT /.test(docker('logs', holder)); i++) await sleep(100);
    holderOut = (/OUT (.*)/.exec(docker('logs', holder)) ?? [, 'none'])[1];
  }
  await sleep(500);
  const effects = (await durable.toJournal(b.runs).getCounters(`effects:${runId}`))?.n ?? 0;
  try { docker('rm', '-f', holder); } catch { /* gone */ }
  rows.push({ round, releasedMs: releasedMs ?? `not within ${secondsS}s`, takeoverMs: takeoverMs ?? `not within ${secondsS}s`, attempts, busy, effects, holderOut, ...(stopped ? { stopped } : {}), ...(healed ? { healed } : {}) });
  console.error(JSON.stringify(rows.at(-1)));
}
console.log(JSON.stringify({ server, mode, limitS: Number(secondsS), rows }));
await watcher.close();
await b.close();
process.exit(0);
