import Database from 'better-sqlite3';
import path from 'node:path';
import { PortfolioStore, LOCATION_ISO, LOCATION_LABEL, type PortfolioDomain } from './PortfolioStore.js';
import { lastCompleteMonth, isPartialMonth } from './portfolioIngest.js';
import { countChange } from './displayRules.js';
import { clickWindows, monthlyClicks } from './summaryData.js';
import { listLocalProperties } from './webServer.js';
import { urlKey, hostFormForProperty } from './url-key.js';

/**
 * The portfolio payloads (design/portfolio/SPEC.md v1.1). Pure reads: `_portfolio.db` plus, for owned
 * rows, a few cheap indexed reads of each property DB (never getDashboardData, about 6 s on a big DB).
 *
 * Honesty rules this file enforces (the spec's section 6):
 *  - every change compares the LAST COMPLETE month with the month before (Month) or 12 months before
 *    (Year); the current month is month-to-date and is only ever shown flagged `partial`;
 *  - estimates (DataForSEO) and measurements (GSC) are separate fields, never blended;
 *  - a missing value carries a reason (`empty`): not fetched, API not enabled, fetch failed, or no
 *    data at this location. A real zero is a number.
 */
export const PORTFOLIO_PAYLOAD_VERSION = '1';

export interface Change { from: string; to: string; mode: 'pct' | 'abs'; value: number; diff: number }
export interface Metric {
  value: number | null;
  /** Where the headline value came from: this week's snapshot, or the last complete month. */
  source: 'snapshot' | 'history' | null;
  asOf: string | null;
  month: Change | null;
  year: Change | null;
  /** 12 points: the complete months ending at the last complete month (null = no data that month). */
  spark: (number | null)[];
  /** The month-to-date value, shown hollow / "to date". Never used in a change. */
  partial: number | null;
  empty?: string;
}

export interface PortfolioRow {
  domain: string;
  locationCode: number;
  country: string;      // ISO code for the chip
  countryName: string;
  kind: 'owned' | 'watched';
  group: string | null;
  siteUrls: string[];
  /** Owned only: GSC clicks, 28 days (measured), vs the prior 28. */
  clicks28: { value: number; prior: number; change: Change; window: { start: string; end: string } } | null;
  audit: { score: number; prior: number | null; at: string } | null;
  organicKeywords: Metric;
  organicTraffic: Metric;
  paidKeywords: Metric;
  paidTraffic: Metric;
  referringDomains: Metric;
  domainRank: Metric;
  /** AI Overviews + ChatGPT mentions by month (LLM Mentions history). */
  aiMentions: Metric & { platforms: { google: number | null; chat_gpt: number | null }; chatgptUsOnly: boolean };
  attention: string[];
}

export interface ScheduleView {
  enabled: boolean; budgetUsd: number; weeklyDow: number; monthlyDom: number;
  nextWeeklyDue: string | null; nextMonthlyDue: string | null; consentedAt: string | null;
}

export interface PortfolioPayload {
  version: string;
  generatedAt: string;
  months: { lastComplete: string; previous: string; yearAgo: string; current: string };
  counts: { owned: number; watched: number; attention: number };
  groups: string[];
  refresh: {
    weeklyCapturedAt: string | null;
    monthlyCapturedAt: string | null;
    schedule: ScheduleView | null;
    spentThisMonth: number;
    lastRuns: { id: number; startedAt: string; tier: string; trigger: string; status: string; spent: number; quoted: number | null; note: string | null }[];
  };
  rows: PortfolioRow[];
  empty: boolean;
  notes: string[];
}

export const addMonths = (ym: string, n: number): string => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
const monthsEnding = (end: string, k: number): string[] => Array.from({ length: k }, (_, i) => addMonths(end, i - k + 1));

const change = (cur: number | null | undefined, prior: number | null | undefined, from: string, to: string): Change | null => {
  if (cur == null || prior == null) return null;
  const c = countChange(cur, prior);
  return { from, to, mode: c.mode, value: c.value, diff: c.diff };
};

type Fetches = ReturnType<PortfolioStore['fetchState']>;
type MonthRow = Record<string, any>;

