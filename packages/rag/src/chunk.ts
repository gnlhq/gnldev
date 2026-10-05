// Chunking helpers — the common `document.chunk()` shape (code-first, class-free).
// `chunkText` splits raw text into chunks; `chunkDocuments` splits VectorDocs and produces a new
// VectorDoc list ready for `indexDocuments` (id: `<docId>#<i>`, metadata inherited + a reserved `__gnlDoc` trail).
// Strategies:
// 'recursive' (default): splits preferring paragraph → line → sentence → word boundaries
//     (the general-purpose strategy with the highest semantic coherence).
// 'markdown': splits by heading hierarchy; adds a `heading` breadcrumb metadata to each chunk
//     (for context display during retrieval), large text within a section is split recursively.
// 'character': fixed window (fastest; when boundary quality doesn't matter).
import { VECTOR_DOCUMENT_KEY } from '@gnldev/durable';
import type { VectorDoc } from './vector-store.js';
import { refuseUnknownNames } from '@gnldev/options';
import { CHUNK_TEXT_OPTS_NAMES, CHUNK_DOCUMENTS_OPTS_NAMES } from './option-names.js';

export interface ChunkOptions {
  /**
   * The longest a chunk may be (characters, UTF-16 code units), overlap included. Default 1200.
   * A hard cut never splits a surrogate pair, so with `size: 1` an astral character is a chunk of 2.
   */
  size?: number;
  /**
   * The most a chunk repeats of the one before it (characters, must be smaller than size). Default 120.
   * A chunk carries less, or none, when its own text leaves less room than this under `size`.
   */
  overlap?: number;
  strategy?: 'recursive' | 'markdown' | 'character';
}

/** Chunk + (in markdown) heading trail. */
export interface Chunk {
  text: string;
  /** heading breadcrumb of the section in the markdown strategy (e.g. "Setup > Docker"). */
  heading?: string;
}

const DEFAULT_SIZE = 1200;
const DEFAULT_OVERLAP = 120;

function resolveOpts(opts?: ChunkOptions): { size: number; overlap: number; strategy: NonNullable<ChunkOptions['strategy']> } {
  const size = opts?.size ?? DEFAULT_SIZE;
  const overlap = opts?.overlap ?? Math.min(DEFAULT_OVERLAP, Math.floor(size / 4));
  if (size < 1) throw new Error('@gnldev/rag chunk: size must be >= 1');
  if (overlap < 0 || overlap >= size) throw new Error('@gnldev/rag chunk: 0 <= overlap < size must hold');
  return { size, overlap, strategy: opts?.strategy ?? 'recursive' };
}

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/**
 * Where a cut of `text[start, end)` may end: `end`, or one earlier when `end` would split a surrogate
 * pair. Cutting a pair in half left a chunk ending in a lone high surrogate and the next starting with
 * a lone low one — text no encoder round-trips. When the pair is the whole window (`size` 1), it is kept
 * whole rather than split.
 */
function cutEnd(text: string, start: number, end: number): number {
  if (end <= start || end >= text.length) return Math.min(end, text.length);
  if (!(isHigh(text.charCodeAt(end - 1)) && isLow(text.charCodeAt(end)))) return end;
  return end - 1 > start ? end - 1 : end + 1;
}

/** Where a cut may start: `start`, or one later when `start` is the second half of a surrogate pair. */
function cutStart(text: string, start: number): number {
  return start > 0 && start < text.length && isLow(text.charCodeAt(start)) && isHigh(text.charCodeAt(start - 1)) ? start + 1 : start;
}

/** `text` cut into windows of at most `size`, consecutive windows sharing `overlap` characters. */
function windows(text: string, size: number, overlap: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length;) {
    const end = cutEnd(text, i, i + size);
    out.push(text.slice(i, end));
    if (end >= text.length) break;
    i = Math.max(i + 1, cutStart(text, end - overlap));
  }
  return out;
}

/** Separator priority list: paragraph → line → sentence → word. Last resort: hard cut. */
const SEPARATORS = ['\n\n', '\n', '. ', ' '];

