import path from 'node:path';
import { AuditDatabase } from './AuditDatabase.js';
import type { DataForSeoClient, DfsResponse } from './DataForSeoClient.js';
import type { RankTracker } from './RankTracker.js';
import { PortfolioStore, type FetchStatus, type PortfolioDomain } from './PortfolioStore.js';
import { planRefresh, quotePlan, familyQuote, type PlanFamily, type PortfolioTierSel, type Quote } from './portfolioPlan.js';
import {
  mapBulkItems, mapHistoricalRankOverview, mapBacklinksHistory, mapLlmHistorical, mapLlmTopDomains,
  mapLlmTopPages, mapCountries, mapSerpMix, mapDomainPages, mapRelevantPages,
} from './portfolioIngest.js';
import { listLocalProperties } from './webServer.js';

/**
 * The `portfolio` job (design/portfolio/SPEC.md v1.1): run one plan (portfolioPlan.ts) family by
 * family. Rules that bite here:
 *  - a family's failure never aborts the run (the Backlinks API off ≠ Labs off); each (domain,
 *    endpoint) records its status, so an empty cell can say WHY;
 *  - the budget is checked BEFORE each family: recorded month spend + this run's spend + the family's
 *    quote must stay within the cap, else the family is skipped and the run notes it;
 *  - the ledger records ACTUAL spend (each response's `cost`; a cache hit is $0), not the quote;
 *  - owned domains send RankTracker's exact historical_rank_overview body, so the property DB's
 *    rank_history is written from the same (cached) response, never paid for twice.
 */
export interface PortfolioRefreshArgs {
  tier: PortfolioTierSel;
  trigger: 'manual' | 'schedule';
  domains?: string[];
  /** Monthly cap in USD that this run must respect (null = no cap: a manual run with no schedule). */
  budgetUsd?: number | null;
  jobId?: string;
}

export interface PortfolioRefreshResult {
  runId: number;
  tier: PortfolioTierSel;
  quoted: number;
  spent: number;
  calls: number;
  cacheHits: number;
  families: { id: string; label: string; status: 'ok' | 'partial' | 'failed' | 'skipped-budget'; calls: number; spent: number; note?: string }[];
  note: string;
}

const WEEKLY_MAX_AGE = 6;    // days: a weekly run gets this week's numbers
const MONTHLY_MAX_AGE = 25;  // days: monthly history doesn't move faster than this
const HISTORY_MONTHS = 13;   // backlinks history window (12 complete months + the current one)

/** 40204 = an API family not activated on the account (Backlinks, LLM Mentions are separate). */
export function classifyDfsError(e: unknown): { status: FetchStatus; error: string } {
  const msg = e instanceof Error ? e.message : String(e);
  return /40204|subscription|not activated|access denied/i.test(msg)
    ? { status: 'not-enabled', error: msg } : { status: 'error', error: msg };
}

export function selectDomains(store: PortfolioStore, only?: string[]): PortfolioDomain[] {
  store.syncOwned();
  const all = store.list();
  if (!only?.length) return all;
  const want = new Set(only.map(d => d.trim().toLowerCase().replace(/^www\./, '')));
  return all.filter(d => want.has(d.domain));
}

/** Quote a refresh without spending anything. */
export function quotePortfolioRefresh(dataDir: string, tier: PortfolioTierSel, only?: string[]): Quote & { domainList: string[] } {
  const store = new PortfolioStore(dataDir);
  try {
    const ds = selectDomains(store, only);
    return { ...quotePlan(planRefresh(ds, tier), tier, ds.length), domainList: ds.map(d => `${d.domain} (${d.locationCode})`) };
  } finally { store.close(); }
}

