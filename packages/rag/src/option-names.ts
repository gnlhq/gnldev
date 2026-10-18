// The names of every options object @gnldev/rag reads, each held to its parameter's type by the
// compiler (@gnldev/options `optionNames`): an option added to a type and not here fails typecheck. A
// name not listed is refused where the bag is read, naming the option it is closest to.
import { optionNames } from '@gnldev/options';

export const INDEX_DOCUMENTS_OPTS_NAMES = optionNames<NonNullable<Parameters<typeof import('./vector-store.js').indexDocuments>[3]>>()(['concurrency']);
export const QDRANT_VECTOR_STORE_NAMES = optionNames<NonNullable<ConstructorParameters<typeof import('./qdrant-vector-store.js').QdrantVectorStore>[0]>>()(['url', 'apiKey', 'collection', 'dimension']);
export const POSTGRES_VECTOR_STORE_NAMES = optionNames<NonNullable<ConstructorParameters<typeof import('./postgres-vector-store.js').PostgresVectorStore>[0]>>()(['connectionString', 'pool', 'table', 'dimension', 'index']);
export const LLM_RERANKER_NAMES = optionNames<NonNullable<Parameters<typeof import('./rerank.js').llmReranker>[0]>>()(['model']);
export const CHUNK_TEXT_OPTS_NAMES = optionNames<NonNullable<Parameters<typeof import('./chunk.js').chunkText>[1]>>()(['size', 'overlap', 'strategy']);
export const CHUNK_DOCUMENTS_OPTS_NAMES = optionNames<NonNullable<Parameters<typeof import('./chunk.js').chunkDocuments>[1]>>()(['size', 'overlap', 'strategy']);
export const INGEST_DOCUMENTS_OPTS_NAMES = optionNames<NonNullable<Parameters<typeof import('./ingest.js').ingestDocuments>[3]>>()(['size', 'overlap', 'strategy', 'concurrency']);
export const DELETE_DOCUMENTS_OPTS_NAMES = optionNames<NonNullable<Parameters<typeof import('./ingest.js').deleteDocuments>[2]>>()(['namespace']);
export const GRAPH_RAG_NAMES = optionNames<NonNullable<ConstructorParameters<typeof import('./graph-rag.js').GraphRag>[0]>>()(['threshold', 'hops', 'decay', 'seeds']);
export const SEMANTIC_MEMORY_NAMES = optionNames<NonNullable<ConstructorParameters<typeof import('./semantic-memory.js').SemanticMemory>[0]>>()(['journal', 'embed', 'recentN', 'topK']);
export const QUERY_NAMES = optionNames<import('./vector-store.js').QueryOptions>()(['namespace', 'visibleTo', 'filter', 'minScore', 'text', 'keywordWeight']);
export const SEMANTIC_GET_MESSAGES_NAMES = optionNames<import('./semantic-memory.js').SemanticGetMessagesOptions>()(['query', 'threshold', 'messageRange', 'filter']);
