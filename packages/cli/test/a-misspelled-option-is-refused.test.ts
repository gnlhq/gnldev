// The options objects @gnldev/cli reads refuse a name they do not take (@gnldev/options): gnl.config
// (defineConfig) and the scaffold. A misspelled `studio` or `port` in gnl.config used to be ignored by
// gnl dev without a word.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, loadConfig } from '../src/config.js';
import { scaffold } from '../src/scaffold.js';

describe('@gnldev/cli: a misspelled option is refused', () => {
  it('defineConfig', () => {
    expect(() => defineConfig({ agents: {}, prot: 3000 } as any)).toThrow(/defineConfig: `prot` .* did you mean `port`\?/);
    expect(() => defineConfig({ agents: {}, port: 3000, studio: true, title: 'x' } as any)).not.toThrow();
  });
  it('a gnl.config written without defineConfig is held to the same names when it is read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gnl-cfg-'));
    const file = join(dir, 'gnl.config.mjs');
    writeFileSync(file, 'export default { journal: { get: async () => undefined, put: async () => undefined }, agents: {}, studoi: true };\n');
    await expect(loadConfig(file)).rejects.toThrow(/gnl\.config \(.*gnl\.config\.mjs\): `studoi` .* did you mean `studio`\?/);
  });
  it('scaffold', async () => {
    await expect((async () => scaffold('/nonexistent-dir-for-test', { nam: 'x' } as any))()).rejects.toThrow(/scaffold: `nam` .* did you mean `name`\?/);
  });
});
