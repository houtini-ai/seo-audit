import { AuditDatabase } from './AuditDatabase.js';
import { DataForSeoClient } from './DataForSeoClient.js';
import { MajesticClient, TopicalTrustFlow } from './MajesticClient.js';
import { dbPathFor } from './paths.js';
import { hostFormForProperty } from './url-key.js';

/**
 * Link intersect — "what links do our competitors have that we don't?".
 *
 * DataForSEO backlinks/domain_intersection returns every domain that links to a set of
 * competitor targets; excluding our own domain leaves the prospect set. We fetch a generous
 * pool ordered by intersections_count (target-agnostic union) then aggregate + prioritise
 * client-side, because ordering by any single target's rank biases toward that one competitor
 * and raw intersection-count ordering surfaces spam (rank-0 newswire/directory domains linking
 * to everyone). The default presentation sort is the link-builder's: FOLLOWED links first,
 * then by DOMAIN TRUST (DataForSEO domain rank on its own; upgraded to Majestic Trust Flow
 * when MAJESTIC_API_KEY is set — that tier re-sorts this same table).
 *
 * DFS only, one paid call (~$0.024), 20-day cached. On-demand — never auto-run.
 */

const n = (v: unknown): number => Number(v) || 0;

/** Bare host: strip sc-domain:/scheme/www/trailing slash → the domain join key DFS wants. */
const bareDomain = (s: string): string =>
  s.replace(/^sc-domain:/, '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '').toLowerCase().trim();

export interface LinkProspect {
  domain: string;               // the prospect (referring) domain
  intersections: number;        // how many of our competitors link from it
  linkedTargets: string[];      // which competitors (mapped back from the target index)
  domainTrust: number | null;   // DataForSEO domain rank 0-1000 (max across intersections)
  spamScore: number | null;     // worst backlinks_spam_score across intersections (0-100)
  dofollow: boolean;            // has at least one followed link into the set
  backlinks: number;            // total backlinks it points at the set
  referringDomains: number;
  firstSeen: string | null;     // earliest first_seen across intersections
  linkTypes: Record<string, number>; // aggregated referring_links_types (anchor/image/redirect)
  // Majestic enrichment (present only when MAJESTIC_API_KEY is set + this row was enriched):
  trustFlow?: number | null;    // Majestic Trust Flow 0-100 (the directory-killer authority signal)
  citationFlow?: number | null; // Majestic Citation Flow 0-100
  topicalTrustFlow?: TopicalTrustFlow[]; // sorted desc — is its authority topically relevant?
}

export interface LinkIntersectResult {
  siteUrl: string;
  ownDomain: string;
  competitors: string[];
  totalCount: number;           // DFS total_count (the whole intersect universe)
  poolFetched: number;          // rows we actually pulled
  kept: number;                 // rows surviving the filters
  prospects: LinkProspect[];    // top slice, sorted
  cached: boolean;
  cost: number;
  majesticEnriched: number;     // how many prospects got Majestic Trust Flow (0 = tier off)
  enrichCapped: boolean;        // true if more prospects qualified than the enrich cap allowed
  sortedBy: 'trustFlow' | 'domainTrust' | 'intersections'; // what the returned order reflects
}

export interface LinkIntersectOpts {
  competitors: string[];        // 1-20 competitor domains (required; derive upstream if empty)
  poolLimit?: number;           // DFS rows to pull (default 300, max 1000)
  minIntersections?: number;    // keep domains linking to >= this many competitors (default 1)
  maxSpamScore?: number;        // drop domains whose worst spam score exceeds this (default 30)
  dofollowOnly?: boolean;       // keep only domains with a followed link (default false)
  topN?: number;                // rows to return + persist (default 100)
  sort?: 'trust' | 'intersections'; // default 'trust' (followed-first, then domain trust)
  enrichLimit?: number;         // max prospects to send to Majestic (default 100 = its batch cap)
}

/** One target-entry (domain_intersection.{N}) → does it carry a followed link? */
function entryHasFollowed(e: any): boolean {
  // referring_links_attributes counts link rel attributes; a followed link is one NOT marked
  // nofollow/ugc/sponsored. Prefer the page-level split when present, else fall back to the
  // domain-nofollow counts (a domain with fewer nofollow than total has followed links).
  const pages = n(e.referring_pages), pagesNf = n(e.referring_pages_nofollow);
  if (pages > 0) return pages > pagesNf;
  const rd = n(e.referring_domains), rdNf = n(e.referring_domains_nofollow);
  return rd > rdNf;
}

export class LinkIntersect {
  constructor(private readonly dfs: DataForSeoClient, private readonly dataDir: string) {}

  async run(siteUrl: string, opts: LinkIntersectOpts, majestic?: MajesticClient | null): Promise<LinkIntersectResult> {
    const ownDomain = bareDomain(siteUrl);
    const competitors = [...new Set(opts.competitors.map(bareDomain).filter(c => c && c !== ownDomain))].slice(0, 20);
    if (!competitors.length) throw new Error('link_intersect needs at least one competitor domain distinct from the property.');

    const poolLimit = Math.min(opts.poolLimit ?? 300, 1000);
    const minIntersections = opts.minIntersections ?? 1;
    const maxSpamScore = opts.maxSpamScore ?? 30;
    const topN = opts.topN ?? 100;
    const sort = opts.sort ?? 'trust';

    const res = await this.dfs.domainIntersection(competitors, ownDomain, poolLimit);
    const task = res.tasks[0];
    if (!task || (task.status_code ?? 0) >= 40000) {
      const msg = task?.status_message ?? 'no task returned';
      throw new Error(
        `DataForSEO domain_intersection failed: ${msg}` +
        (task?.status_code === 40204 ? ' — the Backlinks API is a separate DataForSEO subscription; activate it at app.dataforseo.com to use link_intersect.' : ''),
      );
    }
    const result = task.result?.[0] ?? {};
    const items: any[] = result.items ?? [];
    const totalCount = n(result.total_count);

    // Aggregate each item across the competitors it links to. The domain_intersection map is
    // keyed by target INDEX ("1".."N"); map each key back to competitors[index-1]. The `target`
    // field inside every entry is the referring (prospect) domain, identical across keys.
    const prospects: LinkProspect[] = items.map((it) => {
      const di: Record<string, any> = it.domain_intersection ?? {};
      const keys = Object.keys(di);
      const first = di[keys[0]] ?? {};
      const domain = bareDomain(String(first.target ?? ''));

      const linkedTargets: string[] = [];
      let domainTrust: number | null = null;
      let spamScore: number | null = null;
      let dofollow = false;
      let backlinks = 0;
      let referringDomains = 0;
      let firstSeen: string | null = null;
      const linkTypes: Record<string, number> = {};

      for (const k of keys) {
        const e = di[k];
        const compIdx = Number(k) - 1;
        if (competitors[compIdx]) linkedTargets.push(competitors[compIdx]);
        if (e.rank != null) domainTrust = Math.max(domainTrust ?? 0, n(e.rank));
        if (e.backlinks_spam_score != null) spamScore = Math.max(spamScore ?? 0, n(e.backlinks_spam_score));
        if (entryHasFollowed(e)) dofollow = true;
        backlinks += n(e.backlinks);
        referringDomains = Math.max(referringDomains, n(e.referring_domains));
        if (e.first_seen && (!firstSeen || e.first_seen < firstSeen)) firstSeen = e.first_seen;
        for (const [t, c] of Object.entries(e.referring_links_types ?? {})) linkTypes[t] = (linkTypes[t] ?? 0) + n(c);
      }

      return {
        domain,
        intersections: n(it.summary?.intersections_count) || keys.length,
        linkedTargets,
        domainTrust,
        spamScore,
        dofollow,
        backlinks,
        referringDomains,
        firstSeen,
        linkTypes,
      };
    }).filter(p => p.domain);

    // Filters (each honest, none silent — the counts are reported).
    const kept = prospects.filter(p =>
      p.intersections >= minIntersections &&
      (p.spamScore == null || p.spamScore <= maxSpamScore) &&
      (!opts.dofollowOnly || p.dofollow),
    );

    // Majestic enrichment (the directory-killer tier). DataForSEO domain rank and Majestic
    // Trust Flow disagree sharply — a rank-227 domain can be TF 0 (pure directory noise). When
    // a Majestic client is supplied we enrich the strongest candidates and re-sort on Trust Flow.
    // We enrich the top `enrichLimit` by DFS trust (bounded — Majestic bills units; default 100 =
    // its per-call batch cap) and REPORT if more qualified than we enriched (no silent cap).
    let majesticEnriched = 0;
    let enrichCapped = false;
    if (majestic && kept.length) {
      const enrichLimit = Math.min(opts.enrichLimit ?? 100, 500); // MajesticClient batches by 100 internally
      const candidates = [...kept].sort((a, b) => (b.domainTrust ?? -1) - (a.domainTrust ?? -1)).slice(0, enrichLimit);
      enrichCapped = kept.length > candidates.length;
      const metrics = await majestic.getIndexItemInfo(candidates.map(c => c.domain), { datasource: 'historic', desiredTopics: 5 });
      const byItem = new Map(metrics.map(m => [m.item.toLowerCase(), m]));
      for (const p of candidates) {
        const m = byItem.get(p.domain.toLowerCase());
        if (m) {
          p.trustFlow = m.trustFlow;
          p.citationFlow = m.citationFlow;
          p.topicalTrustFlow = m.topicalTrustFlow;
          majesticEnriched++;
        }
      }
    }

    // Sort. Default 'trust' = the link-builder's view: a followed link you can actually earn,
    // from the highest-authority domain. When Majestic enriched the set, "domain trust" becomes
    // Trust Flow (unenriched rows sink); otherwise it's the DataForSEO domain rank. 'intersections'
    // = broadest overlap first.
    const majesticActive = majesticEnriched > 0;
    const trustKey = (p: LinkProspect): number =>
      majesticActive ? (p.trustFlow ?? -1) : (p.domainTrust ?? -1);
    kept.sort((a, b) => {
      if (sort === 'intersections') {
        return b.intersections - a.intersections || (b.dofollow ? 1 : 0) - (a.dofollow ? 1 : 0) || trustKey(b) - trustKey(a);
      }
      // 'trust': followed-first, then domain trust (Trust Flow when enriched), then intersection breadth.
      return (b.dofollow ? 1 : 0) - (a.dofollow ? 1 : 0) || trustKey(b) - trustKey(a) || b.intersections - a.intersections;
    });

    const top = kept.slice(0, topN);
    this.persist(siteUrl, competitors, top);

    return {
      siteUrl, ownDomain, competitors,
      totalCount, poolFetched: items.length, kept: kept.length,
      prospects: top, cached: res.cached, cost: res.cost,
      majesticEnriched, enrichCapped,
      sortedBy: sort === 'intersections' ? 'intersections' : (majesticActive ? 'trustFlow' : 'domainTrust'),
    };
  }

  /** Replace this property's prospect set (a fresh intersect supersedes the last). */
  private persist(siteUrl: string, competitors: string[], rows: LinkProspect[]): void {
    const db = new AuditDatabase(dbPathFor(this.dataDir, siteUrl));
    try {
      db.upsertProperty(siteUrl, hostFormForProperty(siteUrl) ?? 'asis');
      const compsJson = JSON.stringify(competitors);
      const upsert = db.db.prepare(
        `INSERT INTO link_prospects
           (domain, intersections, linked_targets, domain_trust, spam_score, dofollow,
            backlinks, referring_domains, first_seen, link_types,
            trust_flow, citation_flow, topical_trust_flow, competitors_set, fetched_at)
         VALUES (@domain,@intersections,@linked_targets,@domain_trust,@spam_score,@dofollow,
            @backlinks,@referring_domains,@first_seen,@link_types,
            @trust_flow,@citation_flow,@topical_trust_flow,@competitors_set,datetime('now'))
         ON CONFLICT(domain) DO UPDATE SET
           intersections=excluded.intersections, linked_targets=excluded.linked_targets,
           domain_trust=excluded.domain_trust, spam_score=excluded.spam_score, dofollow=excluded.dofollow,
           backlinks=excluded.backlinks, referring_domains=excluded.referring_domains,
           first_seen=excluded.first_seen, link_types=excluded.link_types,
           trust_flow=excluded.trust_flow, citation_flow=excluded.citation_flow,
           topical_trust_flow=excluded.topical_trust_flow,
           competitors_set=excluded.competitors_set, fetched_at=datetime('now')`,
      );
      db.db.transaction(() => {
        // Clear the previous run so a re-intersect against a new competitor set doesn't leave
        // stale prospects behind (Majestic/contact enrichment writes onto whatever is current).
        db.db.prepare('DELETE FROM link_prospects').run();
        for (const p of rows) {
          upsert.run({
            domain: p.domain,
            intersections: p.intersections,
            linked_targets: JSON.stringify(p.linkedTargets),
            domain_trust: p.domainTrust,
            spam_score: p.spamScore,
            dofollow: p.dofollow ? 1 : 0,
            backlinks: p.backlinks,
            referring_domains: p.referringDomains,
            first_seen: p.firstSeen,
            link_types: JSON.stringify(p.linkTypes),
            trust_flow: p.trustFlow ?? null,
            citation_flow: p.citationFlow ?? null,
            topical_trust_flow: p.topicalTrustFlow ? JSON.stringify(p.topicalTrustFlow) : null,
            competitors_set: compsJson,
          });
        }
      })();
    } finally {
      db.close();
    }
  }
}
