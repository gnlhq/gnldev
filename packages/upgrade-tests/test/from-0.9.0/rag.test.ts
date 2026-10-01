// Upgrade from 0.9.0, @gnldev/rag: vectors 0.9.0's `chunkDocuments` + `indexDocuments` wrote — multi-
// and one-chunk documents, ids with `#`, `%`, an id that looks escaped, unicode, a document whose
// chunk 1 was overwritten by a separate document called `x#1`, user `source` labels — and one record
// indexed without chunking whose user metadata says `source: 'handbook'`.
import { describe, expect, it } from 'vitest';
import { DOC_TRAIL_KEY, deleteDocuments, documentIdPart, ingestDocuments } from '@gnldev/rag';
import * as S from '../../generate/shapes.mjs';
import { itMigrates, openFixture, rawQuery } from '../support.js';

interface Row { id: string; meta: Record<string, unknown> | null }
const rows = (path: string): Row[] =>
  rawQuery<{ id: string; metadata: string | null }>(path, 'SELECT id, metadata FROM gnl_vectors ORDER BY id').map((r) => ({
    id: r.id,
    meta: r.metadata ? (JSON.parse(r.metadata).json ?? null) : null,
  }));

/**
 * The records 0.9.0 wrote FOR document `doc`, read off the 0.9.0 shapes: a one-chunk document under its
 * own id, a multi-chunk one as `<id>#<n>` carrying `source: id, chunk: n`. Not `x#1`'s record for `x`:
 * 0.9.0 overwrote x's chunk 1 with that document, so it is `x#1`'s now.
 */
const ownedOn090 = (all: Row[], doc: string) =>
  all.filter((r) => r.id === doc || (r.id.startsWith(`${doc}#`) && r.meta?.source === doc && typeof r.meta?.chunk === 'number' && r.id === `${doc}#${r.meta.chunk}`)).map((r) => r.id);

/** `ingestDocuments` writes `<id>#<i>@<generation>`; the generation is compared away. */
const ungen = (id: string) => id.replace(/@[0-9a-z]+$/, '');

/** The two id lists are the same set; a failure names the ids (`{ unexpected, missing }`) instead of a count. */
function expectIds(actual: string[], expected: string[]): void {
  const diff = {
    unexpected: actual.filter((id) => !expected.includes(id)).sort(),
    missing: expected.filter((id) => !actual.includes(id)).sort(),
  };
  expect(diff, JSON.stringify(diff)).toEqual({ unexpected: [], missing: [] });
}

describe('upgrade from 0.9.0 — rag', () => {
  itMigrates('rag.db');

  it('every 0.9.0 record is still found by a query', async () => {
    const f = openFixture('rag.db');
    const all = rows(f.path);
    const hits = await f.storage.vectors.query(await S.fixtureEmbed('multi paragraph 0'), all.length);
    expect(hits.map((h) => h.id).sort()).toEqual(all.map((r) => r.id).sort());
  });

  describe.each(S.RAG_DOCS.map((d) => [d.id]))('re-ingesting %s after the upgrade', (doc) => {
    it('leaves exactly its new chunk, and every other document\'s records as they were', async () => {
      const f = openFixture('rag.db');
      const before = rows(f.path);
      const old = ownedOn090(before, doc);
      expect(old.length, `the fixture holds 0.9.0 records for ${doc}`).toBeGreaterThan(0);
      await ingestDocuments(f.storage.vectors, S.fixtureEmbed, [{ id: doc, text: `now short ${doc}` }]);
      const after = rows(f.path);
      const fresh = after.filter((r) => r.meta?.[DOC_TRAIL_KEY] === doc).map((r) => ungen(r.id));
      expect(fresh).toEqual([`${documentIdPart(doc)}#0`]);
      const others = before.filter((r) => !old.includes(r.id)).map((r) => r.id);
      expectIds(after.map((r) => ungen(r.id)), [...others, `${documentIdPart(doc)}#0`]);
    });
  });

  describe.each(S.RAG_DOCS.map((d) => [d.id]))('deleteDocuments([%s]) after the upgrade', (doc) => {
    it('removes its 0.9.0 records and nothing else', async () => {
      const f = openFixture('rag.db');
      const before = rows(f.path);
      const old = ownedOn090(before, doc);
      await deleteDocuments(f.storage.vectors, [doc]);
      expectIds(rows(f.path).map((r) => r.id), before.filter((r) => !old.includes(r.id)).map((r) => r.id));
    });
  });

  it('deleting every document leaves only the record that was never a document', async () => {
    const f = openFixture('rag.db');
    await deleteDocuments(f.storage.vectors, S.RAG_DOCS.map((d) => d.id));
    expectIds(rows(f.path).map((r) => r.id), S.RAG_RAW.map((d) => d.id));
  });

  it("deleteDocuments(['handbook']) does not delete the 0.9.0 record the user labelled source: 'handbook'", async () => {
    const f = openFixture('rag.db');
    const before = rows(f.path).length;
    expect(await deleteDocuments(f.storage.vectors, ['handbook'])).toBe(0);
    expect(rows(f.path)).toHaveLength(before);
  });

  it("re-ingesting a document keeps the user's own source label next to the trail", async () => {
    const f = openFixture('rag.db');
    const single = S.RAG_DOCS.find((d) => d.id === 'single')!;
    await ingestDocuments(f.storage.vectors, S.fixtureEmbed, [single]);
    const row = rows(f.path).find((r) => ungen(r.id) === 'single#0');
    expect(row?.meta).toMatchObject({ source: 'confluence', team: 'a', [DOC_TRAIL_KEY]: 'single' });
  });
});