export function getPortfolioData(dataDir: string, now: Date = new Date()): PortfolioPayload {
  const L = lastCompleteMonth(now), P = addMonths(L, -1), Y = addMonths(L, -12), C = addMonths(L, 1);
  const store = new PortfolioStore(dataDir);
  try {
    store.syncOwned();
    const domains = store.list();
    const fetches = store.fetchState();
    const months = readMonths(store.db);
    const snaps = latestSnapshots(store.db);
    const files = new Map(listLocalProperties(dataDir).map(p => [p.siteUrl, p.file]));
    const rows = domains.map(d => buildRow(dataDir, files, d, { L, P, Y, C, now }, months, snaps.get(`${d.domain}|${d.locationCode}`) ?? null, fetches));
    const weekly = (store.db.prepare(`SELECT MAX(captured_at) m FROM domain_snapshot`).get() as { m: string | null }).m;
    const monthly = (store.db.prepare(`SELECT MAX(fetched_at) m FROM domain_month`).get() as { m: string | null }).m;
    const runs = store.db.prepare(`SELECT id, started_at, tier, trigger, status, spent_usd, quoted_usd, note FROM portfolio_run ORDER BY id DESC LIMIT 5`).all() as any[];
    const notes: string[] = [];
    if (!weekly && !monthly) notes.push('No DataForSEO data yet: ask in chat to refresh the portfolio (the refresh quotes its cost first).');
    return {
      version: PORTFOLIO_PAYLOAD_VERSION,
      generatedAt: now.toISOString(),
      months: { lastComplete: L, previous: P, yearAgo: Y, current: C },
      counts: { owned: rows.filter(r => r.kind === 'owned').length, watched: rows.filter(r => r.kind === 'watched').length, attention: rows.filter(r => r.attention.length).length },
      groups: [...new Set(rows.map(r => r.group).filter((g): g is string => !!g))].sort(),
      refresh: {
        weeklyCapturedAt: weekly, monthlyCapturedAt: monthly,
        schedule: readSchedule(store.db), spentThisMonth: round2(store.spentThisMonth(now)),
        lastRuns: runs.map(r => ({ id: r.id, startedAt: r.started_at, tier: r.tier, trigger: r.trigger, status: r.status, spent: round2(r.spent_usd), quoted: r.quoted_usd, note: r.note })),
      },
      rows,
      empty: rows.length === 0,
      notes,
    };
  } finally { store.close(); }
}

export function readSchedule(db: Database.Database): ScheduleView | null {
  const s = db.prepare(`SELECT * FROM portfolio_schedule WHERE id = 1`).get() as any;
  if (!s) return null;
  return {
    enabled: !!s.enabled, budgetUsd: s.budget_usd_month, weeklyDow: s.weekly_dow, monthlyDom: s.monthly_dom,
    nextWeeklyDue: s.next_weekly_due, nextMonthlyDue: s.next_monthly_due, consentedAt: s.consented_at,
  };
}

/** domain|loc|source|platform → month → row */
function readMonths(db: Database.Database): Map<string, Map<string, MonthRow>> {
  const out = new Map<string, Map<string, MonthRow>>();
  for (const r of db.prepare(`SELECT * FROM domain_month`).all() as MonthRow[]) {
    const k = `${r.domain}|${r.location_code}|${r.source}|${r.platform}`;
    if (!out.has(k)) out.set(k, new Map());
    out.get(k)!.set(r.month, r);
  }
  return out;
}

function latestSnapshots(db: Database.Database): Map<string, MonthRow> {
  const out = new Map<string, MonthRow>();
  for (const r of db.prepare(
    `SELECT s.* FROM domain_snapshot s JOIN (SELECT domain, location_code, MAX(captured_at) m FROM domain_snapshot GROUP BY domain, location_code) x
       ON x.domain = s.domain AND x.location_code = s.location_code AND x.m = s.captured_at`).all() as MonthRow[]) {
    out.set(`${r.domain}|${r.location_code}`, r);
  }
  return out;
}

interface Months { L: string; P: string; Y: string; C: string; now: Date }

/**
 * The latest COMPLETE month a series actually holds, at or before the calendar's last complete month.
 * DataForSEO Labs history lags a month or two (a live response ended at 2026-07 on 24 Oct), so
 * comparing at the calendar month would read as "no change"; each series compares its own latest
 * complete month with the one before, and says which months it compared.
 */
export function seriesEnd(series: Map<string, MonthRow> | undefined, L: string, col?: string): string {
  if (!series) return L;
  let best: string | null = null;
  for (const [mo, r] of series) if (mo <= L && (!col || r[col] != null) && (!best || mo > best)) best = mo;
  return best ?? L;
}