export async function runPortfolioRefresh(
  dataDir: string, dfs: DataForSeoClient, rankTracker: RankTracker | null,
  args: PortfolioRefreshArgs, update: (p: Record<string, unknown>) => void, signal: AbortSignal,
): Promise<PortfolioRefreshResult> {
  const store = new PortfolioStore(dataDir);
  const startedAt = new Date().toISOString();
  const capturedAt = startedAt.slice(0, 19).replace('T', ' ');
  try {
    const domains = selectDomains(store, args.domains);
    const plan = planRefresh(domains, args.tier);
    const quote = quotePlan(plan, args.tier, domains.length);
    const priorSpend = store.spentThisMonth(new Date(startedAt));
    const runId = Number(store.db.prepare(
      `INSERT INTO portfolio_run (started_at, tier, trigger, quoted_usd, status, job_id) VALUES (?, ?, ?, ?, 'running', ?)`,
    ).run(startedAt, args.tier, args.trigger, quote.usd, args.jobId ?? null).lastInsertRowid);
    let spent = 0, calls = 0, cacheHits = 0;
    const famOut: PortfolioRefreshResult['families'] = [];
    const ledger = () => store.db.prepare('UPDATE portfolio_run SET spent_usd = ?, calls = ?, cache_hits = ? WHERE id = ?').run(round(spent), calls, cacheHits, runId);
    const paid = (r: DfsResponse) => { calls++; if (r.cached) cacheHits++; spent += r.cost || 0; ledger(); return r; };
    const ctx: Ctx = {
      dfs, store, rankTracker, paid, capturedAt,
      domains, ownedSites: ownedSiteIndex(dataDir, store),
      snap: new Map(),
    };
    // A call's status belongs to every (domain, location) row it covers; location 0 = location-independent.
    const record = (call: PlanFamily['calls'][number], fam: PlanFamily, status: FetchStatus, error?: string) => {
      const key = fam.id + (call.platform ? `:${call.platform}` : '');
      for (const d of call.domains) {
        const locs = call.locationCode && fam.id !== 'llm-history'
          ? [call.locationCode]
          : domains.filter(x => x.domain === d).map(x => x.locationCode);
        for (const l of locs) store.recordFetch(d, l, key, status, error?.slice(0, 400));
      }
    };

    for (const fam of plan) {
      if (signal.aborted) break;
      const famQuote = familyQuote(fam);
      if (args.budgetUsd != null && priorSpend + spent + famQuote > args.budgetUsd + 1e-9) {
        const why = `would exceed the $${args.budgetUsd} monthly budget`;
        for (const call of fam.calls) record(call, fam, 'skipped-budget', why);
        famOut.push({ id: fam.id, label: fam.label, status: 'skipped-budget', calls: 0, spent: 0, note: `skipped: $${round(priorSpend + spent)} spent this month + $${famQuote} ${why}` });
        continue;
      }
      update({ runId, family: fam.id, label: fam.label, spentSoFar: round(spent), familiesDone: famOut.length, familiesTotal: plan.length });
      const before = spent;
      let ok = 0, failed = 0;
      for (let i = 0; i < fam.calls.length; i++) {
        const call = fam.calls[i];
        if (signal.aborted) break;
        try {
          await runCall(fam, call, ctx);
          ok++;
          record(call, fam, 'ok');
        } catch (e) {
          failed++;
          const { status, error } = classifyDfsError(e);
          record(call, fam, status, error);
          // A family that isn't enabled fails the same way every time: don't pay for more tries.
          if (status === 'not-enabled') { for (const rest of fam.calls.slice(i + 1)) record(rest, fam, 'not-enabled', error); break; }
        }
      }
      famOut.push({ id: fam.id, label: fam.label, status: failed === 0 ? 'ok' : ok === 0 ? 'failed' : 'partial', calls: ok + failed, spent: round(spent - before) });
    }

    writeSnapshots(store, ctx.snap, capturedAt);
    const skipped = famOut.filter(f => f.status === 'skipped-budget').length;
    const failedFams = famOut.filter(f => f.status === 'failed').length;
    const status = signal.aborted ? 'cancelled' : skipped ? 'partial-budget' : failedFams ? 'partial' : 'completed';
    const note = [
      `${domains.length} domain${domains.length === 1 ? '' : 's'}, ${calls} calls (${cacheHits} from cache), spent $${round(spent)} (quoted $${quote.usd})`,
      skipped ? `${skipped} famil${skipped === 1 ? 'y' : 'ies'} skipped to stay within the budget` : '',
      failedFams ? `${failedFams} famil${failedFams === 1 ? 'y' : 'ies'} failed (see the per-domain status)` : '',
    ].filter(Boolean).join('; ');
    ledger();
    store.db.prepare(`UPDATE portfolio_run SET finished_at = ?, status = ?, note = ? WHERE id = ?`).run(new Date().toISOString(), status, note, runId);
    return { runId, tier: args.tier, quoted: quote.usd, spent: round(spent), calls, cacheHits, families: famOut, note };
  } finally { store.close(); }
}

