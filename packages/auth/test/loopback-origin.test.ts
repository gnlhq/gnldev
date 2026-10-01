// "A page on this machine's own sites is not refused" — make the sentence true.
//
// Measured by the round-2 panel (review2-B doors/spa.mjs, real loopback socket, hono cors() in front of
// createChatRoute): a SPA on http://127.0.0.1:5173 calling http://localhost:3000 was refused 403
// cross_site_refused — the browser marks it `Sec-Fetch-Site: cross-site`, because 127.0.0.1 and
// localhost are different sites — while the refusal it carried said this machine's sites are not refused.
//
// Decision: a page served from a loopback origin (localhost, *.localhost, 127.0.0.0/8, [::1], any port)
// is not a cross-site page. A browser resolves those names to itself (RFC 6761) and an IP literal names
// no DNS a stranger controls, so no page on the internet can carry such an Origin — and the browser
// writes Origin, no page can forge it. The threat this check exists for (a form on ANY website) is
// unchanged: every non-loopback Origin, `null` included, is still cross-site.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isCrossSiteStateChange, crossSiteRefusedMessage, makeGate } from '../src/index.js';

const post = (headers: Record<string, string>, url = 'http://localhost:3000/agents/a/chat') => new Request(url, { method: 'POST', headers, body: '{}' });

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });

describe('a loopback origin is this machine', () => {
  it('panel case: 127.0.0.1:5173 → localhost:3000 (Sec-Fetch-Site: cross-site) is not a cross-site state change', () => {
    expect(isCrossSiteStateChange(post({ origin: 'http://127.0.0.1:5173', 'sec-fetch-site': 'cross-site' }))).toBe(false);
  });

  it('siblings that pass: localhost → 127.0.0.1, [::1], 127.0.0.2, *.localhost, and the same with no Fetch Metadata', () => {
    for (const [origin, url] of [
      ['http://localhost:5173', 'http://127.0.0.1:3000/x'],
      ['http://[::1]:5173', 'http://localhost:3000/x'],
      ['http://127.0.0.2:8080', 'http://localhost:3000/x'],
      ['http://app.localhost:5173', 'http://127.0.0.1:3000/x'],
    ]) {
      expect(isCrossSiteStateChange(post({ origin, 'sec-fetch-site': 'cross-site' }, url)), origin).toBe(false);
      expect(isCrossSiteStateChange(post({ origin }, url)), `${origin} (no SFS)`).toBe(false);
    }
  });

  it('siblings still refused: a public site, a name that only looks local, an opaque origin, a cross-site request with no Origin', () => {
    for (const origin of ['https://evil.example', 'http://127.0.0.1.nip.io:5173', 'http://localhost.evil.com', 'null', 'http://192.168.1.5:5173']) {
      expect(isCrossSiteStateChange(post({ origin, 'sec-fetch-site': 'cross-site' })), origin).toBe(true);
    }
    expect(isCrossSiteStateChange(post({ 'sec-fetch-site': 'cross-site' }))).toBe(true);
  });

  it('the REST gate (same owner) answers the panel case too', async () => {
    const gate = makeGate(undefined, { allowOpenAccess: true });
    expect(await gate.allow(post({ host: 'localhost:3000', origin: 'http://127.0.0.1:5173', 'sec-fetch-site': 'cross-site' }), 'write')).toBe(true);
    expect(await gate.allow(post({ host: 'localhost:3000', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }), 'write')).toBe(false);
  });

  it('the message says what is true: loopback pages on any port, not "this machine\'s sites" in general', () => {
    const m = crossSiteRefusedMessage('x');
    expect(m).toContain('localhost, *.localhost, 127.0.0.1 or [::1], on any port');
  });
});
