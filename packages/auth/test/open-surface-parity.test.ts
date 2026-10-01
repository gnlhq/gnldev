// ADR-0004: ONE function (`openSurfaceGuard`) decides the open-surface checks for the gate and the doors.
//
// The same request, the same provider, the same option, asked of @gnldev/server's/Studio's gate
// (`makeGate().allowP`) and of a standalone door (`doorGate` handed the provider's authenticate as
// `identify` and its authorize as `authorize`). Every cell (70) must answer the same {status, code}.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeGate, doorGate, type AuthProvider, type Principal } from '../src/index.js';

type Outcome = { status: number; code?: string };
const shapes: Record<string, Record<string, string>> = {
  'same-origin': { host: 'localhost:4111', origin: 'http://localhost:4111', 'sec-fetch-site': 'same-origin' },
  'cross-site': { host: 'localhost:4111', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
  rebound: { host: 'evil.example:4111', origin: 'http://evil.example:4111', 'sec-fetch-site': 'same-origin' },
  'rebound+cross-site': { host: 'evil.example:4111', origin: 'https://other.example', 'sec-fetch-site': 'cross-site' },
  curl: { host: 'localhost:4111' },
};
const principals: Record<string, Principal | null> = {
  none: null,
  'unnamed-object': { kind: 'subject', id: '', roles: [] } as Principal,
  named: { kind: 'subject', id: 'u1', roles: [] } as Principal,
};
const verdicts = { allow: { allow: true }, refuse401: { allow: false, status: 401 as const, reason: 'no' } };
const mk = (h: Record<string, string>) => new Request('http://localhost:4111/agents/a/run', { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: '{}' });

async function viaGate(provider: AuthProvider | undefined, allowCrossSite: boolean, h: Record<string, string>): Promise<Outcome> {
  const gate = makeGate(provider, { allowOpenAccess: true, ...(allowCrossSite ? { allowCrossSite: true } : {}) } as never);
  const r = mk(h);
  if (await gate.allowP(r, 'agents:run')) return { status: 200 };
  const res = gate.deny(r, 'write');
  const body = (await res.json()) as { code?: string };
  return { status: res.status, ...(body.code ? { code: body.code } : {}) };
}
async function viaDoor(provider: AuthProvider | undefined, allowCrossSite: boolean, h: Record<string, string>): Promise<Outcome> {
  const door = doorGate({
    door: 'createChatRoute',
    ...(provider ? { identify: async (req: Request) => (await provider.authenticate(req)) ?? undefined, authorize: provider.authorize } : {}),
    ...(allowCrossSite ? { allowCrossSite: true } : {}),
  });
  const a = await door(mk(h), { permission: 'agents:run' });
  if (!('refused' in a)) return { status: 200 };
  return { status: a.refused.status, ...(a.refused.body.code ? { code: a.refused.body.code } : {}) };
}

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });

describe('open-surface parity — gate and door answer every cell alike', () => {
  it('matrix: provider(no provider | principal × verdict) × shape × allowCrossSite', async () => {
    const cells: { cell: string; gate: Outcome; door: Outcome }[] = [];
    const providers: [string, AuthProvider | undefined][] = [['no-provider', undefined]];
    for (const [pn, p] of Object.entries(principals)) for (const [vn, v] of Object.entries(verdicts)) {
      providers.push([`${pn}/${vn}`, { authenticate: () => p, authorize: () => v }]);
    }
    for (const [pname, provider] of providers) for (const [sname, h] of Object.entries(shapes)) for (const xs of [false, true]) {
      const gate = await viaGate(provider, xs, h);
      const door = await viaDoor(provider, xs, h);
      cells.push({ cell: `${pname} | ${sname} | allowCrossSite=${xs}`, gate, door });
    }
    const differ = cells.filter((c) => JSON.stringify(c.gate) !== JSON.stringify(c.door));
    console.log(`PARITY cells=${cells.length} differ=${differ.length}`);
    for (const d of differ) console.log(`PARITY-DIFF ${d.cell}: gate=${JSON.stringify(d.gate)} door=${JSON.stringify(d.door)}`);
    expect(differ).toEqual([]);
  });
});
