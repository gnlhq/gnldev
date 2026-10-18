// What MongoStorage needs from its server, and what it does when it does not get it.
//
//  1. A replica set. A standalone server takes single-document writes and refuses every transaction, so a
//     store on one would write half of a claimed batch's promises and fail at the first transaction.
//     Refused at open — the store's and the process liveness's — before anything is written.
//  2. Connection visibility. A process's liveness is a connection named for it; another process judges it
//     alive by finding that connection in `$currentOp`. A user that cannot see it reads a live holder as
//     dead and runs its call a second time. So the liveness looks for its own connection from a second
//     connection before it is handed out, and keeps a register of the users that opened one on this
//     database: a user that sees only its own connections is refused next to any other user.
//     Measured: MongoDB 8.0 shows a user its own other connections without `clusterMonitor`; 8.3 shows it
//     only the connection asking. The check answers for the server it runs on.
//  3. The server's TCP keepalive (how long a cut-off host keeps its runs): not readable by a client, so the
//     durability report says so.
//  4. What snapshot isolation alone lets through. Two transactions that write different documents both
//     commit, so a thread's deletion and an append beside it could each keep what the other removed or
//     placed — a state no order of the two gives. The thread's lock document makes them conflict.
//
// Runs with GNL_MONGO_URL (a replica set; its user creates users) and GNL_MONGO_STANDALONE_URL.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { MongoStorage, mongoLiveness } from '../src/mongo-storage.js';
import { MONGO_URL, MONGO_STANDALONE_URL, freshMongoDatabase, mongoUrlFor } from './real-backends.js';

type Client = {
  connect(): Promise<unknown>;
  db(name?: string): { command(c: object): Promise<any>; listCollections(): { toArray(): Promise<unknown[]> }; aggregate(p: object[]): { toArray(): Promise<any[]> }; collection(n: string): { find(q: object): { toArray(): Promise<any[]> } } };
  close(): Promise<void>;
};
const MongoClient = () => (createRequire(import.meta.url)('mongodb') as { MongoClient: new (url: string, o?: object) => Client }).MongoClient;
const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const dbOf = (url: string) => new URL(url).pathname.slice(1);

describe.skipIf(!MONGO_STANDALONE_URL)('a standalone MongoDB server is refused, and nothing is written', () => {
  it('the store refuses it at open, naming the replica set it needs', async () => {
    const url = mongoUrlFor(MONGO_STANDALONE_URL!, `gnl_sa_${unique()}`);
    const s = new MongoStorage({ connectionString: url });
    try {
      await expect(s.init()).rejects.toThrow(/replica set/);
      await expect(s.runs.put('k', 1)).rejects.toThrow(/replica set/);
    } finally { await s.close(); }
    const c = new (MongoClient())(MONGO_STANDALONE_URL!);
    try {
      expect(await c.db(dbOf(url)).listCollections().toArray(), 'nothing was created').toEqual([]);
    } finally { await c.close(); }
  });
  it('the process liveness refuses it too', async () => {
    const url = mongoUrlFor(MONGO_STANDALONE_URL!, `gnl_sa_${unique()}`);
    await expect(mongoLiveness({ connectionString: url })).rejects.toThrow(/replica set/);
  });
});

