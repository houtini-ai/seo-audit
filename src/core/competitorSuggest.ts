import type { DataForSeoClient, DfsResponse } from './DataForSeoClient.js';
import { PortfolioStore, LOCATION_LABEL, type PortfolioDomain } from './PortfolioStore.js';
import { competitorsPrice } from './portfolioPlan.js';
import { normaliseDomain, isValidDomain } from './portfolioTarget.js';

/**
 * Competitor suggestions for an owned property: one DataForSEO Labs competitors_domain call
 * (keyword overlap, in the property's saved location), quoted first. Only deterministic filters:
 *  - the property itself and its www twin, and its own subdomains, are EXCLUDED (listed, with why);
 *  - domains already in the portfolio are listed as already watched/owned, not proposed again.
 * Everything else is proposed in keyword-overlap order with DataForSEO's numbers as the evidence.
 * Whether a big general site (a marketplace, a publisher) is a real rival is judgement: it is shown
 * with its size against yours, never dropped. Nothing is added: the user picks.
 */

export const SUGGEST_DEFAULT_LIMIT = 20;
export const SUGGEST_MAX_LIMIT = 50;

export interface CompetitorEvidence {
  domain: string;
  /** Keywords both domains rank for (DataForSEO `intersections`). */
  sharedKeywords: number | null;
  /** The competitor's average position on those shared keywords. */
  avgPosition: number | null;
  /** The competitor's estimated traffic (ETV) from the shared keywords only. */
  sharedEtv: number | null;
  /** The competitor's whole-domain organic keyword count and ETV in this location. */
  domainKeywords: number | null;
  domainEtv: number | null;
  /** domainEtv / the property's own whole-domain ETV (null when either is missing or zero). */
  sizeVsYou: number | null;
}
export interface CompetitorSuggestion extends CompetitorEvidence { rank: number }
export interface SuggestResult {
  target: string;
  locationCode: number;
  location: string;
  /** How many competitor domains DataForSEO holds for the target (total_count). */
  totalAvailable: number | null;
  /** Rows requested and returned (the target itself is usually one of them). */
  requested: number;
  returned: number;
  suggestions: CompetitorSuggestion[];
  alreadyInPortfolio: (CompetitorEvidence & { kind: 'owned' | 'watched'; group: string | null })[];
  excluded: { domain: string; reason: string }[];
  you: { domainKeywords: number | null; domainEtv: number | null };
}

/** The owned portfolio row for a domain (after re-syncing owned rows), or a clear error. */
export function ownedRowFor(store: PortfolioStore, input: string): PortfolioDomain {
  store.syncOwned();
  const domain = normaliseDomain(input.replace(/^sc-domain:/i, ''));
  if (!isValidDomain(domain)) throw new Error(`"${input}" is not a domain name.`);
  const rows = store.list().filter(d => d.domain === domain);
  const owned = rows.find(r => r.kind === 'owned');
  if (!owned) {
    throw new Error(rows.length
      ? `${domain} is a watched domain, not an owned property. Suggestions are for owned properties; for any domain, competitors_domain lists its competitors.`
      : `${domain} is not an owned property in the portfolio (owned = a Search Console property synced on this machine).`);
  }
  return owned;
}

/** Quote: one competitors_domain call for limit + 1 rows. */
export function quoteSuggest(limit = SUGGEST_DEFAULT_LIMIT): { rows: number; usd: number } {
  const rows = Math.min(SUGGEST_MAX_LIMIT, Math.max(1, limit)) + 1;
  return { rows, usd: competitorsPrice(rows) };
}

const num = (v: unknown): number | null => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));

