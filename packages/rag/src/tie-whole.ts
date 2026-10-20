import { createHash } from 'node:crypto';

/** A digest of a vector's values: equal vectors, equal digests. Stored with each record, so a tie is read by it. */
export const vectorDigest = (v: number[]) => createHash('sha256').update(new Float64Array(v)).digest('hex').slice(0, 32);

/** Scores this close are equal: a server answers distances in float32. */
export const TIE_EPSILON = 1e-6;

/** Distinct vectors a tie is read by digest for; past it, the partition is read. */
const TIE_VECTORS = 8;

/** What `tieWhole` asks of a store whose search is approximate, all within the query's own partition and filter. */
export interface TieSource<H> {
  /** A hit's score and its vector's digest. */
  score(h: H): number;
  digest(h: H): string;
  /** The search's best record whose vector's digest is none of `digests`, if any. */
  bestOutside(digests: string[]): Promise<H | undefined>;
  /** Every record whose vector's digest is one of `digests` — or, without them, every record the query may see — scored exactly against the query. */
  scored(digests?: string[]): Promise<H[]>;
}

/**
 * `hits` with the tie at `score` read whole and scored exactly, for a store whose search is approximate
 * (HNSW) and, among equal vectors, does not reach them all — measured on Chroma (300 copies, 212–300
 * found) and Weaviate (3,000 copies, a limit of 4,000: 2,974–2,989 found, two collections). The port's
 * ranking (equal scores by id) then cuts topK.
 *
 * The tie's vectors are found one digest at a time: the store is asked for its best record outside the
 * digests found so far, and while that one ties too, its digest joins. Their copies are then read by
 * digest — an exact read, not a search. Past `TIE_VECTORS` distinct vectors the partition the query may
 * see is read instead. What scored above the tie is the search's answer, as away from a tie.
 */
export async function tieWhole<H>(hits: H[], score: number, src: TieSource<H>): Promise<H[]> {
  const ties = (h: H) => src.score(h) >= score - TIE_EPSILON;
  const keep = (found: H[]) => found.filter(ties);
  const digests = [...new Set(hits.filter(ties).map(src.digest))];
  for (;;) {
    if (digests.length > TIE_VECTORS) return keep(await src.scored());
    const outside = await src.bestOutside(digests);
    if (!outside || !ties(outside)) break;
    digests.push(src.digest(outside));
  }
  return [...hits.filter((h) => src.score(h) > score + TIE_EPSILON), ...keep(await src.scored(digests))];
}