interface Ctx {
  dfs: DataForSeoClient; store: PortfolioStore; rankTracker: RankTracker | null;
  paid: (r: DfsResponse) => DfsResponse; capturedAt: string;
  domains: PortfolioDomain[];
  ownedSites: Map<string, { siteUrl: string; file: string }[]>;
  /** Weekly snapshot accumulator, per `domain|location`. */
  snap: Map<string, Record<string, number | null>>;
}

const snapFor = (c: Ctx, domain: string, loc: number): Record<string, number | null> => {
  const k = `${domain}|${loc}`;
  if (!c.snap.has(k)) c.snap.set(k, {});
  return c.snap.get(k)!;
};

const MONTH_SQL = `INSERT INTO domain_month (domain, location_code, month, source, platform, organic_count, organic_etv, paid_count, paid_etv,
     pos_1_3, pos_4_10, pos_11_20, pos_21_50, pos_51_100, rank, referring_main_domains, referring_domains, backlinks,
     new_referring_main_domains, lost_referring_main_domains, mentions, ai_search_volume, fetched_at)
   VALUES (@domain, @loc, @month, @source, @platform, @oc, @oe, @pc, @pe, @b1, @b4, @b11, @b21, @b51, @rank, @rmd, @rd, @bl, @nrmd, @lrmd, @mentions, @aisv, datetime('now'))
   ON CONFLICT(domain, location_code, month, source, platform) DO UPDATE SET
     organic_count=excluded.organic_count, organic_etv=excluded.organic_etv, paid_count=excluded.paid_count, paid_etv=excluded.paid_etv,
     pos_1_3=excluded.pos_1_3, pos_4_10=excluded.pos_4_10, pos_11_20=excluded.pos_11_20, pos_21_50=excluded.pos_21_50, pos_51_100=excluded.pos_51_100,
     rank=excluded.rank, referring_main_domains=excluded.referring_main_domains, referring_domains=excluded.referring_domains, backlinks=excluded.backlinks,
     new_referring_main_domains=excluded.new_referring_main_domains, lost_referring_main_domains=excluded.lost_referring_main_domains,
     mentions=excluded.mentions, ai_search_volume=excluded.ai_search_volume, fetched_at=excluded.fetched_at`;
const BLANK = { oc: null, oe: null, pc: null, pe: null, b1: null, b4: null, b11: null, b21: null, b51: null, rank: null, rmd: null, rd: null, bl: null, nrmd: null, lrmd: null, mentions: null, aisv: null };

