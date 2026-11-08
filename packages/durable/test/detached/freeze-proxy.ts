// A TCP proxy between ONE app process and Postgres that can make the database stop answering that
// process — and only it — for a while, the way a stalled network or a swamped server does.
//
// Frozen, a connection forwards nothing either way: what the process sends waits here, what the server
// answers waits here, and a close from either side waits too (a partition delivers no FIN). A connection
// opened while frozen is accepted and not passed on (its SYN would not have arrived). Thawed, everything
// held is delivered in order, as a network that comes back delivers what it retransmits.
//
// `dropServer()` is the server's side giving up on a silent peer (its keepalive): the server-side socket
// of every frozen connection is closed now — its backend ends, its session locks go — while the process
// hears nothing until the thaw, when its side is reset.
//
// A connection is tagged `liveness` once it sends the liveness session's first statement
// (`SET tcp_keepalives_idle`, process-liveness.ts `open`), so one variant can freeze that session alone.
//
// Every freeze, thaw, drop and every chunk held is logged with a timestamp: a scenario proves from the log
// that the database really stopped answering (bytes were held), not merely that a freeze was asked for.
import { createServer, connect, type Server, type Socket } from 'node:net';

export type ConnKind = 'liveness' | 'other';
export type Selector = 'all' | 'liveness';
export interface ProxyLogEntry { t: number; ev: string; conn?: number; kind?: ConnKind; bytes?: number; dir?: 'up' | 'down'; note?: string }
/** A trigger looks at what the process sends; it may freeze this proxy before or after the chunk is passed on. */
export type Trigger = (chunk: Buffer, conn: { id: number; kind: ConnKind }) => 'freeze-before' | 'freeze-after' | undefined;

interface Conn {
  id: number;
  kind: ConnKind;
  client: Socket;
  server?: Socket;
  serverGone: boolean;
  toServer: Buffer[];
  toClient: Buffer[];
  clientClosed: boolean;
  serverClosed: boolean;
  dead: boolean;
}

export class FreezeProxy {
  readonly log: ProxyLogEntry[] = [];
  private server!: Server;
  private conns = new Set<Conn>();
  private seq = 0;
  private frozenSel: Selector | undefined;
  private triggers: Trigger[] = [];
  port = 0;
  /** What a trigger freezes: every connection of this process, or its liveness session alone. */
  triggerSelector: Selector = 'all';
  /** Bytes held while frozen, per freeze (the proof that a freeze took effect). */
  heldBytes = 0;
  constructor(private readonly upstream: { host: string; port: number }, readonly name: string) {}

  async start(): Promise<void> {
    this.server = createServer((client) => this.accept(client));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', () => r()));
    this.port = (this.server.address() as { port: number }).port;
  }

  /** The URL that reaches `url`'s database through this proxy. */
  urlFor(url: string): string {
    const u = new URL(url);
    u.hostname = '127.0.0.1';
    u.port = String(this.port);
    return u.toString();
  }

  private now(): number { return Date.now(); }
  private note(e: Omit<ProxyLogEntry, 't'>): void { this.log.push({ t: this.now(), ...e }); }

  get frozen(): Selector | undefined { return this.frozenSel; }
  private isFrozen(c: Conn): boolean {
    return this.frozenSel === 'all' || (this.frozenSel === 'liveness' && c.kind === 'liveness');
  }

  onClientData(t: Trigger): void { this.triggers.push(t); }
  clearTriggers(): void { this.triggers = []; }

  freeze(sel: Selector = 'all', why = ''): void {
    if (this.frozenSel) return;
    this.frozenSel = sel;
    this.heldBytes = 0;
    this.note({ ev: 'freeze', note: `${sel}${why ? ` ${why}` : ''}` });
  }

  /** The server gives up on every frozen connection: its backend ends (locks freed); the process hears it at the thaw. */
  dropServer(only?: 'liveness'): void {
    let n = 0;
    for (const c of this.conns) {
      if (!this.isFrozen(c) || !c.server || c.serverGone) continue;
      if (only && c.kind !== only) continue;
      c.serverGone = true;
      c.server.destroy();
      n++;
    }
    this.note({ ev: 'drop-server', note: `${n} connections${only ? ` (${only} only)` : ''}` });
  }

