/**
 * Pure DataForSEO response → row mappers for the portfolio. No I/O:
 * each takes a response's `tasks` array and returns plain rows, so every mapping is tested against
 * the saved live fixtures in scripts/fixtures/portfolio/. A null field means "not reported", never 0.
 */

/** Coerce an unknown value to a finite number or null. */
const n = (v: unknown): number | null => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** Safely extract the items array from a DataForSEO v3 tasks array. */
const items = (tasks: any[]): any[] => (Array.isArray(tasks?.[0]?.result?.[0]?.items) ? tasks[0].result[0].items : []);

/** Normalize a domain for comparison by trimming, lowercasing, and stripping leading www. */
const bare = (d: string) => String(d || '').trim().toLowerCase().replace(/^www\./, '');

export interface BulkMetrics {
  domain: string;
  rank: number | null;
  referringDomains: number | null;
  referringMainDomains: number | null;
  backlinks: number | null;
  newReferringMainDomains: number | null;
  lostReferringMainDomains: number | null;
  organicEtv: number | null;
  organicCount: number | null;
  paidEtv: number | null;
  paidCount: number | null;
}

/** Map bulk API items into domain-keyed partial metrics depending on the requested field. */
export function mapBulkItems(tasks: any[], field: 'rank' | 'referring' | 'backlinks' | 'newlost' | 'traffic'): Map<string, Partial<BulkMetrics>> {
  const map = new Map<string, Partial<BulkMetrics>>();
  for (const item of items(tasks)) {
    const domain = bare(item.target);
    if (!domain) continue;
    if (field === 'rank') {
      map.set(domain, { domain, rank: n(item.rank) });
    } else if (field === 'referring') {
      map.set(domain, { domain, referringDomains: n(item.referring_domains), referringMainDomains: n(item.referring_main_domains) });
    } else if (field === 'backlinks') {
      map.set(domain, { domain, backlinks: n(item.backlinks) });
    } else if (field === 'newlost') {
      map.set(domain, { domain, newReferringMainDomains: n(item.new_referring_main_domains), lostReferringMainDomains: n(item.lost_referring_main_domains) });
    } else if (field === 'traffic') {
      const organic = item.metrics?.organic;
      const paid = item.metrics?.paid;
      map.set(domain, { domain, organicEtv: n(organic?.etv), organicCount: n(organic?.count), paidEtv: n(paid?.etv), paidCount: n(paid?.count) });
    }
  }
  return map;
}

export interface Buckets {
  pos_1_3: number;
  pos_4_10: number;
  pos_11_20: number;
  pos_21_50: number;
  pos_51_100: number;
}

/** Aggregate DataForSEO's 12 position bands into five (1-3 / 4-10 / 11-20 / 21-50 / 51-100). */
export function bucketsFrom(m: any): Buckets | null {
  if (m == null || typeof m !== 'object') return null;
  const g = (v: unknown): number => n(v) ?? 0;
  return {
    pos_1_3: g(m.pos_1) + g(m.pos_2_3),
    pos_4_10: g(m.pos_4_10),
    pos_11_20: g(m.pos_11_20),
    pos_21_50: g(m.pos_21_30) + g(m.pos_31_40) + g(m.pos_41_50),
    pos_51_100: g(m.pos_51_60) + g(m.pos_61_70) + g(m.pos_71_80) + g(m.pos_81_90) + g(m.pos_91_100),
  };
}

export interface LabsMonthRow {
  month: string;
  organicCount: number | null;
  organicEtv: number | null;
  paidCount: number | null;
  paidEtv: number | null;
  buckets: Buckets | null;
}

const ym = (y: unknown, m: unknown): string | null =>
  Number.isInteger(y) && Number.isInteger(m) && (m as number) >= 1 && (m as number) <= 12 ? `${y}-${String(m).padStart(2, '0')}` : null;

/** Map historical rank overview items into monthly rows, deduping by month and sorting ascending. */
export function mapHistoricalRankOverview(tasks: any[]): LabsMonthRow[] {
  const byMonth = new Map<string, LabsMonthRow>();
  for (const item of items(tasks)) {
    const month = ym(item.year, item.month);
    if (!month) continue;
    const organic = item.metrics?.organic;
    const paid = item.metrics?.paid;
    byMonth.set(month, {
      month,
      organicCount: n(organic?.count),
      organicEtv: n(organic?.etv),
      paidCount: n(paid?.count),
      paidEtv: n(paid?.etv),
      buckets: bucketsFrom(organic),
    });
  }
  return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
}