function metricFrom(
  series: Map<string, MonthRow> | undefined, col: string, m: Months,
  snapVal: number | null | undefined, snapAt: string | null, empty: string | undefined,
): Metric {
  const at = (mo: string): number | null => { const v = series?.get(mo)?.[col]; return v == null ? null : Number(v); };
  const end = seriesEnd(series, m.L, col), prev = addMonths(end, -1), yearAgo = addMonths(end, -12);
  const histL = at(end);
  const value = snapVal != null ? Number(snapVal) : histL;
  const source = snapVal != null ? 'snapshot' : histL != null ? 'history' : null;
  const out: Metric = {
    value, source, asOf: source === 'snapshot' ? snapAt : source === 'history' ? end : null,
    month: change(histL, at(prev), prev, end),
    year: change(histL, at(yearAgo), yearAgo, end),
    spark: monthsEnding(end, 12).map(at),
    partial: isPartialMonth(m.C, m.now) ? at(m.C) : null,
  };
  if (value == null) out.empty = empty ?? 'not fetched yet';
  return out;
}

/** Why a metric is empty: the fetch status of the endpoints that feed it. */
function emptyReason(fetches: Fetches, d: PortfolioDomain, endpoints: string[], api: string): string | undefined {
  let seen = false;
  for (const ep of endpoints) {
    const f = fetches.get(`${d.domain}|${d.locationCode}|${ep}`);
    if (!f) continue;
    seen = true;
    if (f.status === 'not-enabled') return `${api} not enabled on the DataForSEO account`;
    if (f.status === 'skipped-budget') return 'skipped to stay within the budget';
    if (f.status === 'error') return 'last fetch failed';
  }
  return seen ? 'no data at this location' : undefined;
}

function buildRow(
  dataDir: string, files: Map<string, string>, d: PortfolioDomain, m: Months,
  months: Map<string, Map<string, MonthRow>>, snap: MonthRow | null, fetches: Fetches,
): PortfolioRow {
  const key = (source: string, platform = '') => months.get(`${d.domain}|${d.locationCode}|${source}|${platform}`);
  const labs = key('labs'), bl = key('backlinks');
  const snapAt = snap?.captured_at ?? null;
  const labsEmpty = emptyReason(fetches, d, ['traffic', 'labs-history'], 'Labs');
  const blEmpty = emptyReason(fetches, d, ['backlinks-bulk', 'backlinks-history'], 'Backlinks API');
  const llmEmpty = emptyReason(fetches, d, ['llm-history:google', 'llm-history:chat_gpt'], 'LLM Mentions');

  // AI mentions: the two platforms summed per month.
  const g = key('llm', 'google'), cg = key('llm', 'chat_gpt');
  const llm = new Map<string, MonthRow>();
  for (const src of [g, cg]) for (const [mo, r] of src ?? []) {
    if (r.mentions == null) continue;
    const cur = llm.get(mo) ?? { mentions: 0 };
    cur.mentions += Number(r.mentions);
    llm.set(mo, cur);
  }
  const aiBase = metricFrom(llm.size ? llm : undefined, 'mentions', m, null, null, llmEmpty);
  const row: PortfolioRow = {
    domain: d.domain, locationCode: d.locationCode,
    country: LOCATION_ISO[d.locationCode] ?? String(d.locationCode),
    countryName: LOCATION_LABEL[d.locationCode] ?? `Location ${d.locationCode}`,
    kind: d.kind, group: d.groupLabel, siteUrls: d.siteUrls,
    clicks28: null, audit: null,
    organicKeywords: metricFrom(labs, 'organic_count', m, snap?.organic_count, snapAt, labsEmpty),
    organicTraffic: metricFrom(labs, 'organic_etv', m, snap?.organic_etv, snapAt, labsEmpty),
    paidKeywords: metricFrom(labs, 'paid_count', m, snap?.paid_count, snapAt, labsEmpty),
    paidTraffic: metricFrom(labs, 'paid_etv', m, snap?.paid_etv, snapAt, labsEmpty),
    referringDomains: metricFrom(bl, 'referring_main_domains', m, snap?.referring_main_domains, snapAt, blEmpty),
    domainRank: metricFrom(bl, 'rank', m, snap?.rank, snapAt, blEmpty),
    aiMentions: {
      ...aiBase,
      platforms: { google: g?.get(seriesEnd(g, m.L, 'mentions'))?.mentions ?? null, chat_gpt: cg?.get(seriesEnd(cg, m.L, 'mentions'))?.mentions ?? null },
      chatgptUsOnly: d.locationCode !== 2840,
    },
    attention: [],
  };
  const owned = d.kind === 'owned' ? readOwned(dataDir, files, d.siteUrls) : null;
  if (owned) { row.clicks28 = owned.clicks28; row.audit = owned.audit; }
  row.attention = attentionRules(row, { labs, bl, llm }, m, owned);
  return row;
}

