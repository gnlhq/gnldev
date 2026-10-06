// Test-only: Map-based fake RedisLike client for running RedisStorage WITHOUT a real Redis server.
// Only mimics the commands RedisStorage uses: SET (NX/PX/EX), GET, MGET, DEL, SCAN (MATCH/COUNT),
// STRLEN, ZADD/ZRANGEBYSCORE/ZREM (for the H8b last-activity index + H8c readRunStats).
// TTL is evaluated via an injectable fake clock (`now`) → tests can fast-forward time.
// ioredis-mock is NOT used (no dependency added); behavior is kept minimal and observable.
import type { RedisLike, RedisPipeline } from '../src/redis-storage.js';

/** Redis glob (MATCH) → RegExp. Supports `\`-escaping, `*`, and `?` (the patterns RedisStorage produces). */
function globToRegExp(glob: string): RegExp {
  const esc = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '\\') { const n = glob[++i]; re += n != null ? esc(n) : '\\\\'; }
    else if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else re += esc(c);
  }
  return new RegExp(re + '$');
}

export class FakeRedis implements RedisLike {
  private store = new Map<string, { val: string; exp?: number }>();
  /** OPTIONAL — only defined if `withMulti=true` is passed (see constructor). Default `false`:
   *  ALL existing tests (makeFakeRedis()/`new FakeRedis(now)`) keep running with the old
   *  behavior that has NO `multi` field → RedisRunJournal.canPipe() returns false, so the
   *  separate-call (touch()) path runs unchanged. Tests that want to exercise the pipeline path
   *  pass `withMulti=true`. */
  multi?: () => RedisPipeline;
  constructor(private now: () => number = () => Date.now(), withMulti = false) {
    if (withMulti) this.multi = () => this.makePipeline();
  }

  /** H8b pipeline mimic (for the audit-fix test): runs the queued SET/ZADD/EVAL commands
   *  IN ORDER on exec() (by calling the real FakeRedis methods, against the same store) —
   *  simulating a SINGLE `await pipe.exec()` = one round-trip for the caller; returns the same
   *  `[err, result][]` shape as the ioredis exec() contract. The script is NOT interpreted
   *  (the eval() mimic already works that way) — the real command methods are called, so
   *  behavior against the store is genuine.  */
  private makePipeline(): RedisPipeline {
    const ops: Array<() => Promise<unknown>> = [];
    const pipe: RedisPipeline = {
      set: (key: string, value: string, ...args: (string | number)[]) => {
        ops.push(() => this.set(key, value, ...args));
        return pipe;
      },
      zadd: (key: string, score: number, member: string) => {
        ops.push(() => this.zadd(key, score, member));
        return pipe;
      },
      eval: (script: string, numKeys: number, ...args: (string | number)[]) => {
        ops.push(() => this.eval(script, numKeys, ...args));
        return pipe;
      },
      exec: async () => {
        const out: Array<[Error | null, unknown]> = [];
        for (const op of ops) {
          try { out.push([null, await op()]); } catch (e) { out.push([e as Error, null]); }
        }
        return out;
      },
    };
    return pipe;
  }