export interface BacklinksMonthRow {
  month: string;
  rank: number | null;
  backlinks: number | null;
  referringDomains: number | null;
  referringMainDomains: number | null;
  newReferringMainDomains: number | null;
  lostReferringMainDomains: number | null;
}

/** Map backlinks history items into rows. Monthly, not daily: one item per month, dated the month end
 * ("2026-09-30 00:00:00 +00:00"); the latest item is the last COMPLETE month. */
export function mapBacklinksHistory(tasks: any[]): BacklinksMonthRow[] {
  const byMonth = new Map<string, { row: BacklinksMonthRow; date: string }>();
  for (const item of items(tasks)) {
    const date = typeof item.date === 'string' ? item.date : '';
    const month = date.slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) continue;
    const existing = byMonth.get(month);
    if (!existing || date > existing.date) {
      byMonth.set(month, {
        date,
        row: {
          month,
          rank: n(item.rank),
          backlinks: n(item.backlinks),
          referringDomains: n(item.referring_domains),
          referringMainDomains: n(item.referring_main_domains),
          // Verified live (fixtures/portfolio/backlinks_history.json): history carries new/lost
          // REFERRING DOMAINS only (no _main_ variant), while referring_main_domains is the total.
          newReferringMainDomains: n(item.new_referring_main_domains ?? item.new_referring_domains),
          lostReferringMainDomains: n(item.lost_referring_main_domains ?? item.lost_referring_domains),
        },
      });
    }
  }
  return [...byMonth.values()].map(v => v.row).sort((a, b) => a.month.localeCompare(b.month));
}

export interface LlmMonthRow {
  month: string;
  mentions: number | null;
  aiSearchVolume: number | null;
}

/** Map LLM Mentions historical items into monthly rows (the current month is partial). */
export function mapLlmHistorical(tasks: any[]): LlmMonthRow[] {
  const byMonth = new Map<string, LlmMonthRow>();
  for (const item of items(tasks)) {
    const month = ym(item.year, item.month);
    if (!month) continue;
    byMonth.set(month, { month, mentions: n(item.metrics?.mentions), aiSearchVolume: n(item.metrics?.ai_search_volume) });
  }
  return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
}

export interface LlmTargetMetrics {
  domain: string;
  mentions: number | null;
  aiSearchVolume: number | null;
}

/** Map LLM multi-target items into a domain-keyed map of mention metrics. */
export function mapLlmMultiTarget(tasks: any[]): Map<string, LlmTargetMetrics> {
  const map = new Map<string, LlmTargetMetrics>();
  for (const item of items(tasks)) {
    const domain = bare(item.key);
    if (!domain) continue;
    map.set(domain, { domain, mentions: n(item.total?.mentions), aiSearchVolume: n(item.total?.ai_search_volume) });
  }
  return map;
}

export interface CitedSource {
  sourceDomain: string;
  mentions: number | null;
  aiSearchVolume: number | null;
}

/** Map LLM top domains, excluding the target and its subdomains (live, the target ranks #1), by mentions. */
export function mapLlmTopDomains(tasks: any[], target: string, limit = 20): CitedSource[] {
  const out: CitedSource[] = [];
  const t = bare(target);
  for (const item of items(tasks)) {
    if (typeof item.domain !== 'string') continue;
    const d = bare(item.domain);
    if (d === t || (t !== '' && d.endsWith('.' + t))) continue;
    out.push({ sourceDomain: item.domain, mentions: n(item.total?.mentions), aiSearchVolume: n(item.total?.ai_search_volume) });
  }
  out.sort((a, b) => (b.mentions ?? -1) - (a.mentions ?? -1));
  return out.slice(0, Math.max(0, Math.floor(limit)));
}

export interface CitedPage {
  url: string;
  mentions: number | null;
  aiSearchVolume: number | null;
}

