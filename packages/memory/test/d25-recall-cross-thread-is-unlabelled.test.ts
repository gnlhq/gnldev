// d25 finding 5 (measurement, not a verdict): what the model is shown when resource-scope recall brings
// an OLD conversation's request into a new one. One fact is asserted as the current behaviour.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage } from '@gnldev/durable';
import { AgentMemory } from '../src/index.js';

const embed = async (t: string) => (/kampanya/i.test(t) ? [1, 0] : [0, 1]);
describe('resource-scope recall into a new thread', () => {
  it('FACT 1: an old thread\'s user request arrives as a plain user message, with no marker of where it came from', async () => {
    const storage = new InMemoryStorage();
    const mem = new AgentMemory({ storage, embed, recentN: 2, recall: { scope: 'resource', topK: 2 } });
    await storage.memory.upsertThread({ id: 'old', resourceId: 'u', createdAt: 1, updatedAt: 1 });
    await storage.memory.upsertThread({ id: 'new', resourceId: 'u', createdAt: 2, updatedAt: 2 });
    await mem.append('old', [{ role: 'user', content: 'kampanya A için kayıt aç' }]);
    const msgs = await mem.getMessages('new', { query: 'kampanya B ne durumda', resourceId: 'u' });
    expect(msgs).toEqual([{ role: 'user', content: 'kampanya A için kayıt aç' }]);
  });
});
