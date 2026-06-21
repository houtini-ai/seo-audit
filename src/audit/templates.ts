import type Database from 'better-sqlite3';

/**
 * Template detection (Phase 6b). Clusters a site's pages into templates so a single
 * template-level fix can be reasoned about as fixing N pages at once.
 *
 * Tripartite key (from the "how SEOs audit" conversation): URL morphology + JSON-LD
 * root @type + DOM-skeleton similarity. The first two are computable from data we
 * already store (pages.url, pages.json_ld) — that's what we cluster on here. The
 * DOM-skeleton LSH is a future refinement (needs a structural signature captured at
 * crawl time); url-morphology + @type already separates most real templates cleanly.
 */
export interface TemplateCluster {
  templateKey: string;     // morphology|schemaType
  morphology: string;      // e.g. /product/[SLUG]
  schemaType: string;      // JSON-LD root @type, or 'None'
  count: number;           // pages in the cluster
  exemplarUrlKey: string;  // the median, healthy page to analyse (one per template)
  exemplarUrl: string;
  memberKeys: string[];    // up to a cap, for downstream per-template checks
}

// A segment is a variable IDENTIFIER (→ [SLUG]) if it looks like a slug/id rather than a
// stable section name: contains a hyphen or digit, or is unusually long. Short clean words
// (product, blog, category, en) stay literal so /product/[SLUG] ≠ /blog/[SLUG].
// (Limitation: single-word slugs with no hyphen/digit stay literal and can fragment a cluster;
// positional-variability analysis is the future refinement.)
const isIdentifier = (name: string): boolean => /[-_]/.test(name) || /\d/.test(name) || name.length > 24;

/** URL → structural morphology: numerics→[NUM], identifier slugs→[SLUG] (extension kept), section names literal, param keys sorted, values dropped. */
export function urlMorphology(rawUrl: string): string {
  let u: URL;
  try { u = new URL(rawUrl); } catch { return rawUrl; }
  const segs = u.pathname.split('/').filter(Boolean).map(seg => {
    if (/^\d+$/.test(seg)) return '[NUM]';
    const dot = seg.lastIndexOf('.');
    if (dot > 0 && dot < seg.length - 1) {
      const ext = seg.slice(dot + 1).toLowerCase();
      const name = seg.slice(0, dot);
      if (/^[a-z0-9]{1,5}$/.test(ext)) return isIdentifier(name) ? `[SLUG].${ext}` : seg;
    }
    return isIdentifier(seg) ? '[SLUG]' : seg;
  });
  const path = '/' + segs.join('/');
  const params = [...new Set([...u.searchParams.keys()].map(k => k.toLowerCase()))].sort();
  return path + (params.length ? '?' + params.join('&') : '');
}

/** Raw JSON-LD column → root @type (handles array, @graph, @type-as-array), else 'None'. */
export function jsonLdType(jsonLd: string | null): string {
  if (!jsonLd) return 'None';
  const first = (t: unknown): string | null => (Array.isArray(t) ? (t[0] != null ? String(t[0]) : null) : t != null ? String(t) : null);
  try {
    const parsed = JSON.parse(jsonLd);
    for (const o of Array.isArray(parsed) ? parsed : [parsed]) {
      if (o && typeof o === 'object') {
        const t = first((o as any)['@type']);
        if (t) return t;
        const graph = (o as any)['@graph'];
        if (Array.isArray(graph)) for (const g of graph) { const gt = first(g?.['@type']); if (gt) return gt; }
      }
    }
  } catch {
    const m = /"@type"\s*:\s*"([^"]+)"/.exec(jsonLd);
    if (m) return m[1];
  }
  return 'None';
}

interface PageRow { url_key: string; url: string; status_code: number | null; indexable: number | null; word_count: number | null; inlink_count: number | null; json_ld: string | null }

/**
 * Detect templates. minMembers (default 4) filters singletons (home/about/contact) to
 * per-URL analysis. The exemplar is the MEDIAN-word-count healthy (200 + indexable +
 * linked) page so per-template analysis runs on a representative, not an edge case.
 */
export function detectTemplates(db: Database.Database, opts: { minMembers?: number; memberCap?: number } = {}): TemplateCluster[] {
  const minMembers = opts.minMembers ?? 4;
  const memberCap = opts.memberCap ?? 500;
  const pages = db.prepare(
    `SELECT url_key, url, status_code, indexable, word_count, inlink_count, json_ld FROM pages WHERE is_internal IS NOT 0`,
  ).all() as PageRow[];

  const groups = new Map<string, { morphology: string; schemaType: string; members: PageRow[] }>();
  for (const p of pages) {
    const morphology = urlMorphology(p.url);
    const schemaType = jsonLdType(p.json_ld);
    const key = `${morphology}|${schemaType}`;
    let g = groups.get(key);
    if (!g) { g = { morphology, schemaType, members: [] }; groups.set(key, g); }
    g.members.push(p);
  }

  const clusters: TemplateCluster[] = [];
  for (const [key, g] of groups) {
    if (g.members.length < minMembers) continue;
    // Exemplar: median word_count among healthy pages; fall back to median of all members.
    const healthy = g.members.filter(m => m.status_code === 200 && m.indexable === 1 && (m.inlink_count ?? 0) > 0);
    const pool = healthy.length ? healthy : g.members;
    const sorted = [...pool].sort((a, b) => (a.word_count ?? 0) - (b.word_count ?? 0));
    const exemplar = sorted[Math.floor(sorted.length / 2)];
    clusters.push({
      templateKey: key,
      morphology: g.morphology,
      schemaType: g.schemaType,
      count: g.members.length,
      exemplarUrlKey: exemplar.url_key,
      exemplarUrl: exemplar.url,
      memberKeys: g.members.slice(0, memberCap).map(m => m.url_key),
    });
  }
  return clusters.sort((a, b) => b.count - a.count);
}
