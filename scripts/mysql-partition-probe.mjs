#!/usr/bin/env node
// How long a MySQL / MariaDB server keeps a cut-off process's runs — measured, not assumed. A local probe:
// it needs Docker (a network it can disconnect a container from), so it is not part of CI.
//
// A holder, in its own container on a Docker network, takes a side-effect call's claim and stays in the
// body; this process (B, on the host) tries the same call every second and watches the holder's
// process lock.
//   partition  the holder's container is disconnected from the network (its kernel answers nothing):
//              when the server frees the lock, when B takes over; 1 effect.
//   stall      the holder is SIGSTOPped for <seconds>, then continued: B must never take over (the
//              holder's kernel still answers keepalives); the holder finishes; 1 effect.
//   kill       stall's falsifier: the holder is killed, B takes over at once.
//
// Setup (the server on a network the holder joins, its port published for B):
//   pnpm -r build
//   docker network create gnl-ka-net
//   docker run --rm -d --name my-ka --network gnl-ka-net -p 127.0.0.1:33316:3306 -e MYSQL_ROOT_PASSWORD=t \
//     -e MYSQL_DATABASE=gnl --sysctl net.ipv4.tcp_keepalive_time=10 --sysctl net.ipv4.tcp_keepalive_intvl=5 \
//     --sysctl net.ipv4.tcp_keepalive_probes=3 mysql:8.4
//   node scripts/mysql-partition-probe.mjs my-ka 33316 partition 120 3
// The root password must be `t` and the database `gnl` (as above). Measured on 18 Oct 2026, MySQL 8.4
// and MariaDB 11: ~25.6 s with 10 / 5 / 3; not within 120 s with the Linux defaults.
if (process.argv[2] === '--holder') {
  const [, root, uri, runId, bodyS] = process.argv.slice(2);
  const durable = await import(`${root}/packages/durable/dist/index.js`);
  const { MysqlStorage } = await import(`${root}/packages/durable/dist/mysql-storage.js`);
  const s = new MysqlStorage({ connectionString: uri });
  await s.init();
  const liveness = await s.processLiveness();
  console.log(`LIVENESS ${liveness.id}`);
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
import { createHash } from 'node:crypto';
const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const [server, port, mode, secondsS, roundsS] = process.argv.slice(2);
const durable = await import(`${root}/packages/durable/dist/index.js`);
const { MysqlStorage } = await import(`${root}/packages/durable/dist/mysql-storage.js`);
const docker = (...a) => execFileSync('docker', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const limitMs = Number(secondsS) * 1000;
const b = new MysqlStorage({ connectionString: `mysql://root:t@127.0.0.1:${port}/gnl` });
await b.init();
const [[{ db }]] = await b.pool.query('SELECT DATABASE() AS db');
const lockOf = (id) => `gnlp_${createHash('sha1').update(`${db}\u0000${id}`).digest('hex')}`;
const holder = 'gnl-ka-holder';
// The throwaway container's own root login, put together here rather than written out as one URL.
const holderUrl = (host) => Object.assign(new URL('mysql://localhost:3306/gnl'), { hostname: host, username: 'root', password: 't' }).href;
const rows = [];
for (let round = 0; round < Number(roundsS); round++) {
  const runId = `ka-${mode}-${Date.now()}-${round}`;
  try { docker('rm', '-f', holder); } catch { /* none */ }
  docker('run', '-d', '--name', holder, '--network', 'gnl-ka-net', '-v', `${root}:${root}:ro`, 'node:22-slim',
    'node', `${root}/scripts/mysql-partition-probe.mjs`, '--holder', root, holderUrl(server), runId, mode === 'stall' ? '1000' : '-1');
  let logs = '';
  for (let i = 0; !logs.includes('IN') && i < 600; i++) { await sleep(100); logs = docker('logs', holder); }
  if (!logs.includes('IN')) { rows.push({ round, error: 'holder never entered the body', logs }); continue; }
  const id = /LIVENESS (\S+)/.exec(logs)[1];
  const lock = lockOf(id);
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
    if (releasedMs === undefined) {
      const [[r]] = await b.pool.query('SELECT IS_USED_LOCK(?) AS c', [lock]);
      if (r.c == null) releasedMs = Math.round(performance.now() - t0);
    }
    if (performance.now() - lastAttempt >= 1000) {
      lastAttempt = performance.now();
      attempts++;
      const out = await durable.durableTool(tool, { journal: b.runs, runId }, 'charge').execute({ amount: 1 }, { toolCallId: 'c1' }).catch((e) => `ERR ${e?.name}`);
      if (typeof out === 'object') takeoverMs = Math.round(performance.now() - t0); else busy++;
    }
    await sleep(250);
  }
  let holderOut = 'cut off / killed';
  if (mode === 'stall') {
    docker('kill', '--signal=SIGCONT', holder);
    for (let i = 0; i < 300 && !/OUT /.test(docker('logs', holder)); i++) await sleep(100);
    holderOut = (/OUT (.*)/.exec(docker('logs', holder)) ?? [, 'none'])[1];
  }
  await sleep(500);
  const effects = (await durable.toJournal(b.runs).getCounters(`effects:${runId}`))?.n ?? 0;
  try { docker('rm', '-f', holder); } catch { /* gone */ }
  rows.push({ round, releasedMs: releasedMs ?? `not within ${secondsS}s`, takeoverMs: takeoverMs ?? `not within ${secondsS}s`, attempts, busy, effects, holderOut, ...(stopped ? { stopped } : {}) });
  console.error(JSON.stringify(rows.at(-1)));
}
console.log(JSON.stringify({ server, mode, limitS: Number(secondsS), rows }));
await b.close();
process.exit(0);
