import type { PortfolioDomain } from './PortfolioStore.js';

/**
 * What a portfolio refresh calls, and what that costs. ONE plan is
 * used both to quote (before anything is spent) and to execute, so the quote and the run can never
 * describe different work. Prices are the per-call costs OBSERVED on live calls (2026-10-24,
 * scripts/fixtures/portfolio/*.json `cost`), at the small row counts the portfolio requests; a run's
 * actual spend (the ledger, summed from each response's `cost`) is what the budget is checked against.
 */
export const DFS_PRICES = {
  source: 'observed on live portfolio runs, 24 Oct 2026 (Labs $0.012/task, Backlinks $0.024/task, LLM Mentions $0.10/task, plus per-row and per-month fees)',
  labsBulkTraffic: 0.0122,
  labsSerpMix: 0.0121,
  // $0.12/task + $0.0012 per month returned: the full history from 2020-10 is ~72 months (live: $0.2076).
  labsHistorical: 0.21,
  labsCountries: 0.0126,
  labsTopPages: 0.015,
  backlinksBulk: 0.0241,
  backlinksHistory: 0.025,
  backlinksTopPages: 0.0245,
  llmHistorical: 0.076,   // live: $0.0758 per domain per platform

  llmTopList: 0.121,      // $0.10/task + $0.001/row; 20-21 rows requested (live: $0.121)
} as const;

export type PortfolioTierSel = 'weekly' | 'monthly' | 'all';

/** One endpoint family: a group of calls that succeed or fail together (an API family can be off). */
export interface PlanFamily {
  id: FamilyId;
  tier: 'weekly' | 'monthly';
  label: string;
  /** Each call: the domains it covers (bulk calls cover many) and the location it's made at. */
  calls: { domains: string[]; locationCode: number; platform?: 'google' | 'chat_gpt'; variant?: BulkVariant }[];
  usdPerCall: number;
}
export type BulkVariant = 'rank' | 'referring' | 'backlinks' | 'newlost';
export type FamilyId =
  | 'traffic' | 'backlinks-bulk' | 'serp-mix'
  | 'labs-history' | 'backlinks-history' | 'countries' | 'top-pages-traffic' | 'top-pages-links'
  | 'llm-history' | 'llm-top-pages' | 'llm-top-sources';

const BULK_MAX = 1000;
const chunk = <T>(xs: T[], n: number): T[][] => { const out: T[][] = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out; };