  /** Lazy-delete on expiry (mimics Redis's native TTL behavior). */
  private live(key: string): { val: string; exp?: number } | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (e.exp != null && e.exp <= this.now()) { this.store.delete(key); return undefined; }
    return e;
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.val ?? null;
  }

  async set(key: string, value: string, ...args: (string | number)[]): Promise<string | null> {
    let nx = false;
    let px: number | undefined;
    for (let i = 0; i < args.length; i++) {
      const a = String(args[i]).toUpperCase();
      if (a === 'NX') nx = true;
      else if (a === 'PX') px = Number(args[++i]);
      else if (a === 'EX') px = Number(args[++i]) * 1000;
    }
    if (nx && this.live(key)) return null; // SET NX: don't write if it already exists
    this.store.set(key, { val: value, exp: px != null ? this.now() + px : undefined });
    return 'OK';
  }

  /** Bulk GET (ioredis mget parity): read from the Map in order, lazily drop expired ones, missing → null. */
  async mget(...keys: string[]): Promise<(string | null)[]> {
    return keys.map((k) => this.live(k)?.val ?? null);
  }

  async del(...keys: string[]): Promise<number> {
    // Real-Redis parity: DEL removes a key of ANY type — strings AND hashes (hincrbyfloat counters)
    // AND zsets live in one keyspace. The fake keeps them in separate Maps, so delete from all three
    // (counting each key once); otherwise deletePrefix's counter sweep (redis-storage.ts) can't be tested.
    let n = 0;
    for (const k of keys) {
      const hit = this.store.delete(k) || this.hashes.delete(k) || this.zsets.delete(k);
      if (hit) n++;
    }
    return n;
  }

  async scan(cursor: string | number, ...args: (string | number)[]): Promise<[string, string[]]> {
    let match = '*';
    for (let i = 0; i < args.length; i++) {
      const a = String(args[i]).toUpperCase();
      if (a === 'MATCH') match = String(args[++i]);
      else if (a === 'COUNT') i++;
    }
    const re = globToRegExp(match);
    const keys: string[] = [];
    // Real-Redis parity: SCAN walks the whole keyspace regardless of type — include hash keys
    // (counters) and zset keys, not just the string store (dedup: a name can only exist once in real Redis).
    const seen = new Set<string>();
    for (const k of [...this.store.keys(), ...this.hashes.keys(), ...this.zsets.keys()]) {
      if (seen.has(k)) continue;
      seen.add(k);
      if ((this.store.has(k) ? this.live(k) : true) && re.test(k)) keys.push(k);
    }
    return ['0', keys]; // fake: all matches in one pass (cursor always ends at '0')
  }

  /**
   * Lua eval mimic — scripts are NOT interpreted; dispatched BY MARKER (a distinctive substring unique
   * to each real script constant in redis-storage.ts), then the equivalent semantics are run directly
   * against this fake's own store (calling the REAL command methods below) — same "not interpreted, but
   * genuine against-the-store" approach the pipeline mimic (makePipeline) above already uses.
   *
   * P1.6b applyBatch (APPLY_BATCH_LUA, marker: `cjson.decode`): the whole batch travels as ONE JSON
   * descriptor in ARGV[1] — decoded here (NOT via cjson, plain JSON.parse — the fake never runs real
   * Lua) and applied: claim key EXISTS → 0 (nothing else applied, real-Redis parity: atomic,
   * claim-exists-means-whole-batch-is-a-no-op); otherwise SET the claim + HINCRBYFLOAT every counter
   * field + SET every put, return 1. No `await` between the EXISTS check and the writes below (this
   * fake's own store is a plain synchronous Map) → stays faithful to the real script's atomicity.
   */
  async eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown> {
    if (script.includes('cjson.decode')) {
      const desc = JSON.parse(String(args[0])) as {
        claim?: { key: string; value: string };
        incrs?: { key: string; fields: Record<string, number> }[];
        puts?: { key: string; value: string }[];
        zadds?: { key: string; score: number; member: string; nx?: boolean }[];
      };
      if (desc.claim && this.live(desc.claim.key)) return 0; // claim already exists → whole batch is a no-op
      if (desc.claim) await this.set(desc.claim.key, desc.claim.value);
      for (const incr of desc.incrs ?? []) {
        for (const [field, delta] of Object.entries(incr.fields)) await this.hincrbyfloat(incr.key, field, delta);
      }
      for (const p of desc.puts ?? []) await this.set(p.key, p.value);
      for (const z of desc.zadds ?? []) {
        if (z.nx && this.zsets.get(z.key)?.has(z.member)) continue; // ZADD NX: the run order keeps a run's first write
        await this.zadd(z.key, z.score, z.member); // H8b activity touch parity
      }
      return 1;
    }
    // incrBy over several fields (INCR_FIELDS_LUA, marker `gnl:incr-fields`): KEYS = [hash], ARGV = field/delta pairs.
    if (script.includes('gnl:incr-fields')) {
      // KEYS = [hash, index?], ARGV = field/delta pairs, then the index member when KEYS[2] is given.
      const argv = args.slice(numKeys);
      if (numKeys === 2) await this.zadd(String(args[1]), 0, String(argv.pop()));
      const out: string[] = [];
      for (let i = 0; i < argv.length; i += 2) out.push(await this.hincrbyfloat(String(args[0]), String(argv[i]), Number(argv[i + 1])));
      return out;
    }
    // The run order (RUN_ORDER_LUA, marker `gnl:run-order`): KEYS = [order], ARGV = score/run pairs, ZADD NX.
    if (script.includes('gnl:run-order')) {
      const argv = args.slice(numKeys);
      for (let i = 0; i < argv.length; i += 2) {
        if (!this.zsets.get(String(args[0]))?.has(String(argv[i + 1]))) await this.zadd(String(args[0]), Number(argv[i]), String(argv[i + 1]));
      }
      return argv.length / 2;
    }
    // KeyIndex fill (INDEX_FILL_LUA, marker `gnl:index-fill`): KEYS = [index], ARGV = members.
    if (script.includes('gnl:index-fill')) {
      for (const m of args.slice(1)) await this.zadd(String(args[0]), 0, String(m));
      return args.length - 1;
    }
    // WorkStore.append (WORK_APPEND_LUA, marker `gnl:work-append`): KEYS = [counter, record], ARGV = [record].
    // Existing record → 0 and no number taken; else INCR the counter and write the record numbered.
    if (script.includes('gnl:work-append')) {
      // KEYS = [counter, record, index?], ARGV = [record, member?]
      const [seqKey, recKey] = [String(args[0]), String(args[1])];
      const indexed = numKeys === 3;
      const rec = String(args[numKeys]);
      if (this.live(recKey)) return 0;
      const n = Number(this.live(seqKey)?.val ?? 0) + 1;
      this.store.set(seqKey, { val: String(n) });
      if (indexed) await this.zadd(String(args[2]), 0, String(args[numKeys + 1]));
      this.store.set(recKey, { val: `{"json":{"seq":${n},${rec.slice('{"json":{'.length)}` });
      return n;
    }
    // WorkStore.list numbering (WORK_NUMBER_LUA, marker `gnl:work-number`): KEYS = [counter, ...records].
    // Each record still in 0.9's bare form takes the next number, written as the record's first field;
    // a numbered or missing record is skipped. No await between reads and writes → atomic like the script.
    if (script.includes('gnl:work-number')) {
      const [seqKey, ...recKeys] = args.slice(0, numKeys).map(String);
      let n = 0;
      for (const k of recKeys) {
        const v = this.live(k)?.val;
        if (v === undefined || !v.startsWith('{"json":{') || v.startsWith('{"json":{"seq":')) continue;
        const s = Number(this.live(seqKey!)?.val ?? 0) + 1;
        this.store.set(seqKey!, { val: String(s) });
        this.store.set(k, { val: `{"json":{"seq":${s},${v.slice('{"json":{'.length)}` });
        n++;
      }
      return n;
    }
    // H1 CAS mimic (putIfMatch, CAS_LUA): GET KEYS[1] == ARGV[1] → SET KEYS[1]=ARGV[2] → 1, else 0.
    // No await between GET-compare-SET in single-threaded JS → stays faithful to real Redis script atomicity.
    const key = String(args[0]);
    const expected = String(args[numKeys]);     // ARGV[1]
    const next = String(args[numKeys + 1]);     // ARGV[2]
    const cur = this.live(key);
    if (!cur || cur.val !== expected) return 0;
    this.store.set(key, { val: next, exp: cur.exp });
    return 1;
  }

  /** Redis TIME mimic: `[seconds, microseconds]` string pair (derived from the fake clock). */
  async time(): Promise<[string, string]> {
    const ms = this.now();
    return [String(Math.floor(ms / 1000)), String((ms % 1000) * 1000)];
  }

  // H8a: hash counters (atomic — single-threaded JS).
  private hashes = new Map<string, Record<string, number>>();
  async hincrbyfloat(key: string, field: string, delta: number): Promise<string> {
    const h = this.hashes.get(key) ?? {};
    h[field] = (h[field] ?? 0) + delta;
    this.hashes.set(key, h);
    return String(h[field]);
  }
  async hgetall(key: string): Promise<Record<string, string>> {
    const h = this.hashes.get(key) ?? {};
    return Object.fromEntries(Object.entries(h).map(([f, v]) => [f, String(v)]));
  }

  async quit(): Promise<'OK'> { this.store.clear(); this.hashes.clear(); this.zsets.clear(); return 'OK'; }

  /** H8c: STRLEN mimic — does NOT return the value, only its length (for RedisRunJournal.readRunStats). */
  async strlen(key: string): Promise<number> {
    return this.live(key)?.val.length ?? 0;
  }

  // H8b: ZSET mimic (score→member) — for RedisRunJournal's last-activity index.
  private zsets = new Map<string, Map<string, number>>();

  async zadd(key: string, score: number, member: string): Promise<number> {
    const z = this.zsets.get(key) ?? new Map<string, number>();
    const isNew = !z.has(member);
    z.set(member, score);
    this.zsets.set(key, z);
    return isNew ? 1 : 0;
  }

  /** ioredis ZRANGEBYSCORE contract: `'-inf'`/`'+inf'`/number/`'(x'` (exclusive) bounds, ASCENDING score order. */
  async zrangebyscore(key: string, min: number | string, max: number | string): Promise<string[]> {
    const z = this.zsets.get(key);
    if (!z) return [];
    const parseBound = (b: number | string): { val: number; exclusive: boolean } => {
      if (typeof b === 'number') return { val: b, exclusive: false };
      if (b === '-inf') return { val: -Infinity, exclusive: false };
      if (b === '+inf') return { val: Infinity, exclusive: false };
      if (b.startsWith('(')) return { val: Number(b.slice(1)), exclusive: true };
      return { val: Number(b), exclusive: false };
    };
    const lo = parseBound(min);
    const hi = parseBound(max);
    const out: [string, number][] = [];
    for (const [member, score] of z) {
      if (score < lo.val || (lo.exclusive && score === lo.val)) continue;
      if (score > hi.val || (hi.exclusive && score === hi.val)) continue;
      out.push([member, score]);
    }
    out.sort((a, b) => a[1] - b[1]); // Redis: returns in ASCENDING score order
    return out.map(([m]) => m);
  }

  /** ZRANGEBYLEX mimic: members compared as UTF-8 bytes, as Redis does; `[x`/`(x`/`-`/`+`, optional LIMIT. */
  async zrangebylex(key: string, min: string, max: string, ...args: (string | number)[]): Promise<string[]> {
    const z = this.zsets.get(key);
    if (!z) return [];
    const inRange = lexRange(min, max);
    const out = [...z.keys()].filter(inRange).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    const li = args.findIndex((a) => String(a).toUpperCase() === 'LIMIT');
    return li >= 0 ? out.slice(Number(args[li + 1]), Number(args[li + 1]) + Number(args[li + 2])) : out;
  }
  async zremrangebylex(key: string, min: string, max: string): Promise<number> {
    const z = this.zsets.get(key);
    if (!z) return 0;
    const inRange = lexRange(min, max);
    let n = 0;
    for (const m of [...z.keys()]) if (inRange(m)) { z.delete(m); n++; }
    return n;
  }

  /** ZRANGE by rank: score order, ties by member bytes (as Redis), `stop` inclusive, negatives from the end. */
  async zrange(key: string, start: number, stop: number): Promise<string[]> {
    const z = this.zsets.get(key);
    if (!z) return [];
    const all = [...z].sort((a, b) => (a[1] - b[1]) || Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0]))).map(([m]) => m);
    const n = all.length;
    const from = start < 0 ? Math.max(0, n + start) : start;
    const to = stop < 0 ? n + stop : Math.min(stop, n - 1);
    return from > to ? [] : all.slice(from, to + 1);
  }
  async zcard(key: string): Promise<number> { return this.zsets.get(key)?.size ?? 0; }
  async zrank(key: string, member: string): Promise<number | null> {
    const i = (await this.zrange(key, 0, -1)).indexOf(member);
    return i < 0 ? null : i;
  }

  async zrem(key: string, ...members: string[]): Promise<number> {
    const z = this.zsets.get(key);
    if (!z) return 0;
    let n = 0;
    for (const m of members) if (z.delete(m)) n++;
    return n;
  }
}

/** A ZRANGEBYLEX bound pair as a predicate on members, comparing UTF-8 bytes. */
function lexRange(min: string, max: string): (m: string) => boolean {
  const bound = (b: string, lower: boolean) => {
    if (b === '-') return () => true;
    if (b === '+') return () => true;
    const v = Buffer.from(b.slice(1));
    const incl = b[0] === '[';
    return (m: string) => { const c = Buffer.compare(Buffer.from(m), v); return lower ? (incl ? c >= 0 : c > 0) : (incl ? c <= 0 : c < 0); };
  };
  const lo = bound(min, true); const hi = bound(max, false);
  return (m) => lo(m) && hi(m);
}

/** Shortcut: create a FakeRedis with a fake clock (or the real clock). `withMulti=true` → a fake
 *  client that supports the pipeline (multi()) (for H8b pipeline tests); default `false` = the old
 *  (multi-less) behavior existing tests see. */
export function makeFakeRedis(now?: () => number, withMulti = false): FakeRedis {
  return new FakeRedis(now, withMulti);
}