/** GREEDILY merges pieces up to the target size (preserving the separator); a piece that alone stays over size passes through as-is. */
function mergeGreedy(pieces: string[], sep: string, size: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const p of pieces) {
    const joined = cur === '' ? p : cur + sep + p;
    if (joined.length <= size || cur === '') cur = joined;
    else {
      out.push(cur);
      cur = p;
    }
  }
  if (cur !== '') out.push(cur);
  return out;
}

/** Recursive split: start from the coarsest separator; any unit exceeding size is re-split with the next separator. */
function splitRecursive(text: string, size: number, sepIdx = 0): string[] {
  if (text.length <= size) return text.trim() === '' ? [] : [text];
  if (sepIdx >= SEPARATORS.length) {
    return windows(text, size, 0); // no natural boundary left → hard cut
  }
  const sep = SEPARATORS[sepIdx]!;
  const pieces = text.split(sep).filter((p) => p.trim() !== '');
  if (pieces.length <= 1) return splitRecursive(text, size, sepIdx + 1);
  const merged = mergeGreedy(pieces, sep, size);
  return merged.flatMap((m) => (m.length <= size ? [m] : splitRecursive(m, size, sepIdx + 1)));
}

/** Prepend to each chunk but the first as much of the previous chunk's tail as fits under `size`, up to `overlap`. */
function applyOverlap(chunks: string[], overlap: number, size: number): string[] {
  if (overlap === 0 || chunks.length <= 1) return chunks;
  return chunks.map((c, i) => {
    if (i === 0) return c;
    const prev = chunks[i - 1]!;
    const room = Math.min(overlap, size - c.length, prev.length);
    return room > 0 ? prev.slice(cutStart(prev, prev.length - room)) + c : c;
  });
}

/**
 * The one rule for a chunk's length in the recursive and markdown strategies: text that fits in
 * `size` is one chunk; longer text is split into pieces of at most `size`, and each piece but the first
 * is prefixed with as much of the one before as fits, up to `overlap` — so no chunk exceeds `size`.
 *
 * The overlap used to be added on top (`size: 200, overlap: 50` gave 250-character chunks). A first fix
 * split at `size - overlap` to make room for it, and doubled the chunks of ordinary prose: a 1,100-
 * character paragraph at the defaults became two, so embedding calls and storage doubled (192 chunks
 * where 102 fit). Measured with real embedders (two models, two question sets, 200 questions), the
 * smaller overlap of the fitted chunks did not lower retrieval (within ±3 points, no direction).
 */
function splitBounded(text: string, size: number, overlap: number): string[] {
  if (text.length <= size) return text.trim() === '' ? [] : [text];
  return applyOverlap(splitRecursive(text, size), overlap, size);
}