/** Map LLM top pages, keeping only the target's own pages, by mentions. */
export function mapLlmTopPages(tasks: any[], target: string, limit = 20): CitedPage[] {
  const out: CitedPage[] = [];
  const t = bare(target);
  for (const item of items(tasks)) {
    try {
      const host = bare(new URL(item.page).hostname);
      if (host !== t && !(t !== '' && host.endsWith('.' + t))) continue;
      out.push({ url: item.page, mentions: n(item.total?.mentions), aiSearchVolume: n(item.total?.ai_search_volume) });
    } catch { /* unparseable page URL */ }
  }
  out.sort((a, b) => (b.mentions ?? -1) - (a.mentions ?? -1));
  return out.slice(0, Math.max(0, Math.floor(limit)));
}

export interface CountryRow {
  countryCode: number;
  etv: number;
  count: number;
}

/** Sum domain_rank_overview's per-(location, language) rows per location and sort by ETV (the API sorts by code). */
export function mapCountries(tasks: any[], limit = 15): CountryRow[] {
  const sum = new Map<number, { etv: number; count: number }>();
  for (const item of items(tasks)) {
    if (!Number.isInteger(item.location_code)) continue;
    const o = item.metrics?.organic;
    const cur = sum.get(item.location_code) ?? { etv: 0, count: 0 };
    cur.etv += n(o?.etv) ?? 0;
    cur.count += n(o?.count) ?? 0;
    sum.set(item.location_code, cur);
  }
  const rows: CountryRow[] = [];
  for (const [countryCode, m] of sum) if (m.etv !== 0 || m.count !== 0) rows.push({ countryCode, etv: m.etv, count: m.count });
  rows.sort((a, b) => b.etv - a.etv);
  return rows.slice(0, Math.max(0, Math.floor(limit)));
}

export interface SerpMix {
  organic: number | null;
  paid: number | null;
  aiOverviewReference: number | null;
  featuredSnippet: number | null;
  localPack: number | null;
}

/** Read ranked_keywords' result-level metrics block (needs item_types in the request, else the features are null). */
export function mapSerpMix(tasks: any[]): SerpMix | null {
  const m = tasks?.[0]?.result?.[0]?.metrics;
  if (m == null || typeof m !== 'object') return null;
  return {
    organic: n(m.organic?.count),
    paid: n(m.paid?.count),
    aiOverviewReference: n(m.ai_overview_reference?.count),
    featuredSnippet: n(m.featured_snippet?.count),
    localPack: n(m.local_pack?.count),
  };
}

export interface TopPageByLinks {
  url: string;
  referringMainDomains: number | null;
  referringDomains: number | null;
  backlinks: number | null;
  brokenBacklinks: number | null;
  rank: number | null;
  statusCode: number | null;
}

/** Map backlinks/domain_pages into "top pages by links" rows, preserving the API's order. */
export function mapDomainPages(tasks: any[]): TopPageByLinks[] {
  const out: TopPageByLinks[] = [];
  for (const item of items(tasks)) {
    if (typeof item.page !== 'string') continue;
    const s = item.page_summary;
    out.push({
      url: item.page,
      referringMainDomains: n(s?.referring_main_domains),
      referringDomains: n(s?.referring_domains),
      backlinks: n(s?.backlinks),
      brokenBacklinks: n(s?.broken_backlinks),
      rank: n(s?.rank),
      statusCode: n(item.status_code),
    });
  }
  return out;
}

export interface TopPageByTraffic {
  url: string;
  etv: number | null;
  count: number | null;
  buckets: Buckets | null;
}

/** Map labs relevant_pages into "top pages by traffic" rows, by ETV desc, nulls last. */
export function mapRelevantPages(tasks: any[]): TopPageByTraffic[] {
  const out: TopPageByTraffic[] = [];
  for (const item of items(tasks)) {
    if (typeof item.page_address !== 'string') continue;
    const o = item.metrics?.organic;
    out.push({ url: item.page_address, etv: n(o?.etv), count: n(o?.count), buckets: bucketsFrom(o) });
  }
  out.sort((a, b) => (a.etv == null ? (b.etv == null ? 0 : 1) : b.etv == null ? -1 : b.etv - a.etv));
  return out;
}

/** The previous calendar month in UTC as YYYY-MM: the one every change and attention rule compares. */
export function lastCompleteMonth(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  return m === 0 ? `${y - 1}-12` : `${y}-${String(m).padStart(2, '0')}`;
}

/** True when YYYY-MM is the current UTC month or later (data for it is month-to-date). */
export function isPartialMonth(month: string, now: Date = new Date()): boolean {
  return month >= `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}
