// `gnl dev` states "auth: open" at boot; `gnl doctor` said nothing about it, and `GET /agents` hands
// every agent's system prompt to whoever can reach the port. The doctor now says it, and says
// nothing when a credential is configured.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commands } from '../src/commands/index.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const dirs: string[] = [];
const ENV = ['GNL_SUPERADMIN_TOKEN', 'GNL_ADMIN_TOKEN', 'GNL_CLIENT_TOKEN', 'GNL_VIEWER_TOKEN', 'GNL_END_USER_SECRET', 'GNL_LICENSE_KEY'];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

async function doctorOutput(configBody: string): Promise<string> {
  for (const k of ENV) delete process.env[k];
  const dir = mkdtempSync(join(here, 'doctor-open-'));
  dirs.push(dir);
  const path = join(dir, 'gnl.config.ts');
  writeFileSync(path, `import { InMemoryStorage } from '@gnldev/durable';\nexport default { storage: new InMemoryStorage(), agents: {}, ${configBody} };\n`);
  const out: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
  await commands.doctor!.run({ argv: ['--config', path] });
  return out.join('\n');
}

describe('gnl doctor: who can call the API', () => {
  it('says the API is open, and that /agents lists the system prompts, when no credential is configured', async () => {
    const said = await doctorOutput('');
    expect(said).toContain('api access: open');
    expect(said).toContain('GET /agents');
    expect(said).toContain('system prompt');
  });

  it('says nothing about it when a credential is configured', async () => {
    const said = await doctorOutput("auth: { admin: { token: 'a-long-enough-random-admin-token-value' } }");
    expect(said).not.toContain('api access: open');
  });
});