/** Section the markdown by heading hierarchy: each section = breadcrumb + body. */
function splitMarkdownSections(text: string): { heading?: string; body: string }[] {
  const lines = text.split('\n');
  const sections: { heading?: string; body: string }[] = [];
  const crumbs: { level: number; title: string }[] = [];
  let buf: string[] = [];
  const flush = () => {
    const body = buf.join('\n');
    if (body.trim() !== '') {
      const heading = crumbs.map((c) => c.title).join(' > ') || undefined;
      sections.push({ heading, body });
    }
    buf = [];
  };
  for (const line of lines) {
    const m = /^(#{1,6})\s+(.+)$/.exec(line);
    if (m) {
      flush();
      const level = m[1]!.length;
      while (crumbs.length && crumbs[crumbs.length - 1]!.level >= level) crumbs.pop();
      crumbs.push({ level, title: m[2]!.trim() });
    } else {
      buf.push(line);
    }
  }
  flush();
  return sections;
}

/** Split raw text into chunks (strategy + size + overlap). */
export function chunkText(text: string, opts?: ChunkOptions): Chunk[] {
  refuseUnknownNames('chunkText', opts, CHUNK_TEXT_OPTS_NAMES);
  const { size, overlap, strategy } = resolveOpts(opts);
  if (text.trim() === '') return [];
  if (strategy === 'character') return windows(text, size, overlap).map((t) => ({ text: t }));
  if (strategy === 'markdown') {
    return splitMarkdownSections(text).flatMap(({ heading, body }) =>
      splitBounded(body.trim(), size, overlap).map((t) => ({ text: t, ...(heading ? { heading } : {}) })),
    );
  }
  return splitBounded(text, size, overlap).map((t) => ({ text: t }));
}

/**
 * The metadata keys a chunk carries to say which document it belongs to, and where in it.
 *
 * Reserved, so they never share a key with the user's own metadata. The trail used to be
 * `source`/`chunk`, which is also what people call their own provenance field: every chunk of a
 * document overwrote the user's `source`, and deleting the document `handbook` deleted every record
 * the user had labelled `source: 'handbook'` — records that were never chunks at all.
 */
/** Owned by @gnldev/durable, whose stores index it (`VECTOR_DOCUMENT_KEY`). */
export const DOC_TRAIL_KEY = VECTOR_DOCUMENT_KEY;
export const CHUNK_TRAIL_KEY = '__gnlChunk';
/** The generation an `ingestDocuments` write belongs to — see `ingestDocuments`. */
export const GEN_TRAIL_KEY = '__gnlGen';

/**
 * A document id as it appears inside a vector id: `%` and `#` escaped, so a document's own id never
 * contains `#`. A chunk id is `<escaped>#<i>`, and the one-chunk form is `<escaped>` alone — so no
 * document's id is another's chunk id. Without the escape, a document named `guide#1` was stored
 * under the id of `guide`'s second chunk, and ingesting either one overwrote or deleted the other.
 * An id with neither character is unchanged.
 */
export function documentIdPart(docId: string): string {
  return docId.replace(/%/g, '%25').replace(/#/g, '%23');
}

/**
 * Split documents → VectorDoc list ready for `indexDocuments`. Chunk id is `<docId>#<i>`, or the
 * document's own id when it fits in one chunk, with `%`/`#` in the document id escaped (see
 * `documentIdPart`). Every chunk carries the trail `{ __gnlDoc: docId, __gnlChunk: i }` beside the
 * document's own metadata, which is left as it was (and a `heading` breadcrumb in markdown);
 * `namespace`, `owner` and `shared` are inherited as they are.
 *
 * Deterministic ids do NOT make re-indexing an edited document safe on their own: when the new text
 * yields fewer chunks, `indexDocuments` (upsert) leaves the old tail chunks in place. Use
 * `ingestDocuments`, which removes a document's chunks by their trail before writing its new ones.
 */
export function chunkDocuments(docs: VectorDoc[], opts?: ChunkOptions): VectorDoc[] {
  refuseUnknownNames('chunkDocuments', opts, CHUNK_DOCUMENTS_OPTS_NAMES);
  const { size } = resolveOpts(opts);
  const out: VectorDoc[] = [];
  for (const doc of docs) {
    const chunks = chunkText(doc.text, opts);
    const idPart = documentIdPart(doc.id);
    // One chunk is stored as the whole document only when the whole document fits: a markdown section
    // can fit while its heading lines push the document past `size` (measured: 108 characters at
    // `size: 100`). That one chunk is then written as chunk 0, with its `heading`.
    if (chunks.length === 0 || (chunks.length === 1 && doc.text.length <= size)) {
      // Not split → the document's own text, under its own (escaped) id, with the trail.
      out.push({ ...doc, id: idPart, metadata: { ...doc.metadata, [DOC_TRAIL_KEY]: doc.id, [CHUNK_TRAIL_KEY]: 0 } });
      continue;
    }
    chunks.forEach((c, i) => {
      out.push({
        id: `${idPart}#${i}`,
        text: c.text,
        metadata: { ...doc.metadata, ...(c.heading ? { heading: c.heading } : {}), [DOC_TRAIL_KEY]: doc.id, [CHUNK_TRAIL_KEY]: i },
        // Who may read a chunk is who may read its document. Dropping these put every chunk of an
        // organization's document in the un-namespaced partition, and every chunk of a user's own
        // document out of that user's reach.
        ...(doc.namespace !== undefined ? { namespace: doc.namespace } : {}),
        ...(doc.owner !== undefined ? { owner: doc.owner } : {}),
        ...(doc.shared ? { shared: true } : {}),
      });
    });
  }
  return out;
}