interface OwnedReads {
  clicks28: PortfolioRow['clicks28'];
  audit: PortfolioRow['audit'];
  gscMax: string | null;
  lastCrawl: string | null;
}

/** GSC finalises ~2-3 days late: windows end 3 days before the newest stored day (indexed MAX, cheap). */
const gscWindowEnd = (db: Database.Database): string | null => {
  const max = (db.prepare(`SELECT MAX(date) d FROM search_analytics`).get() as { d: string | null }).d;
  return max ? new Date(Date.parse(max) - 3 * 86400000).toISOString().slice(0, 10) : null;
};

/** Cheap reads from the property DB(s) behind an owned domain: the first property with data wins. */
function readOwned(dataDir: string, files: Map<string, string>, siteUrls: string[]): OwnedReads | null {
  for (const siteUrl of siteUrls) {
    const file = files.get(siteUrl);
    if (!file) continue;
    let db: Database.Database | null = null;
    try {
      db = new Database(path.join(dataDir, file), { readonly: true, fileMustExist: true });
      const gscMax = (db.prepare(`SELECT MAX(date) d FROM search_analytics`).get() as { d: string | null }).d;
      let clicks28: OwnedReads['clicks28'] = null;
      const end = gscWindowEnd(db);
      if (end) {
        const w = clickWindows(db, end);
        const c = countChange(w.current, w.prior);
        clicks28 = { value: w.current, prior: w.prior, change: { from: w.priorWindow.start, to: w.window.end, mode: c.mode, value: c.value, diff: c.diff }, window: w.window };
      }
      let audit: OwnedReads['audit'] = null;
      try {
        const runs = db.prepare(`SELECT health_score s, finished_at f FROM audit_runs WHERE health_score IS NOT NULL AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 2`).all() as { s: number; f: string }[];
        if (runs[0]) audit = { score: runs[0].s, prior: runs[1]?.s ?? null, at: runs[0].f };
      } catch { /* pre-0.16 DB: no health columns */ }
      let lastCrawl: string | null = null;
      try { lastCrawl = (db.prepare(`SELECT MAX(COALESCE(finished_at, started_at)) f FROM crawl_metadata WHERE status = 'completed'`).get() as { f: string | null }).f; } catch { /* no crawl */ }
      if (gscMax || audit || lastCrawl) return { clicks28, audit, gscMax, lastCrawl };
    } catch { /* unreadable */ } finally { db?.close(); }
  }
  return null;
}

const pctDown = (cur: number | null | undefined, prior: number | null | undefined): number | null =>
  cur == null || prior == null || prior <= 0 ? null : ((prior - cur) / prior) * 100;
