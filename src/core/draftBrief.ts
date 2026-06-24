import { AuditDatabase } from './AuditDatabase.js';
import { dbPathFor } from './paths.js';
import { gscFreshness } from './gscFreshness.js';
import { scorePassages } from './reranker.js';

export interface DraftBrief {
  url: string;
  topQuery: string | null;
  gap: string;
  maxPassageScore: number | null;
  voice: { heading: string; text: string }[];   // the page's OWN passages — the voice to match
  facts: { heading: string; text: string; relevance: number }[]; // reranked, most-relevant existing content — grounding
  brief: string;
}

/**
 * Assemble a GROUNDED writing brief for a page so the host model (Claude) can draft the fix in the
 * author's own voice — no bundled LLM. The page's existing chunks supply both the voice exemplars
 * (match tone/pace/lexicon) and the facts (the reranker picks the most query-relevant ones), so the
 * draft is phrased from the site's own material, never invented. urlKey omitted → the weakest
 * (lowest max_passage_score) page.
 */
export async function buildDraftBrief(
  dataDir: string,
  siteUrl: string,
  urlKey?: string,
): Promise<DraftBrief | { error: string }> {
  const db = new AuditDatabase(dbPathFor(dataDir, siteUrl));
  try {
    const sel = 'SELECT url_key url, body_chunks bc, max_passage_score mps, max_passage_query mpq, title FROM pages';
    const page = (urlKey
      ? db.db.prepare(`${sel} WHERE url_key = ?`).get(urlKey)
      : db.db.prepare(`${sel} WHERE max_passage_score IS NOT NULL AND body_chunks IS NOT NULL ORDER BY max_passage_score ASC LIMIT 1`).get()
    ) as { url: string; bc: string | null; mps: number | null; mpq: string | null; title: string | null } | undefined;
    if (!page) return { error: `No such page${urlKey ? ` ${urlKey}` : ''}.` };
    if (!page.bc) return { error: 'Page has no body_chunks — run start_crawl (then score_passages) first.' };

    let chunks: { heading?: string; text?: string }[];
    try { chunks = JSON.parse(page.bc); } catch { return { error: 'Could not parse body_chunks.' }; }
    chunks = chunks.filter(c => c.text && c.text.length > 40);

    // Top query: the one the page was scored against; else the highest-impression GSC query.
    let topQuery = page.mpq;
    if (!topQuery) {
      const maxDate = gscFreshness(db.db).effectiveMax;
      if (maxDate) {
        const q = db.db.prepare(
          `SELECT query FROM search_analytics WHERE page_key = ? AND query IS NOT NULL AND date <= '${maxDate}' AND date > date('${maxDate}','-28 days') GROUP BY query ORDER BY SUM(impressions) DESC LIMIT 1`,
        ).get(page.url) as { query: string } | undefined;
        topQuery = q?.query ?? null;
      }
    }

    // Grounding facts — rerank the page's own chunks against the query, keep the most relevant.
    let facts: DraftBrief['facts'] = [];
    if (topQuery && chunks.length) {
      const passages = chunks.map(c => `${c.heading ? `${c.heading}. ` : ''}${c.text}`);
      const scores = await scorePassages(topQuery, passages);
      facts = chunks.map((c, i) => ({ heading: c.heading ?? '', text: (c.text ?? '').slice(0, 500), relevance: Math.round((scores[i] ?? 0) * 100) / 100 }))
        .sort((a, b) => b.relevance - a.relevance).slice(0, 4);
    } else {
      facts = chunks.slice(0, 4).map(c => ({ heading: c.heading ?? '', text: (c.text ?? '').slice(0, 500), relevance: 0 }));
    }

    // Voice exemplars — a couple of the page's substantial passages (tone/pace/lexicon to match).
    const voice = chunks.filter(c => (c.text ?? '').length > 120).slice(0, 2).map(c => ({ heading: c.heading ?? '', text: (c.text ?? '').slice(0, 450) }));

    const gap = page.mps == null ? 'not scored (run score_passages)'
      : page.mps < 3 ? `weak-passage (best passage scores ${page.mps} — no section confidently answers the query)`
        : `the page already answers this (score ${page.mps}) — consider a refresh/expansion instead`;

    const brief = [
      `Make the SMALLEST change that closes the gap for the query “${topQuery ?? '(unknown)'}”: draft ONE self-contained passage to slot in (a clear heading + ~50–90 words) — not a rewrite. Preserve the rest of the page; this is a surgical addition (less intervention is better).`,
      `Lead with a one-sentence direct answer, then support it.`,
      `VOICE: match the tone, pace and lexicon of the voice samples exactly — first-person, from someone who owns and uses the gear, naming specific products. British English, contractions, no tidy "in conclusion" bow.`,
      `AVOID AI slop: no em dashes; no clichés ("landscape", "elevate", "whether you're…", "in today's…", "dive in", "it's worth noting"); no formal-transition padding.`,
      `GROUND STRICTLY: use only facts present in the facts/voice content below — invent no specs, prices, dates or claims. If a needed fact is missing, write around what's there and flag the gap rather than guessing.`,
    ].join(' ');

    return { url: page.url, topQuery, gap, maxPassageScore: page.mps, voice, facts, brief };
  } finally {
    db.close();
  }
}