describe.skipIf(!MONGO_URL)('a process that cannot see the others\' connections is refused', () => {
  /** A user of the test database (`roles`), its URL returned; dropped afterwards. */
  const users: Array<{ db: string; user: string }> = [];
  async function userOn(url: string, roles: object[]): Promise<string> {
    const db = dbOf(url);
    const user = `u_${unique()}`;
    const admin = new (MongoClient())(MONGO_URL!);
    try { await admin.db(db).command({ createUser: user, pwd: 'pw', roles }); } finally { await admin.close(); }
    users.push({ db, user });
    const u = new URL(url);
    u.username = user;
    u.password = 'pw';
    u.searchParams.set('authSource', db);
    return u.toString();
  }
  async function dropUsers(): Promise<void> {
    const admin = new (MongoClient())(MONGO_URL!);
    try { for (const { db, user } of users.splice(0)) await admin.db(db).command({ dropUser: user }).catch(() => undefined); } finally { await admin.close(); }
  }
  /** Whether this server shows a plain user its own OTHER connections (measured here, not assumed). */
  async function sameUserSeesItsConnections(url: string): Promise<boolean> {
    const name = `probe-${unique()}`;
    const a = new (MongoClient())(url, { appName: name, maxPoolSize: 1 });
    const b = new (MongoClient())(url, { maxPoolSize: 1 });
    try {
      await a.db().command({ ping: 1 });
      const r = await b.db('admin').aggregate([{ $currentOp: { allUsers: false, idleConnections: true } }, { $match: { appName: name } }]).toArray();
      return r.length > 0;
    } finally { await a.close(); await b.close(); }
  }

  it('a user with clusterMonitor sees every connection: two of its processes see each other, alive and then dead', async () => {
    const url = freshMongoDatabase();
    const monitor = [{ role: 'readWrite', db: dbOf(url) }, { role: 'clusterMonitor', db: 'admin' }];
    try {
      const a = await mongoLiveness({ connectionString: await userOn(url, monitor) });
      const b = await mongoLiveness({ connectionString: await userOn(url, monitor) });
      try {
        expect(a.visibility).toBe('every user');
        expect(await a.confirm()).toBe(true);
        expect(await b.isAlive(a.id)).toBe(true);
        await a.close();
        expect(await b.isAlive(a.id)).toBe(false);
      } finally { await a.close(); await b.close(); }
    } finally { await dropUsers(); }
  });

  it('a user without clusterMonitor is used only when it can see its own other connections, and never beside another user', async () => {
    const url = freshMongoDatabase();
    const plain = [{ role: 'readWrite', db: dbOf(url) }];
    try {
      const first = await userOn(url, plain);
      if (!(await sameUserSeesItsConnections(first))) {
        // This server shows a plain user only the connection that asks: no process of it can see another.
        await expect(mongoLiveness({ connectionString: first })).rejects.toThrow(/cannot see .*clusterMonitor/s);
        return;
      }
      const a = await mongoLiveness({ connectionString: first });
      const a2 = await mongoLiveness({ connectionString: first });
      try {
        expect(a.visibility).toBe('this user');
        expect(await a2.isAlive(a.id), 'the same user sees its other process').toBe(true);
        // A second user: neither can see the other's connections.
        const second = await userOn(url, plain);
        await expect(mongoLiveness({ connectionString: second })).rejects.toThrow(/clusterMonitor/);
        // And one with clusterMonitor sees the first, but the first cannot see it: refused as well.
        const watcher = await userOn(url, [...plain, { role: 'clusterMonitor', db: 'admin' }]);
        await expect(mongoLiveness({ connectionString: watcher })).rejects.toThrow(/clusterMonitor/);
        // The refused users left no entry behind: only the first is registered.
        const c = new (MongoClient())(MONGO_URL!);
        try {
          const registered = (await c.db(dbOf(url)).collection('gnl_liveness_users').find({}).toArray()).map((d) => String(d._id));
          expect(registered).toEqual([`${dbOf(url)}.${new URL(first).username}`]);
        } finally { await c.close(); }
      } finally { await a.close(); await a2.close(); }
    } finally { await dropUsers(); }
  });
});

describe.skipIf(!MONGO_URL)('the durability report says what it can and cannot see', () => {
  it('the server\'s keepalive is out of a client\'s sight: said, with the setting a deployment needs', async () => {
    const s = new MongoStorage({ connectionString: freshMongoDatabase() });
    try {
      const r = await s.durabilityReport();
      expect(r.partitionDetection).toEqual({ seconds: null, source: 'operating system' });
      const notes = r.notes.join('\n');
      expect(notes).toMatch(/net\.ipv4\.tcp_keepalive_time/);
      expect(notes).toMatch(/cannot be read by a client/);
      expect(r.replicaSet).toBeTruthy();
      expect(r.members).toBeGreaterThanOrEqual(1);
      if (r.members < 3) expect(notes).toMatch(/one server|members/);
      expect(r.connectionVisibility).toBe('not checked: this process has not opened its liveness');
      await s.processLiveness();
      expect((await s.durabilityReport()).connectionVisibility).toMatch(/every user|this user/);
    } finally { await s.close(); }
  });
});

describe.skipIf(!MONGO_URL)('what a snapshot alone would let through, the thread\'s lock keeps out', () => {
  const msg = (text: string) => ({ role: 'user' as const, text, ts: 1, message: { role: 'user', content: text } });
  it('a thread deleted while a message is appended reads as one order or the other: all gone, or the new message first', async () => {
    const s = new MongoStorage({ connectionString: freshMongoDatabase() });
    try {
      for (let round = 0; round < 30; round++) {
        const t = `t-${round}`;
        await s.memory.upsertThread({ id: t, resourceId: 'u', createdAt: 1, updatedAt: 1 });
        await s.memory.appendMessages(t, ['a', 'b', 'c', 'd', 'e'].map(msg) as never);
        await Promise.all([s.memory.deleteThread(t), s.memory.appendMessages(t, [msg('late')] as never)]);
        const left = (await s.memory.getMessages(t)).items.map((m) => [m.seq, m.text]);
        expect([[], [[0, 'late']]], `round ${round}`).toContainEqual(left);
      }
    } finally { await s.close(); }
  }, 120_000);
});