async function runCall(fam: PlanFamily, call: PlanFamily['calls'][number], c: Ctx): Promise<void> {
  const { dfs, store, paid, capturedAt } = c;
  const W = { maxAgeDays: WEEKLY_MAX_AGE }, M = { maxAgeDays: MONTHLY_MAX_AGE };
  const d0 = call.domains[0];
  const loc = call.locationCode;
  const month = store.db.prepare(MONTH_SQL);
  const writeMonths = (rows: Record<string, unknown>[]) => store.db.transaction(() => { for (const r of rows) month.run({ ...BLANK, ...r }); })();

  switch (fam.id) {
    case 'traffic': {
      const r = paid(await dfs.bulkTrafficEstimation(call.domains, loc, 'en', W));
      for (const [d, m] of mapBulkItems(r.tasks, 'traffic')) {
        Object.assign(snapFor(c, d, loc), { organic_etv: m.organicEtv ?? null, organic_count: m.organicCount ?? null, paid_etv: m.paidEtv ?? null, paid_count: m.paidCount ?? null });
      }
      return;
    }
    case 'backlinks-bulk': {
      const which = call.variant ?? 'rank';
      const r = paid(which === 'rank' ? await dfs.bulkRanks(call.domains, W)
        : which === 'referring' ? await dfs.bulkReferringDomains(call.domains, W)
        : which === 'backlinks' ? await dfs.bulkBacklinks(call.domains, W)
        : await dfs.bulkNewLostReferringDomains(call.domains, daysAgo(30), W));
      // Backlink metrics are per domain, not per location: copy onto every location row of the domain.
      for (const [d, v] of mapBulkItems(r.tasks, which)) {
        for (const pd of c.domains.filter(x => x.domain === d)) {
          const s = snapFor(c, d, pd.locationCode);
          if (which === 'rank') s.rank = v.rank ?? null;
          if (which === 'referring') { s.referring_main_domains = v.referringMainDomains ?? null; s.referring_domains = v.referringDomains ?? null; }
          if (which === 'backlinks') s.backlinks = v.backlinks ?? null;
          if (which === 'newlost') { s.new_referring_main_domains_30d = v.newReferringMainDomains ?? null; s.lost_referring_main_domains_30d = v.lostReferringMainDomains ?? null; }
        }
      }
      return;
    }
    case 'serp-mix': {
      const s = mapSerpMix(paid(await dfs.rankedKeywordsMetrics(d0, loc, 'en', W)).tasks);
      if (s) Object.assign(snapFor(c, d0, loc), { serp_organic: s.organic, serp_paid: s.paid, serp_aio_ref: s.aiOverviewReference, serp_featured: s.featuredSnippet, serp_local: s.localPack });
      return;
    }
    case 'labs-history': {
      // Owned: the SAME body RankTracker sends (the property's stored location, raw), so the response
      // is shared through the cache and rank_history is written from it at no extra cost.
      const owned = c.ownedSites.get(`${d0}|${loc}`);
      const rawLoc = owned?.length ? rawLocation(store.dataDir, owned[0]) ?? loc : loc;
      const r = paid(await dfs.historicalRankOverview(d0, rawLoc));
      writeMonths(mapHistoricalRankOverview(r.tasks).map(row => ({
        domain: d0, loc, month: row.month, source: 'labs', platform: '',
        oc: row.organicCount, oe: row.organicEtv, pc: row.paidCount, pe: row.paidEtv,
        b1: row.buckets?.pos_1_3 ?? null, b4: row.buckets?.pos_4_10 ?? null, b11: row.buckets?.pos_11_20 ?? null,
        b21: row.buckets?.pos_21_50 ?? null, b51: row.buckets?.pos_51_100 ?? null,
      })));
      if (owned?.length && c.rankTracker) {
        for (const p of owned) {
          try { await c.rankTracker.run(p.siteUrl, {}, () => {}, new AbortController().signal); } catch { /* the portfolio rows are written; rank_history is a bonus */ }
        }
      }
      return;
    }
    case 'backlinks-history': {
      const from = new Date(); from.setUTCDate(1); from.setUTCMonth(from.getUTCMonth() - HISTORY_MONTHS);
      const r = paid(await dfs.backlinksHistory(d0, from.toISOString().slice(0, 10), undefined, 'one_hundred', M));
      writeMonths(mapBacklinksHistory(r.tasks).map(row => ({
        domain: d0, loc, month: row.month, source: 'backlinks', platform: '',
        rank: row.rank, rmd: row.referringMainDomains, rd: row.referringDomains, bl: row.backlinks,
        nrmd: row.newReferringMainDomains, lrmd: row.lostReferringMainDomains,
      })));
      return;
    }
    case 'countries': {
      const r = paid(await dfs.domainRankOverviewAllLocations(d0, 300, M));
      const ins = store.db.prepare(`INSERT OR REPLACE INTO domain_country (domain, location_code, captured_at, country_code, etv, count) VALUES (?, ?, ?, ?, ?, ?)`);
      store.db.transaction(() => { for (const row of mapCountries(r.tasks, 25)) ins.run(d0, loc, capturedAt, row.countryCode, row.etv, row.count); })();
      return;
    }
    case 'top-pages-traffic': {
      const r = paid(await dfs.relevantPages(d0, loc, 'en', 25));
      writeTopPages(store, d0, loc, capturedAt, 'traffic', '', mapRelevantPages(r.tasks));
      return;
    }
    case 'top-pages-links': {
      const r = paid(await dfs.domainPages(d0, 25, M));
      writeTopPages(store, d0, loc, capturedAt, 'links', '', mapDomainPages(r.tasks));
      return;
    }
    case 'llm-history': {
      const platform = call.platform ?? 'google';
      const r = paid(await dfs.llmHistorical(d0, platform, loc, 'en', M));
      // ChatGPT is asked at 2840 (US only) but stored against each of the domain's own location rows.
      const homeLocs = c.domains.filter(x => x.domain === d0).map(x => x.locationCode);
      const rows = mapLlmHistorical(r.tasks);
      writeMonths(homeLocs.flatMap(hl => (platform === 'google' && hl !== loc ? [] : rows.map(row => ({
        domain: d0, loc: hl, month: row.month, source: 'llm', platform, mentions: row.mentions, aisv: row.aiSearchVolume,
      })))));
      return;
    }
    case 'llm-top-pages': {
      const r = paid(await dfs.llmTopMentionedPages(d0, 'google', loc, 'en', 20, M));
      writeTopPages(store, d0, loc, capturedAt, 'cited', 'google', mapLlmTopPages(r.tasks, d0, 20) /* rows bill $0.001 each: ask only for what's kept */);
      return;
    }
    case 'llm-top-sources': {
      const r = paid(await dfs.llmTopMentionedDomains(d0, 'google', loc, 'en', 21, M));
      const ins = store.db.prepare(`INSERT OR REPLACE INTO domain_cited_source (domain, location_code, captured_at, platform, source_domain, mentions, ai_search_volume) VALUES (?, ?, ?, 'google', ?, ?, ?)`);
      store.db.transaction(() => { for (const s of mapLlmTopDomains(r.tasks, d0, 20)) ins.run(d0, loc, capturedAt, s.sourceDomain, s.mentions, s.aiSearchVolume); })();
      return;
    }
  }
}

