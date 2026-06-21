import { AuditDatabase } from './AuditDatabase.js';
import { WikidataClient } from './WikidataClient.js';
import { dbPathFor } from './paths.js';

export interface EntitiesResult { siteUrl: string; resolved: number; attempted: number; edges: number }

/**
 * Heuristic entity resolution (6d): resolve the primary entity of the top-N indexable pages
 * by H1 (fallback title) via Wikidata search, persist to page_entity, and store each entity's
 * subclass-of / part-of edges to page_entity peers. Heuristic (H1→QID can mis-resolve), so the
 * findings it powers are labelled N and gated behind includeJudgement. On-demand only.
 */
export class Entities {
  constructor(private readonly wd: WikidataClient, private readonly dataDir: string) {}

  async run(
    siteUrl: string,
    opts: { limit?: number; language?: string },
    update: (p: Record<string, unknown>) => void,
    signal: AbortSignal,
  ): Promise<EntitiesResult> {
    const limit = opts.limit ?? 100;
    const language = opts.language ?? 'en';
    const db = new AuditDatabase(dbPathFor(this.dataDir, siteUrl));
    try {
      // Top indexable pages by internal authority (most worth resolving).
      const pages = db.db.prepare(
        `SELECT url_key, h1, title FROM pages WHERE status_code=200 AND indexable=1 AND (h1 IS NOT NULL OR title IS NOT NULL)
         ORDER BY ipr DESC, inlink_count DESC LIMIT ?`,
      ).all(limit) as { url_key: string; h1: string | null; title: string | null }[];

      const upEntity = db.db.prepare(
        `INSERT INTO page_entity (url_key, qid, label, description, source, fetched_at) VALUES (?,?,?,?,?,datetime('now'))
         ON CONFLICT(url_key) DO UPDATE SET qid=excluded.qid, label=excluded.label, description=excluded.description, source=excluded.source, fetched_at=datetime('now')`,
      );

      let resolved = 0, attempted = 0;
      const qids = new Set<string>();
      for (const p of pages) {
        if (signal.aborted) break;
        attempted++;
        const text = (p.h1 && p.h1.trim()) ? p.h1 : (p.title ?? '');
        const source = (p.h1 && p.h1.trim()) ? 'h1' : 'title';
        const hit = await this.wd.searchEntity(text, language);
        if (hit) { upEntity.run(p.url_key, hit.id, hit.label, hit.description ?? null, source); qids.add(hit.id); resolved++; }
        update({ phase: 'resolve', attempted, resolved });
      }

      // Relationship edges among the resolved entity set.
      const upEdge = db.db.prepare(`INSERT OR IGNORE INTO entity_edge (qid, related_qid, relation) VALUES (?,?,?)`);
      let edges = 0;
      for (const qid of qids) {
        if (signal.aborted) break;
        for (const e of await this.wd.relatedEntities(qid)) {
          const tx = upEdge.run(qid, e.related, e.relation);
          if (tx.changes) edges++;
        }
        update({ phase: 'edges', edges });
      }

      return { siteUrl, resolved, attempted, edges };
    } finally {
      db.close();
    }
  }
}
