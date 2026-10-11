import { AuditDatabase } from './AuditDatabase.js';
import { dbPathFor } from './paths.js';
import { embed, cosine } from './embeddings.js';

/** Default "near-duplicate" bar. all-MiniLM cosine runs ~0.95+ for near-identical pages, ~0.6-0.85
 * for same-topic-but-distinct, so 0.90 isolates genuine duplicates/boilerplate variants from mere
 * topical overlap. Tunable per call. */
export const NEAR_DUP_THRESHOLD = 0.9;
export const SIMILARITY_NOTE =
  'Cosine similarity of local all-MiniLM-L6-v2 sentence embeddings (0-1; 1 = identical meaning). The model reads ~the first 200 words of title+body, so it catches templated/boilerplate near-duplicates and thin variants; two pages that differ only in a late section may look more similar than they read. Judgement (N): verify a flagged pair before consolidating.';

export interface NearDupPair { a: string; b: string; similarity: number }
export interface NearDuplicateResult {
  embedded: number;          // pages embedded + compared
  threshold: number;
  scale: string;
  capped: boolean;           // more candidate pages existed than the cap
  cap: number;
  pairs: NearDupPair[];      // distinct unordered pairs >= threshold (capped for output)
  pairsTotal: number;
  pagesWithDuplicate: number;
}

/** Hard ceiling on pairs collected/stored — a heavily templated site can push ~n^2/2 pairs, so cap
 * the in-memory array and the DB write (highest-similarity kept). maxPairsReturned caps only output. */
const PAIR_CAP = 5000;

/**
 * Embed each indexable HTML page's title+body and flag pairs whose cosine similarity clears the
 * threshold — the semantic near-duplicate / content-cannibalisation signal. Local embeddings (no API
 * cost). On-demand (ML inference), bounded by `limit`. Persists distinct pairs to `near_duplicates`;
 * powers the `near-duplicate-content` check.
 */
export async function findNearDuplicates(
  dataDir: string,
  siteUrl: string,
  opts: { threshold?: number; limit?: number; maxPairsReturned?: number } = {},
): Promise<NearDuplicateResult> {
  const threshold = opts.threshold ?? NEAR_DUP_THRESHOLD;
  const cap = opts.limit ? Math.floor(opts.limit) : 500;
  const db = new AuditDatabase(dbPathFor(dataDir, siteUrl));
  try {
    const empty: NearDuplicateResult = { embedded: 0, threshold, scale: SIMILARITY_NOTE, capped: false, cap, pairs: [], pairsTotal: 0, pagesWithDuplicate: 0 };
    // Indexable HTML pages with extractable body. Order by word_count so, when capped, we compare the
    // real content pages (not thin shells). +1 to detect whether the cap actually bit.
    const rows = db.db.prepare(
      `SELECT url_key urlKey, title, body_chunks bc FROM pages
       WHERE status_code=200 AND indexable=1 AND body_chunks IS NOT NULL
       ORDER BY word_count DESC LIMIT ${cap + 1}`,
    ).all() as { urlKey: string; title: string | null; bc: string }[];
    const capped = rows.length > cap;
    const candidates = rows.slice(0, cap);
    if (candidates.length < 2) return { ...empty, capped };

    const texts = candidates.map(r => {
      let chunks: { heading?: string; text?: string }[] = [];
      try { chunks = JSON.parse(r.bc); } catch { /* leave empty */ }
      const body = chunks.map(c => `${c.heading ? `${c.heading}. ` : ''}${c.text || ''}`).join(' ');
      return `${r.title ?? ''}. ${body}`.replace(/\s+/g, ' ').trim().slice(0, 3000);
    });
    const vecs = await embed(texts);

    // Pairwise cosine. O(n^2) but n<=cap and each dot is 384 mults — trivial for a few hundred pages.
    // Order each pair's keys lexically so url_key_a is the smaller (matches the schema/PK contract and
    // gives canonical unordered pairs), and stop collecting at PAIR_CAP so a fully-templated site can't
    // push ~n^2/2 pairs into memory and the DB.
    const pairs: NearDupPair[] = [];
    const flaggedKeys = new Set<string>();
    let pairCapHit = false;
    outer:
    for (let i = 0; i < vecs.length; i++) {
      for (let j = i + 1; j < vecs.length; j++) {
        const sim = cosine(vecs[i], vecs[j]);
        if (sim >= threshold) {
          const ka = candidates[i].urlKey, kb = candidates[j].urlKey;
          const [a, b] = ka < kb ? [ka, kb] : [kb, ka];
          pairs.push({ a, b, similarity: Math.round(sim * 1000) / 1000 });
          flaggedKeys.add(ka); flaggedKeys.add(kb);
          if (pairs.length >= PAIR_CAP) { pairCapHit = true; break outer; }
        }
      }
    }
    pairs.sort((x, y) => y.similarity - x.similarity);

    // Persist (DELETE + rewrite — a fresh run supersedes the last).
    db.db.exec('DELETE FROM near_duplicates');
    const ins = db.db.prepare(`INSERT INTO near_duplicates (url_key_a, url_key_b, similarity, computed_at) VALUES (?,?,?,datetime('now'))`);
    db.db.transaction(() => { for (const p of pairs) ins.run(p.a, p.b, p.similarity); })();

    const outCap = opts.maxPairsReturned ?? 100;
    return {
      embedded: candidates.length, threshold, scale: SIMILARITY_NOTE, capped: capped || pairCapHit, cap,
      pairs: pairs.slice(0, outCap), pairsTotal: pairs.length, pagesWithDuplicate: flaggedKeys.size,
    };
  } finally {
    db.close();
  }
}
