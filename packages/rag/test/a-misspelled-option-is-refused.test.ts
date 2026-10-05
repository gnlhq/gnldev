// Every options object @gnldev/rag reads refuses a name it does not take (@gnldev/options), naming the
// option it is closest to.
import { describe, it, expect } from 'vitest';
import { InMemoryVectorStore, PostgresVectorStore, llmReranker, chunkText, chunkDocuments, ingestDocuments, deleteDocuments, indexDocuments, GraphRag, SemanticMemory } from '../src/index.js';

const embed = async (texts: string[]) => texts.map(() => [1, 0, 0]);
const store = () => new InMemoryVectorStore();

describe('@gnldev/rag: a misspelled option is refused', () => {
  it.each([
    ['chunkText', () => chunkText('a b c', { overlapp: 1 } as any), /chunkText: `overlapp` .* did you mean `overlap`\?/],
    ['chunkDocuments', () => chunkDocuments([], { sise: 10 } as any), /chunkDocuments: `sise` .* did you mean `size`\?/],
    ['ingestDocuments', () => ingestDocuments(store(), embed, [], { concurency: 2 } as any), /ingestDocuments: `concurency` .* did you mean `concurrency`\?/],
    ['indexDocuments', () => indexDocuments(store(), embed, [], { concurency: 2 } as any), /indexDocuments: `concurency`/],
    ['deleteDocuments', () => deleteDocuments(store(), [], { namepace: 'x' } as any), /deleteDocuments: `namepace` .* did you mean `namespace`\?/],
    ['llmReranker', () => llmReranker({ modle: {} } as any), /llmReranker: `modle` .* did you mean `model`\?/],
    ['GraphRag', () => new GraphRag({ hop: 2 } as any), /GraphRag: `hop` .* did you mean `hops`\?/],
    ['PostgresVectorStore', () => new PostgresVectorStore({ tabel: 'x' } as any), /PostgresVectorStore: `tabel` .* did you mean `table`\?/],
    ['InMemoryVectorStore#query', () => store().query([1, 0, 0], 3, { namepace: 'x' } as any), /query: `namepace` .* did you mean `namespace`\?/],
    ['GraphRag#query', () => new GraphRag().query([1, 0, 0], 3, { minscore: 0.5 } as any), /query: `minscore` .* did you mean `minScore`\?/],
    ['SemanticMemory#getMessages', () => new SemanticMemory({ journal: { get: async () => undefined, put: async () => undefined, listKeys: async () => [] } as any, embed }).getMessages('t', { treshold: 0.5 } as any), /getMessages: `treshold` .* did you mean `threshold`\?/],
    ['SemanticMemory', () => new SemanticMemory({ journal: {} as any, embed, topk: 3 } as any), /SemanticMemory: `topk` .* did you mean `topK`\?/],
  ])('%s', async (_n, build, message) => {
    await expect((async () => build())()).rejects.toThrow(message);
  });
});
