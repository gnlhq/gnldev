// A TCP proxy that can lose a session SILENTLY: `cutSilently()` closes the server side of every
// connection through it (the server ends the session and frees what it held) and keeps the client side
// open and mute — what the client sends is dropped, nothing comes back, no 'end' or 'error' reaches it.
// What a dropped NAT entry, a failover that moves an address, or a firewall that drops instead of
// resetting does. `refuseNew` makes later connections fail (the server unreachable), else they pass.
import net from 'node:net';

export interface SilentProxy { url: string; cutSilently(): void; refuseNew: boolean; close(): void }

export async function silentProxy(target: string): Promise<SilentProxy> {
  const t = new URL(target);
  const port = Number(t.port || (t.protocol.startsWith('postgres') ? 5432 : t.protocol.startsWith('mysql') ? 3306 : 27017));
  const pairs = new Set<{ down: net.Socket; up: net.Socket; silent: boolean }>();
  const p: SilentProxy = { url: '', refuseNew: false, cutSilently() {}, close() {} };
  const srv = net.createServer((down) => {
    if (p.refuseNew) { down.destroy(); return; }
    const up = net.connect(port, t.hostname);
    const pair = { down, up, silent: false };
    pairs.add(pair);
    down.on('data', (d) => { if (!pair.silent) up.write(d); });
    up.on('data', (d) => { if (!pair.silent) down.write(d); });
    up.on('error', () => undefined);
    down.on('error', () => undefined);
    up.on('close', () => { if (!pair.silent) down.destroy(); });
    down.on('close', () => { up.destroy(); pairs.delete(pair); });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const u = new URL(target);
  u.hostname = '127.0.0.1';
  u.port = String((srv.address() as net.AddressInfo).port);
  p.url = u.toString();
  p.cutSilently = () => { for (const pair of pairs) { pair.silent = true; pair.up.destroy(); } };
  p.close = () => { for (const pair of pairs) { pair.down.destroy(); pair.up.destroy(); } srv.close(); };
  return p;
}