/** Build the refresh plan for these domains and tier(s). Pure. */
export function planRefresh(domains: PortfolioDomain[], tier: PortfolioTierSel): PlanFamily[] {
  const fams: PlanFamily[] = [];
  const weekly = tier === 'weekly' || tier === 'all';
  const monthly = tier === 'monthly' || tier === 'all';
  const per = (fn: (d: PortfolioDomain) => PlanFamily['calls'][number]): PlanFamily['calls'] => domains.map(fn);
  if (weekly) {
    // ETV is per location, so bulk traffic is one call per distinct location (each ≤1000 targets).
    const byLoc = new Map<number, string[]>();
    for (const d of domains) byLoc.set(d.locationCode, [...(byLoc.get(d.locationCode) ?? []), d.domain]);
    fams.push({
      id: 'traffic', tier: 'weekly', label: 'Organic and paid traffic estimates (Labs bulk)',
      calls: [...byLoc].flatMap(([loc, ds]) => chunk([...new Set(ds)], BULK_MAX).map(c => ({ domains: c, locationCode: loc }))),
      usdPerCall: DFS_PRICES.labsBulkTraffic,
    });
    // Backlink metrics are location-independent: 4 bulk calls (rank, referring domains, backlinks,
    // new/lost) cover the whole portfolio.
    const uniq = [...new Set(domains.map(d => d.domain))];
    fams.push({
      id: 'backlinks-bulk', tier: 'weekly', label: 'Domain Rank, referring domains, backlinks, new and lost (Backlinks bulk, 4 calls)',
      calls: chunk(uniq, BULK_MAX).flatMap(c => (['rank', 'referring', 'backlinks', 'newlost'] as const).map(variant => ({ domains: c, locationCode: 0, variant }))),
      usdPerCall: DFS_PRICES.backlinksBulk,
    });
    fams.push({
      id: 'serp-mix', tier: 'weekly', label: 'Search results mix incl. AI Overview references (Labs, per domain)',
      calls: per(d => ({ domains: [d.domain], locationCode: d.locationCode })), usdPerCall: DFS_PRICES.labsSerpMix,
    });
  }
  if (monthly) {
    const one = (usd: number, id: FamilyId, label: string, platform?: 'google' | 'chat_gpt'): PlanFamily => ({
      id, tier: 'monthly', label, usdPerCall: usd,
      calls: per(d => ({ domains: [d.domain], locationCode: d.locationCode, ...(platform ? { platform } : {}) })),
    });
    fams.push(one(DFS_PRICES.labsHistorical, 'labs-history', 'Keywords, traffic and positions by month (Labs history, per domain)'));
    fams.push(one(DFS_PRICES.backlinksHistory, 'backlinks-history', 'Referring domains and Domain Rank by month (Backlinks history, per domain)'));
    fams.push(one(DFS_PRICES.labsCountries, 'countries', 'Traffic by country (Labs, per domain)'));
    fams.push(one(DFS_PRICES.labsTopPages, 'top-pages-traffic', 'Top pages by estimated traffic (Labs, per domain)'));
    fams.push(one(DFS_PRICES.backlinksTopPages, 'top-pages-links', 'Top pages by links (Backlinks, per domain)'));
    // AI mentions by month, per platform. AI Overviews at the domain's location; ChatGPT data exists
    // for the United States only, so it is always asked at 2840 and labelled "(US)" elsewhere.
    fams.push({
      id: 'llm-history', tier: 'monthly', usdPerCall: DFS_PRICES.llmHistorical,
      label: 'AI mentions by month, AI Overviews and ChatGPT (LLM Mentions, per domain per platform)',
      calls: domains.flatMap(d => [
        { domains: [d.domain], locationCode: d.locationCode, platform: 'google' as const },
        { domains: [d.domain], locationCode: 2840, platform: 'chat_gpt' as const },
      ]),
    });
    fams.push(one(DFS_PRICES.llmTopList, 'llm-top-pages', 'Pages cited in AI Overviews (LLM Mentions, per domain)', 'google'));
    fams.push(one(DFS_PRICES.llmTopList, 'llm-top-sources', 'Sources cited alongside, AI Overviews (LLM Mentions, per domain)', 'google'));
  }
  return fams.filter(f => f.calls.length > 0);
}

export interface Quote {
  tier: PortfolioTierSel;
  domains: number;
  families: { id: FamilyId; label: string; calls: number; usd: number }[];
  calls: number;
  usd: number;
  note: string;
}

/** Price a plan. An estimate: cache hits cost $0 at run time, and per-row fees vary slightly. */
export function quotePlan(plan: PlanFamily[], tier: PortfolioTierSel, domainCount: number): Quote {
  const families = plan.map(f => ({ id: f.id, label: f.label, calls: f.calls.length, usd: round(f.calls.length * f.usdPerCall) }));
  const calls = families.reduce((s, f) => s + f.calls, 0);
  const usd = round(families.reduce((s, f) => s + f.usd, 0));
  return {
    tier, domains: domainCount, families, calls, usd,
    note: `Estimate at observed per-call prices (${DFS_PRICES.source}). Calls answered from the cache cost nothing, so the actual spend is usually lower; the run records what it really spent.`,
  };
}

export const familyQuote = (f: PlanFamily): number => round(f.calls.length * f.usdPerCall);
const round = (v: number): number => Math.round(v * 10000) / 10000;