/** Split a competitors_domain response into proposals, already-in-portfolio and excluded. Pure. */
export function parseCompetitorSuggestions(
  resp: Pick<DfsResponse, 'tasks'>, target: string, locationCode: number,
  portfolio: Pick<PortfolioDomain, 'domain' | 'locationCode' | 'kind' | 'groupLabel'>[], requested: number,
): SuggestResult {
  const res = resp.tasks?.[0]?.result?.[0] ?? {};
  const items: any[] = res.items ?? [];
  const self = normaliseDomain(target);
  const evidence = (it: any): CompetitorEvidence => ({
    domain: normaliseDomain(String(it.domain ?? '')),
    sharedKeywords: num(it.intersections),
    avgPosition: num(it.avg_position) == null ? null : Math.round(Number(it.avg_position) * 10) / 10,
    sharedEtv: num(it.metrics?.organic?.etv),
    domainKeywords: num(it.full_domain_metrics?.organic?.count),
    domainEtv: num(it.full_domain_metrics?.organic?.etv),
    sizeVsYou: null,
  });
  const selfItem = items.find(it => normaliseDomain(String(it.domain ?? '')) === self);
  const you = { domainKeywords: num(selfItem?.full_domain_metrics?.organic?.count), domainEtv: num(selfItem?.full_domain_metrics?.organic?.etv) };
  const inPortfolio = new Map(portfolio.filter(p => p.locationCode === locationCode).map(p => [p.domain, p]));
  const out: SuggestResult = {
    target: self, locationCode, location: LOCATION_LABEL[locationCode] ?? `location ${locationCode}`,
    totalAvailable: num(res.total_count), requested, returned: items.length,
    suggestions: [], alreadyInPortfolio: [], excluded: [], you,
  };
  const seen = new Set<string>();
  const ordered = [...items].sort((a, b) => (num(b.intersections) ?? 0) - (num(a.intersections) ?? 0) || (num(b.metrics?.organic?.etv) ?? 0) - (num(a.metrics?.organic?.etv) ?? 0));
  for (const it of ordered) {
    const e = evidence(it);
    if (!e.domain) continue;
    if (seen.has(e.domain)) { out.excluded.push({ domain: e.domain, reason: 'duplicate row (www twin of a domain already listed)' }); continue; }
    seen.add(e.domain);
    if (e.domain === self) { out.excluded.push({ domain: e.domain, reason: 'the property itself (or its www twin)' }); continue; }
    if (e.domain.endsWith(`.${self}`)) { out.excluded.push({ domain: e.domain, reason: `a subdomain of ${self}` }); continue; }
    e.sizeVsYou = e.domainEtv != null && you.domainEtv ? Math.round((e.domainEtv / you.domainEtv) * 10) / 10 : null;
    const p = inPortfolio.get(e.domain);
    if (p) { out.alreadyInPortfolio.push({ ...e, kind: p.kind, group: p.groupLabel }); continue; }
    out.suggestions.push({ rank: out.suggestions.length + 1, ...e });
  }
  return out;
}

/** Paid: fetch and parse. The spend is recorded in the portfolio ledger (tier 'suggest'). */
export async function runSuggest(dataDir: string, dfs: DataForSeoClient, domain: string, limit = SUGGEST_DEFAULT_LIMIT): Promise<SuggestResult & { cost: number; cached: boolean }> {
  const store = new PortfolioStore(dataDir);
  try {
    const owned = ownedRowFor(store, domain);
    const q = quoteSuggest(limit);
    const startedAt = new Date().toISOString();
    const runId = Number(store.db.prepare(`INSERT INTO portfolio_run (started_at, tier, trigger, quoted_usd, status) VALUES (?, 'suggest', 'manual', ?, 'running')`).run(startedAt, q.usd).lastInsertRowid);
    let r: DfsResponse;
    try {
      r = await dfs.competitorsDomain(owned.domain, owned.locationCode, owned.languageCode, q.rows);
    } catch (e) {
      store.db.prepare(`UPDATE portfolio_run SET finished_at = ?, status = 'failed', note = ? WHERE id = ?`).run(new Date().toISOString(), `competitor suggestions for ${owned.domain}: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`, runId);
      throw e;
    }
    let parsed: ReturnType<typeof parseCompetitorSuggestions>;
    try {
      parsed = parseCompetitorSuggestions(r, owned.domain, owned.locationCode, store.list(), q.rows);
    } catch (e) {
      // The call was paid even though its response didn't parse: record the spend and close the row.
      store.db.prepare(`UPDATE portfolio_run SET finished_at = ?, status = 'failed', spent_usd = ?, calls = 1, cache_hits = ?, note = ? WHERE id = ?`)
        .run(new Date().toISOString(), r.cost || 0, r.cached ? 1 : 0, `competitor suggestions for ${owned.domain}: the response could not be read (${(e instanceof Error ? e.message : String(e)).slice(0, 200)})`, runId);
      throw e;
    }
    store.db.prepare(`UPDATE portfolio_run SET finished_at = ?, status = 'completed', spent_usd = ?, calls = 1, cache_hits = ?, note = ? WHERE id = ?`)
      .run(new Date().toISOString(), r.cost || 0, r.cached ? 1 : 0, `competitor suggestions for ${owned.domain}: ${parsed.suggestions.length} proposed${r.cached ? ' (from cache)' : ''}`, runId);
    return { ...parsed, cost: r.cost || 0, cached: r.cached };
  } finally { store.close(); }
}