  /** Thaws every connection but the liveness session's, which stays frozen until `thaw()`. */
  thawAllButLiveness(): void {
    if (this.frozenSel !== 'all') return;
    this.frozenSel = 'liveness';
    this.note({ ev: 'thaw-pool', note: `held=${this.heldBytes}B` });
    for (const c of [...this.conns]) if (c.kind !== 'liveness') this.flush(c);
  }

  thaw(): void {
    if (!this.frozenSel) return;
    const sel = this.frozenSel;
    this.frozenSel = undefined;
    this.note({ ev: 'thaw', note: `${sel} held=${this.heldBytes}B` });
    this.counted = new WeakMap();
    for (const c of [...this.conns]) this.flush(c);
  }

  private accept(client: Socket): void {
    const c: Conn = { id: ++this.seq, kind: 'other', client, serverGone: false, toServer: [], toClient: [], clientClosed: false, serverClosed: false, dead: false };
    this.conns.add(c);
    client.setNoDelay(true);
    this.note({ ev: 'accept', conn: c.id, note: this.frozenSel ? 'while-frozen' : undefined });
    client.on('data', (chunk: Buffer) => {
      if (c.kind === 'other' && chunk.includes('tcp_keepalives_idle')) c.kind = 'liveness';
      let after = false;
      for (const t of this.triggers) {
        const d = t(chunk, { id: c.id, kind: c.kind });
        if (d === 'freeze-before') this.freeze(this.triggerSelector, `trigger-before conn=${c.id}`);
        if (d === 'freeze-after') after = true;
      }
      c.toServer.push(chunk);
      this.flush(c);
      if (after) this.freeze(this.triggerSelector, `trigger-after conn=${c.id}`);
    });
    client.on('close', () => { c.clientClosed = true; this.flush(c); });
    client.on('error', () => { c.clientClosed = true; this.flush(c); });
    this.openServer(c);
  }

  private openServer(c: Conn): void {
    if (c.server || this.isFrozen(c)) return;
    const s = connect(this.upstream.port, this.upstream.host);
    s.setNoDelay(true);
    c.server = s;
    s.once('connect', () => this.note({ ev: 'upstream', conn: c.id, note: `localPort=${s.localPort}` }));
    s.on('data', (chunk: Buffer) => { c.toClient.push(chunk); this.flush(c); });
    s.on('close', () => { c.serverClosed = true; this.flush(c); });
    s.on('error', () => { c.serverClosed = true; this.flush(c); });
  }

  private flush(c: Conn): void {
    if (c.dead) return;
    if (this.isFrozen(c)) {
      this.countHeld(c);
      return;
    }
    if (!c.server && !c.serverGone) this.openServer(c);
    if (c.serverGone) {
      // The server ended this session while it was silent: the process's side is reset now.
      c.dead = true;
      c.client.destroy();
      this.conns.delete(c);
      return;
    }
    if (c.server && !c.server.connecting && c.toServer.length && !c.server.destroyed) for (const b of c.toServer.splice(0)) c.server.write(b);
    else if (c.server?.connecting && c.toServer.length) c.server.once('connect', () => this.flush(c));
    if (c.toClient.length && !c.client.destroyed) for (const b of c.toClient.splice(0)) c.client.write(b);
    if (c.clientClosed || c.serverClosed) {
      c.dead = true;
      c.server?.destroy();
      c.client.destroy();
      this.conns.delete(c);
      this.note({ ev: 'close', conn: c.id, kind: c.kind, note: c.clientClosed ? 'client' : 'server' });
    }
  }

  private counted = new WeakMap<Conn, number>();
  private countHeld(c: Conn): void {
    const now = c.toServer.reduce((a, b) => a + b.length, 0) + c.toClient.reduce((a, b) => a + b.length, 0);
    const before = this.counted.get(c) ?? 0;
    if (now > before) {
      this.heldBytes += now - before;
      this.note({ ev: 'held', conn: c.id, kind: c.kind, bytes: now - before });
    }
    this.counted.set(c, now);
  }

  async close(): Promise<void> {
    this.frozenSel = undefined;
    for (const c of this.conns) { c.dead = true; c.client.destroy(); c.server?.destroy(); }
    this.conns.clear();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}