const fmt = (v: number): string => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}K` : `${Math.round(v)}`);
const ageDays = (iso: string | null, now: Date): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso.length <= 10 ? `${iso}T00:00:00Z` : iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
  return Number.isFinite(t) ? (now.getTime() - t) / 86400000 : null;
};

/** "Needs attention": deterministic, de-noised rules (spec v1.1). Each reason names its numbers and months. */
export function attentionRules(
  r: PortfolioRow, s: { labs?: Map<string, MonthRow>; bl?: Map<string, MonthRow>; llm: Map<string, MonthRow> },
  m: Months, owned: OwnedReads | null,
): string[] {
  const out: string[] = [];
  // Each rule compares the series' own latest complete month (see seriesEnd).
  const ends = (ser: Map<string, MonthRow> | undefined, col: string) => { const e = seriesEnd(ser, m.L, col); return { e, p: addMonths(e, -1), p2: addMonths(e, -2) }; };
  if (r.clicks28 && r.clicks28.prior >= 200) {
    const down = pctDown(r.clicks28.value, r.clicks28.prior);
    if (down != null && down >= 20) out.push(`Search Console clicks down ${Math.round(down)}% (28 days: ${fmt(r.clicks28.value)} vs ${fmt(r.clicks28.prior)})`);
  }
  // Labs ETV moves when DataForSEO rebuilds its database, so one month needs ≥30%, or two running ≥20%.
  const etv = (mo: string) => s.labs?.get(mo)?.organic_etv as number | null | undefined;
  const te = ends(s.labs, 'organic_etv');
  const e1 = pctDown(etv(te.e), etv(te.p)), e2 = pctDown(etv(te.p), etv(te.p2));
  if ((etv(te.p) ?? 0) >= 100 && e1 != null) {
    if (e1 >= 30) out.push(`Organic traffic (estimated) down ${Math.round(e1)}% in ${te.e}`);
    else if (e1 >= 20 && e2 != null && e2 >= 20) out.push(`Organic traffic (estimated) down ${Math.round(e2)}% then ${Math.round(e1)}% (two months running)`);
  }
  const rmd = (mo: string) => s.bl?.get(mo)?.referring_main_domains as number | null | undefined;
  const re = ends(s.bl, 'referring_main_domains');
  const rdDown = pctDown(rmd(re.e), rmd(re.p));
  if ((rmd(re.p) ?? 0) >= 50 && rdDown != null && rdDown >= 10) out.push(`Referring domains down ${Math.round(rdDown)}% in ${re.e} (${fmt(rmd(re.e)!)} from ${fmt(rmd(re.p)!)})`);
  const rk = (mo: string) => s.bl?.get(mo)?.rank as number | null | undefined;
  const ke = ends(s.bl, 'rank');
  const rkL = rk(ke.e), rkP = rk(ke.p);
  if (rkL != null && rkP != null && rkP - rkL >= 5) out.push(`Domain Rank (DataForSEO) down ${Math.round(rkP - rkL)} points in ${ke.e}`);
  const ai = (mo: string) => s.llm.get(mo)?.mentions as number | null | undefined;
  const ae = ends(s.llm, 'mentions');
  const aiDown = pctDown(ai(ae.e), ai(ae.p));
  if ((ai(ae.p) ?? 0) >= 20 && aiDown != null && aiDown >= 30) out.push(`AI mentions down ${Math.round(aiDown)}% in ${ae.e} (AI Overviews + ChatGPT)`);
  if (r.audit && r.audit.prior != null && r.audit.prior - r.audit.score >= 5) out.push(`Audit health down ${r.audit.prior - r.audit.score} points to ${r.audit.score}`);
  if (owned) {
    const g = ageDays(owned.gscMax, m.now);
    if (g != null && g > 10) out.push(`Search Console data is ${Math.floor(g)} days old: sync it`);
    const c = ageDays(owned.lastCrawl, m.now);
    if (c != null && c > 30) out.push(`Last crawl was ${Math.floor(c)} days ago`);
  }
  return out;
}

// ── Domain overview ─────────────────────────────────────────────────────────────────────────

export interface CrawlState { status: number | null; indexable: boolean | null; label: string }

export interface DomainOverview {
  version: string;
  row: PortfolioRow;
  months: PortfolioPayload['months'];
  series: {
    month: string; partial: boolean;
    organicEtv: number | null; paidEtv: number | null; organicCount: number | null;
    buckets: { pos_1_3: number | null; pos_4_10: number | null; pos_11_20: number | null; pos_21_50: number | null; pos_51_100: number | null };
    referringMainDomains: number | null; rank: number | null; newReferringMainDomains: number | null; lostReferringMainDomains: number | null;
    aiGoogle: { mentions: number | null; volume: number | null }; aiChatgpt: { mentions: number | null; volume: number | null };
    gscClicks: number | null;
  }[];
  serpMix: { organic: number | null; paid: number | null; aiOverviewReference: number | null; featuredSnippet: number | null; localPack: number | null; capturedAt: string } | null;
  trafficShare: { basis: string; domains: { domain: string; etv: number; share: number }[] } | null;
  countries: { code: number; iso: string; name: string; etv: number; count: number; share: number }[];
  topPages: {
    traffic: { url: string; etv: number | null; keywords: number | null; crawl: CrawlState | null; clicks28: number | null }[];
    links: { url: string; referringDomains: number | null; backlinks: number | null; brokenBacklinks: number | null; crawl: CrawlState | null; clicks28: number | null }[];
    cited: { url: string; mentions: number | null; volume: number | null; crawl: CrawlState | null; clicks28: number | null }[];
  };
  citedSources: { domain: string; mentions: number | null; volume: number | null }[];
  /** Owned only: content-recon rows (keyword, AIO shown, our page cited yes/no/unknown, rank, GSC). */
  rankCitation: { keyword: string; url: string; aioPresent: boolean | null; aioCitesUs: boolean | null; organicRank: number | null; gscPosition: number | null; impressions: number | null; researchedAt: string | null }[];
  gsc: { clicks28: number; impressions28: number; pagesWithClicks: number; window: { start: string; end: string } } | null;
  capturedAt: { weekly: string | null; monthly: string | null };
  notes: string[];
}

export function getDomainOverview(dataDir: string, domainIn: string, locationCode?: number, now: Date = new Date()): DomainOverview | null {
  const portfolio = getPortfolioData(dataDir, now);
  const domain = domainIn.trim().toLowerCase().replace(/^www\./, '');
  const row = portfolio.rows.find(r => r.domain === domain && (locationCode == null || r.locationCode === locationCode));
  if (!row) return null;
  const store = new PortfolioStore(dataDir);
  const ownedDb = row.kind === 'owned' ? openOwned(dataDir, row.siteUrls) : null;
  try {
    const L = portfolio.months.lastComplete;
    const get = (source: string, platform = '') => new Map((store.db.prepare(
      `SELECT * FROM domain_month WHERE domain = ? AND location_code = ? AND source = ? AND platform = ?`,
    ).all(row.domain, row.locationCode, source, platform) as MonthRow[]).map(r => [r.month as string, r]));
    const labs = get('labs'), bl = get('backlinks'), g = get('llm', 'google'), cg = get('llm', 'chat_gpt');

    const gscMonthly = new Map<string, number>();
    if (ownedDb) {
      try {
        const max = (ownedDb.db.prepare(`SELECT MAX(date) d FROM search_analytics`).get() as { d: string | null }).d;
        const mc = max ? monthlyClicks(ownedDb.db, max) : null;
        for (const mo of mc?.months ?? []) if (!mo.partial && mo.clicks != null) gscMonthly.set(mo.month, mo.clicks);
      } catch { /* no GSC */ }
    }
    const held = [...new Set([...labs.keys(), ...bl.keys(), ...g.keys(), ...cg.keys()])].sort();
    const first = held.length ? held[Math.max(0, held.length - 25)] : addMonths(L, -23);
    const span: string[] = [];
    for (let mo = first; mo <= portfolio.months.current; mo = addMonths(mo, 1)) span.push(mo);
    const num = (v: unknown): number | null => (v == null ? null : Number(v));
    const series = span.map(mo => ({
      month: mo, partial: mo > L,
      organicEtv: num(labs.get(mo)?.organic_etv), paidEtv: num(labs.get(mo)?.paid_etv), organicCount: num(labs.get(mo)?.organic_count),
      buckets: { pos_1_3: num(labs.get(mo)?.pos_1_3), pos_4_10: num(labs.get(mo)?.pos_4_10), pos_11_20: num(labs.get(mo)?.pos_11_20), pos_21_50: num(labs.get(mo)?.pos_21_50), pos_51_100: num(labs.get(mo)?.pos_51_100) },
      referringMainDomains: num(bl.get(mo)?.referring_main_domains), rank: num(bl.get(mo)?.rank),
      newReferringMainDomains: num(bl.get(mo)?.new_referring_main_domains), lostReferringMainDomains: num(bl.get(mo)?.lost_referring_main_domains),
      aiGoogle: { mentions: num(g.get(mo)?.mentions), volume: num(g.get(mo)?.ai_search_volume) },
      aiChatgpt: { mentions: num(cg.get(mo)?.mentions), volume: num(cg.get(mo)?.ai_search_volume) },
      gscClicks: gscMonthly.get(mo) ?? null,
    }));

    const snap = store.db.prepare(`SELECT * FROM domain_snapshot WHERE domain = ? AND location_code = ? ORDER BY captured_at DESC LIMIT 1`).get(row.domain, row.locationCode) as MonthRow | undefined;
    const serpMix = snap && (snap.serp_organic != null || snap.serp_aio_ref != null)
      ? { organic: snap.serp_organic, paid: snap.serp_paid, aiOverviewReference: snap.serp_aio_ref, featuredSnippet: snap.serp_featured, localPack: snap.serp_local, capturedAt: snap.captured_at }
      : null;

    // Traffic share among the domain's group (same location), else the whole portfolio at that location.
    const peers = portfolio.rows.filter(r => r.locationCode === row.locationCode && (row.group ? r.group === row.group || r.domain === row.domain : true));
    const withEtv = peers.filter(p => (p.organicTraffic.value ?? 0) > 0);
    const total = withEtv.reduce((s, p) => s + (p.organicTraffic.value ?? 0), 0);
    const trafficShare = withEtv.length >= 2 && total > 0 ? {
      basis: row.group ? `among the ${withEtv.length} domains in "${row.group}" (${row.country})` : `among the ${withEtv.length} portfolio domains in ${row.country}`,
      domains: withEtv.map(p => ({ domain: p.domain, etv: p.organicTraffic.value!, share: (p.organicTraffic.value! / total) * 100 })).sort((a, b) => b.etv - a.etv),
    } : null;

    const latestAt = (table: string, extra = '', args: unknown[] = []) => (store.db.prepare(`SELECT MAX(captured_at) m FROM ${table} WHERE domain = ? AND location_code = ? ${extra}`).get(row.domain, row.locationCode, ...args) as { m: string | null }).m;
    const cAt = latestAt('domain_country');
    const cRows = cAt ? store.db.prepare(`SELECT country_code, etv, count FROM domain_country WHERE domain = ? AND location_code = ? AND captured_at = ? ORDER BY etv DESC LIMIT 10`).all(row.domain, row.locationCode, cAt) as any[] : [];
    const cTotal = cRows.reduce((s, r) => s + (r.etv || 0), 0);
    const countries = cRows.map(r => ({ code: r.country_code, iso: LOCATION_ISO[r.country_code] ?? '', name: LOCATION_LABEL[r.country_code] ?? `Location ${r.country_code}`, etv: r.etv, count: r.count, share: cTotal ? (r.etv / cTotal) * 100 : 0 }));

    const pages = (kind: string): { url: string; m: any }[] => {
      const at = latestAt('domain_top_page', 'AND kind = ?', [kind]);
      return at ? (store.db.prepare(`SELECT url, metrics_json FROM domain_top_page WHERE domain = ? AND location_code = ? AND kind = ? AND captured_at = ? ORDER BY rank_order`).all(row.domain, row.locationCode, kind, at) as any[]).map(r => ({ url: r.url, m: JSON.parse(r.metrics_json) })) : [];
    };
    const join = ownedDb ? crawlJoin(ownedDb) : () => ({ crawl: null, clicks28: null });
    const topPages = {
      traffic: pages('traffic').slice(0, 15).map(p => ({ url: p.url, etv: p.m.etv ?? null, keywords: p.m.count ?? null, ...join(p.url) })),
      links: pages('links').slice(0, 15).map(p => ({ url: p.url, referringDomains: p.m.referringMainDomains ?? null, backlinks: p.m.backlinks ?? null, brokenBacklinks: p.m.brokenBacklinks ?? null, ...join(p.url) })),
      cited: pages('cited').slice(0, 15).map(p => ({ url: p.url, mentions: p.m.mentions ?? null, volume: p.m.aiSearchVolume ?? null, ...join(p.url) })),
    };
    const sAt = latestAt('domain_cited_source');
    const citedSources = sAt ? (store.db.prepare(`SELECT source_domain, mentions, ai_search_volume FROM domain_cited_source WHERE domain = ? AND location_code = ? AND captured_at = ? ORDER BY mentions DESC LIMIT 12`).all(row.domain, row.locationCode, sAt) as any[]).map(r => ({ domain: r.source_domain, mentions: r.mentions, volume: r.ai_search_volume })) : [];

    let rankCitation: DomainOverview['rankCitation'] = [];
    let gsc: DomainOverview['gsc'] = null;
    if (ownedDb) {
      try {
        rankCitation = (ownedDb.db.prepare(`SELECT url_key, query, organic_rank, gsc_position, gsc_impressions, aio_present, aio_cites_us, researched_at FROM recon_page WHERE query IS NOT NULL ORDER BY gsc_impressions DESC LIMIT 40`).all() as any[])
          .map(r => ({ keyword: r.query, url: r.url_key, aioPresent: r.aio_present == null ? null : !!r.aio_present, aioCitesUs: r.aio_cites_us == null ? null : !!r.aio_cites_us, organicRank: r.organic_rank ?? null, gscPosition: r.gsc_position ?? null, impressions: r.gsc_impressions ?? null, researchedAt: r.researched_at ?? null }));
      } catch { /* no recon table */ }
      try {
        const end = gscWindowEnd(ownedDb.db);
        if (end) {
          const start = new Date(Date.parse(end) - 27 * 86400000).toISOString().slice(0, 10);
          const t = ownedDb.db.prepare(`SELECT COALESCE(SUM(clicks),0) c, COALESCE(SUM(impressions),0) i FROM gsc_rows WHERE date >= ? AND date <= ?`).get(start, end) as { c: number; i: number };
          const p = ownedDb.db.prepare(`SELECT COUNT(*) n FROM (SELECT page_key FROM gsc_rows WHERE date >= ? AND date <= ? GROUP BY page_key HAVING SUM(clicks) > 0)`).get(start, end) as { n: number };
          gsc = { clicks28: t.c, impressions28: t.i, pagesWithClicks: p.n, window: { start, end } };
        }
      } catch { /* no GSC */ }
    }

    const notes: string[] = [];
    if (row.aiMentions.chatgptUsOnly) notes.push('ChatGPT mention data covers the United States only, so the ChatGPT figures for this domain are US figures.');
    notes.push('AI Mode, Gemini and Perplexity are not measured by this data source.');
    const monthlyAt = (store.db.prepare(`SELECT MAX(fetched_at) m FROM domain_month WHERE domain = ? AND location_code = ?`).get(row.domain, row.locationCode) as { m: string | null }).m;
    return {
      version: PORTFOLIO_PAYLOAD_VERSION, row, months: portfolio.months, series, serpMix, trafficShare, countries, topPages,
      citedSources, rankCitation, gsc, capturedAt: { weekly: snap?.captured_at ?? null, monthly: monthlyAt }, notes,
    };
  } finally { ownedDb?.db.close(); store.close(); }
}

function openOwned(dataDir: string, siteUrls: string[]): { db: Database.Database; siteUrl: string } | null {
  const files = new Map(listLocalProperties(dataDir).map(p => [p.siteUrl, p.file]));
  for (const siteUrl of siteUrls) {
    const file = files.get(siteUrl);
    if (!file) continue;
    try { return { db: new Database(path.join(dataDir, file), { readonly: true, fileMustExist: true }), siteUrl }; } catch { /* next */ }
  }
  return null;
}

/** For an owned domain: a page URL → our crawl's status + 28-day GSC clicks, joined on urlKey. */
function crawlJoin(owned: { db: Database.Database; siteUrl: string }): (url: string) => { crawl: CrawlState | null; clicks28: number | null } {
  const opts = { hostForm: hostFormForProperty(owned.siteUrl) ?? 'asis' };
  let pageQ: Database.Statement | null = null;
  try { pageQ = owned.db.prepare(`SELECT status_code, indexable FROM pages WHERE url_key = ?`); } catch { pageQ = null; }
  let clicksQ: Database.Statement | null = null, start = '', end = '';
  try {
    const e = gscWindowEnd(owned.db);
    if (e) {
      end = e;
      start = new Date(Date.parse(end) - 27 * 86400000).toISOString().slice(0, 10);
      clicksQ = owned.db.prepare(`SELECT COALESCE(SUM(clicks),0) c FROM gsc_rows WHERE page_key = ? AND date >= ? AND date <= ?`);
    }
  } catch { /* no GSC */ }
  return (url: string) => {
    let k: string;
    try { k = urlKey(url, opts as any); } catch { return { crawl: null, clicks28: null }; }
    const p = pageQ?.get(k) as { status_code: number | null; indexable: number | null } | undefined;
    const crawl: CrawlState | null = p ? {
      status: p.status_code, indexable: p.indexable == null ? null : !!p.indexable,
      label: p.status_code == null ? 'not fetched' : p.status_code === 200 ? (p.indexable ? '200 indexable' : '200 noindex') : String(p.status_code),
    } : null;
    let clicks28: number | null = null;
    try { clicks28 = clicksQ ? (clicksQ.get(k, start, end) as { c: number }).c : null; } catch { clicks28 = null; }
    return { crawl, clicks28 };
  };
}

const round2 = (v: number): number => Math.round((v || 0) * 100) / 100;