function writeSnapshots(store: PortfolioStore, snap: Map<string, Record<string, number | null>>, capturedAt: string): void {
  const cols = ['organic_count', 'organic_etv', 'paid_count', 'paid_etv', 'rank', 'referring_main_domains', 'referring_domains', 'backlinks',
    'new_referring_main_domains_30d', 'lost_referring_main_domains_30d', 'serp_organic', 'serp_paid', 'serp_aio_ref', 'serp_featured', 'serp_local'];
  const ins = store.db.prepare(`INSERT OR REPLACE INTO domain_snapshot (domain, location_code, captured_at, ${cols.join(', ')}) VALUES (?, ?, ?, ${cols.map(() => '?').join(', ')})`);
  store.db.transaction(() => {
    for (const [k, v] of snap) {
      const [domain, loc] = k.split('|');
      ins.run(domain, Number(loc), capturedAt, ...cols.map(col => v[col] ?? null));
    }
  })();
}

function writeTopPages(store: PortfolioStore, domain: string, loc: number, capturedAt: string, kind: 'traffic' | 'links' | 'cited', platform: string, rows: { url: string }[]): void {
  const ins = store.db.prepare(`INSERT OR REPLACE INTO domain_top_page (domain, location_code, captured_at, kind, platform, rank_order, url, metrics_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  store.db.transaction(() => {
    rows.forEach((r, i) => ins.run(domain, loc, capturedAt, kind, platform, i, r.url, JSON.stringify(r)));
    // Keep the latest two captures per (domain, location, kind, platform): "now" and "before".
    store.db.prepare(
      `DELETE FROM domain_top_page WHERE domain = ? AND location_code = ? AND kind = ? AND platform = ? AND captured_at NOT IN (
         SELECT DISTINCT captured_at FROM domain_top_page WHERE domain = ? AND location_code = ? AND kind = ? AND platform = ? ORDER BY captured_at DESC LIMIT 2)`,
    ).run(domain, loc, kind, platform, domain, loc, kind, platform);
  })();
}

/** (domain|loc) → the owned properties behind it, from the store's link table. */
function ownedSiteIndex(dataDir: string, store: PortfolioStore): Map<string, { siteUrl: string; file: string }[]> {
  const files = new Map(listLocalProperties(dataDir).map(p => [p.siteUrl, p.file]));
  const m = new Map<string, { siteUrl: string; file: string }[]>();
  for (const r of store.db.prepare('SELECT site_url, domain, location_code FROM portfolio_domain_property').all() as any[]) {
    const file = files.get(r.site_url);
    if (!file) continue;
    const k = `${r.domain}|${r.location_code}`;
    m.set(k, [...(m.get(k) ?? []), { siteUrl: r.site_url, file }]);
  }
  return m;
}

function rawLocation(dataDir: string, p: { siteUrl: string; file: string }): string | number | undefined {
  try { const a = new AuditDatabase(path.join(dataDir, p.file)); try { return a.getDfsLocation(p.siteUrl); } finally { a.close(); } } catch { return undefined; }
}

const daysAgo = (n: number): string => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const round = (v: number): number => Math.round(v * 10000) / 10000;
