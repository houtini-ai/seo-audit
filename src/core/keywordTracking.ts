import type Database from 'better-sqlite3';
import type { DataForSeoClient, DfsResponse } from './DataForSeoClient.js';
import { PortfolioStore, LOCATION_LABEL, type PortfolioDomain } from './PortfolioStore.js';
import { serpCheckPrice } from './portfolioPlan.js';
import { classifyDfsError } from './PortfolioRefresh.js';
import { organicHost, hostMatchesDomain } from './serpHost.js';
import { serpItemHas } from './serpRecon.js';

/**
 * Keyword position tracking for the portfolio. The user keeps a list of keywords per location; a
 * check is ONE live Google organic SERP per (keyword, location), which answers the position of every
 * portfolio domain at that location at once. Paid and on demand only: quoted first, never scheduled,
 * never bulk. History is kept (keyword_check / keyword_position), so change over time is a read.
 *
 * Honesty rules: a domain not in the fetched depth has position NULL with the depth ("not in the top
 * 100"), never 0; organic results whose host can't be read are counted (unattributed) and reported,
 * because a domain could sit behind one of them.
 */

export const MAX_TRACKED_KEYWORDS = 200;
export const MAX_KEYWORD_LENGTH = 200;
export const DEFAULT_TRACK_DEPTH = 100;
/** Checks of at most this many keywords run inside the tool call; more go to the job system. Zero: a
 * depth-100 SERP takes ~26 s (fixture) and the per-call timeout allows 120 s, so even one could pass the ~60 s ceiling. */
export const SYNC_MAX_KEYWORDS = 0;
/** A repeat check within a day reuses the cached SERP (free) instead of paying for the same reading. */
const CHECK_MAX_AGE_DAYS = 1;

/** Lower-case, trimmed, single spaces: Google treats case and spacing as the same query. */
export function normalizeKeyword(k: string): string {
  return String(k ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

export interface TrackedKeyword { keyword: string; locationCode: number; languageCode: string; addedAt: string }

export function listTrackedKeywords(db: Database.Database, locationCode?: number): TrackedKeyword[] {
  return (db.prepare(`SELECT keyword, location_code, language_code, added_at FROM tracked_keyword ${locationCode != null ? 'WHERE location_code = ?' : ''} ORDER BY location_code, keyword`)
    .all(...(locationCode != null ? [locationCode] : [])) as any[])
    .map(r => ({ keyword: r.keyword, locationCode: r.location_code, languageCode: r.language_code, addedAt: r.added_at }));
}

export interface AddKeywordsResult { added: string[]; alreadyTracked: string[]; invalid: { keyword: string; reason: string }[]; overCap: string[]; total: number }

/** Add keywords at one location. The whole list is capped at MAX_TRACKED_KEYWORDS; what didn't fit is
 * returned in overCap, never dropped silently. */
export function addTrackedKeywords(store: PortfolioStore, keywords: string[], locationCode: number, languageCode = 'en'): AddKeywordsResult {
  const out: AddKeywordsResult = { added: [], alreadyTracked: [], invalid: [], overCap: [], total: 0 };
  const exists = store.db.prepare(`SELECT 1 FROM tracked_keyword WHERE keyword = ? AND location_code = ?`);
  const ins = store.db.prepare(`INSERT INTO tracked_keyword (keyword, location_code, language_code) VALUES (?, ?, ?)`);
  let total = (store.db.prepare(`SELECT COUNT(*) n FROM tracked_keyword`).get() as { n: number }).n;
  const seen = new Set<string>();
  store.db.transaction(() => {
    for (const raw of keywords) {
      const k = normalizeKeyword(raw);
      if (!k) { out.invalid.push({ keyword: String(raw), reason: 'empty' }); continue; }
      if (k.length > MAX_KEYWORD_LENGTH) { out.invalid.push({ keyword: k.slice(0, 60) + '...', reason: `longer than ${MAX_KEYWORD_LENGTH} characters` }); continue; }
      if (seen.has(k)) continue;
      seen.add(k);
      if (exists.get(k, locationCode)) { out.alreadyTracked.push(k); continue; }
      if (total >= MAX_TRACKED_KEYWORDS) { out.overCap.push(k); continue; }
      ins.run(k, locationCode, languageCode);
      out.added.push(k);
      total++;
    }
  })();
  out.total = total;
  return out;
}

/** Stop tracking keywords. Their check history stays (re-adding a keyword brings it back). */
export function removeTrackedKeywords(store: PortfolioStore, keywords: string[], locationCode?: number): { removed: string[]; notTracked: string[] } {
  const out = { removed: [] as string[], notTracked: [] as string[] };
  const del = store.db.prepare(`DELETE FROM tracked_keyword WHERE keyword = ? ${locationCode != null ? 'AND location_code = ?' : ''}`);
  for (const raw of keywords) {
    const k = normalizeKeyword(raw);
    const n = del.run(...(locationCode != null ? [k, locationCode] : [k])).changes;
    (n ? out.removed : out.notTracked).push(k);
  }
  return out;
}

// ── Parsing ─────────────────────────────────────────────────────────────────────────────────────

export interface DomainPosition {
  domain: string;
  /** Best organic position (rank_group), or null = not in the top `serpDepth` organic results. */
  position: number | null;
  url: string | null;
  shownAs: string | null;
  /** How many of the organic results belong to this domain. */
  results: number;
}
export interface SerpPositions {
  /** The SERP's own datetime (UTC, "YYYY-MM-DD HH:MM:SS"), null when the response has none. */
  checkedAt: string | null;
  serpDepth: number;
  organicResults: number;
  /** Organic results no host could be read from (see serpHost.ts). */
  unattributed: number;
  /** DataForSEO restored a poisoned page from Google's Web mode: ranks are Web-mode ranks. */
  fromWeb: boolean;
  positions: DomainPosition[];
}

/** "2026-11-27 07:03:12 +00:00" → "2026-11-27 07:03:12" (UTC). */
export function serpDatetime(s: unknown): string | null {
  if (typeof s !== 'string' || !s.trim()) return null;
  const t = Date.parse(s.trim().replace(' ', 'T').replace(/ ?([+-]\d\d:\d\d)$/, '$1'));
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 19).replace('T', ' ') : null;
}

/** Positions of each domain on one SERP. Pure. */
export function parseSerpPositions(resp: Pick<DfsResponse, 'tasks'>, domains: string[], serpDepth: number): SerpPositions {
  const result = resp.tasks?.[0]?.result?.[0] ?? {};
  const organic = ((result.items ?? []) as any[]).filter(i => i?.type === 'organic' && (Number(i.rank_group) || 0) <= serpDepth);
  let unattributed = 0, fromWeb = false;
  const hosts = organic.map(it => {
    if (serpItemHas(it, 'from_web')) fromWeb = true;
    const h = organicHost(it);
    if (!h.host) unattributed++;
    return { rank: Number(it.rank_group) || 0, ...h };
  });
  const positions = domains.map(domain => {
    const mine = hosts.filter(h => hostMatchesDomain(h.host, domain)).sort((a, b) => a.rank - b.rank);
    const best = mine[0];
    return { domain, position: best ? best.rank : null, url: best?.url ?? null, shownAs: best?.shownAs ?? null, results: mine.length };
  });
  return { checkedAt: serpDatetime(result.datetime), serpDepth, organicResults: organic.length, unattributed, fromWeb, positions };
}

/** Store one parsed SERP. Re-reading the same SERP (a cache hit) rewrites the same rows. */
export function writeCheck(db: Database.Database, keyword: string, locationCode: number, p: SerpPositions, meta: { cost: number; cached: boolean }, now = new Date()): string {
  const at = p.checkedAt ?? now.toISOString().slice(0, 19).replace('T', ' ');
  db.transaction(() => {
    // A cache hit is the same SERP (same checked_at): keep the row that recorded what it cost.
    db.prepare(`INSERT OR ${meta.cached ? 'IGNORE' : 'REPLACE'} INTO keyword_check (keyword, location_code, checked_at, serp_depth, organic_results, unattributed, from_web, cost, cached) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(keyword, locationCode, at, p.serpDepth, p.organicResults, p.unattributed, p.fromWeb ? 1 : 0, meta.cost, meta.cached ? 1 : 0);
    const put = db.prepare(`INSERT OR REPLACE INTO keyword_position (keyword, location_code, checked_at, domain, position, url, shown_as, results, serp_depth) VALUES (?,?,?,?,?,?,?,?,?)`);
    for (const x of p.positions) put.run(keyword, locationCode, at, x.domain, x.position, x.url, x.shownAs, x.results, p.serpDepth);
  })();
  return at;
}

// ── Reading: latest position + change vs the previous check ─────────────────────────────────────

export type PositionStatus = 'first-check' | 'up' | 'down' | 'same' | 'entered' | 'dropped-out' | 'still-absent' | 'depth-changed';
export interface PositionCell {
  domain: string;
  position: number | null;
  serpDepth: number;
  url: string | null;
  shownAs: string | null;
  checkedAt: string;
  previous: number | null;
  previousCheckedAt: string | null;
  /** previous - position (positive = moved up), only when both checks found the domain. */
  change: number | null;
  status: PositionStatus;
}
export interface TrackedKeywordView extends TrackedKeyword {
  lastCheckedAt: string | null;
  serpDepth: number | null;
  unattributed: number | null;
  fromWeb: boolean;
  positions: PositionCell[];
}

export function positionStatus(cur: { position: number | null; serpDepth: number }, prev: { position: number | null; serpDepth: number } | null): { status: PositionStatus; change: number | null } {
  if (!prev) return { status: 'first-check', change: null };
  if (cur.position != null && prev.position != null) {
    const change = prev.position - cur.position;
    return { status: change > 0 ? 'up' : change < 0 ? 'down' : 'same', change };
  }
  // An absence only means "not in the top N": compare it only against the same N.
  if (cur.serpDepth !== prev.serpDepth) return { status: 'depth-changed', change: null };
  if (cur.position != null) return { status: 'entered', change: null };
  if (prev.position != null) return { status: 'dropped-out', change: null };
  return { status: 'still-absent', change: null };
}

/** Every tracked keyword (optionally one location) with each domain's latest position and change. */
export function readTrackedPositions(db: Database.Database, opts: { locationCode?: number; domain?: string } = {}): TrackedKeywordView[] {
  const kws = listTrackedKeywords(db, opts.locationCode);
  const checks = db.prepare(`SELECT checked_at, serp_depth, unattributed, from_web FROM keyword_check WHERE keyword = ? AND location_code = ? ORDER BY checked_at DESC LIMIT 1`);
  const pos = db.prepare(`SELECT checked_at, position, url, shown_as, serp_depth FROM keyword_position WHERE keyword = ? AND location_code = ? AND domain = ? ORDER BY checked_at DESC LIMIT 2`);
  // Only the domains measured in the keyword's LATEST check: a domain dropped from the portfolio keeps
  // its old rows, which must not show under a newer "last checked" date.
  const doms = db.prepare(`SELECT DISTINCT domain FROM keyword_position WHERE keyword = ? AND location_code = ? AND checked_at = ? ORDER BY domain`);
  return kws.map(k => {
    const c = checks.get(k.keyword, k.locationCode) as any;
    const domains = opts.domain ? [opts.domain] : c ? (doms.all(k.keyword, k.locationCode, c.checked_at) as { domain: string }[]).map(r => r.domain) : [];
    const positions: PositionCell[] = [];
    for (const d of domains) {
      const [cur, prev] = pos.all(k.keyword, k.locationCode, d) as any[];
      if (!cur) continue;
      const s = positionStatus({ position: cur.position, serpDepth: cur.serp_depth }, prev ? { position: prev.position, serpDepth: prev.serp_depth } : null);
      positions.push({
        domain: d, position: cur.position, serpDepth: cur.serp_depth, url: cur.url, shownAs: cur.shown_as, checkedAt: cur.checked_at,
        previous: prev?.position ?? null, previousCheckedAt: prev?.checked_at ?? null, change: s.change, status: s.status,
      });
    }
    return { ...k, lastCheckedAt: c?.checked_at ?? null, serpDepth: c?.serp_depth ?? null, unattributed: c?.unattributed ?? null, fromWeb: !!c?.from_web, positions };
  });
}

/** "#9", "not in top 100": a position never reads as 0 or as a number we didn't measure. */
export const positionLabel = (p: { position: number | null; serpDepth: number }): string =>
  p.position != null ? `#${p.position}` : `not in top ${p.serpDepth}`;

export function changeLabel(c: Pick<PositionCell, 'status' | 'change' | 'previous' | 'serpDepth'>): string {
  switch (c.status) {
    case 'first-check': return 'first check';
    case 'up': return `up ${c.change}`;
    case 'down': return `down ${Math.abs(c.change ?? 0)}`;
    case 'same': return 'no change';
    case 'entered': return `new in top ${c.serpDepth}`;
    case 'dropped-out': return `was #${c.previous}, now not in top ${c.serpDepth}`;
    case 'still-absent': return `still not in top ${c.serpDepth}`;
    case 'depth-changed': return 'not comparable (check depth changed)';
  }
}

// ── Quote and run ───────────────────────────────────────────────────────────────────────────────

export interface KeywordCheckSelection { keywords?: string[]; locationCode?: number }
export interface KeywordCheckQuote {
  keywords: number;
  depth: number;
  usdPerKeyword: number;
  usd: number;
  byLocation: { locationCode: number; label: string; keywords: number; domains: string[] }[];
  notTracked: string[];
  note: string;
}

function selectKeywords(store: PortfolioStore, sel: KeywordCheckSelection): { targets: TrackedKeyword[]; notTracked: string[] } {
  const all = listTrackedKeywords(store.db, sel.locationCode);
  if (!sel.keywords?.length) return { targets: all, notTracked: [] };
  const want = new Set(sel.keywords.map(normalizeKeyword));
  const targets = all.filter(k => want.has(k.keyword));
  const have = new Set(targets.map(t => t.keyword));
  return { targets, notTracked: [...want].filter(k => !have.has(k)) };
}

const domainsAt = (domains: PortfolioDomain[], loc: number): string[] => [...new Set(domains.filter(d => d.locationCode === loc).map(d => d.domain))].sort();

export function quoteKeywordCheck(store: PortfolioStore, sel: KeywordCheckSelection, depth = DEFAULT_TRACK_DEPTH): KeywordCheckQuote {
  store.syncOwned();
  const domains = store.list();
  const { targets, notTracked } = selectKeywords(store, sel);
  const locs = [...new Set(targets.map(t => t.locationCode))].sort((a, b) => a - b);
  const usdPerKeyword = serpCheckPrice(depth);
  return {
    keywords: targets.length, depth, usdPerKeyword, usd: Math.round(targets.length * usdPerKeyword * 10000) / 10000,
    byLocation: locs.map(l => ({ locationCode: l, label: LOCATION_LABEL[l] ?? `location ${l}`, keywords: targets.filter(t => t.locationCode === l).length, domains: domainsAt(domains, l) })),
    notTracked,
    note: `One live Google SERP per keyword (top ${depth} organic results, poisoned-page repair on) at about $${usdPerKeyword} each, observed 27 Nov 2026. A keyword checked in the last 24 hours is read from the cache at no cost.`,
  };
}

export interface KeywordCheckArgs extends KeywordCheckSelection {
  depth?: number;
  /** The job running this check, recorded on its portfolio_run row. */
  jobId?: string;
  trigger?: 'manual';
  /** Monthly portfolio cap in USD this run must respect (null = no cap). */
  budgetUsd?: number | null;
}
export interface KeywordCheckResult {
  runId: number;
  checked: number;
  failed: { keyword: string; locationCode: number; error: string }[];
  skippedBudget: string[];
  spent: number;
  cacheHits: number;
  quoted: number;
  note: string;
}

export async function runKeywordCheck(
  dataDir: string, dfs: DataForSeoClient, args: KeywordCheckArgs,
  update: (p: Record<string, unknown>) => void, signal: AbortSignal,
): Promise<KeywordCheckResult> {
  const depth = args.depth ?? DEFAULT_TRACK_DEPTH;
  const store = new PortfolioStore(dataDir);
  try {
    const quote = quoteKeywordCheck(store, args, depth);
    const domains = store.list();
    const { targets } = selectKeywords(store, args);
    const startedAt = new Date().toISOString();
    const prior = store.spentThisMonth(new Date(startedAt));
    const runId = Number(store.db.prepare(`INSERT INTO portfolio_run (started_at, tier, trigger, quoted_usd, status, job_id) VALUES (?, 'keywords', 'manual', ?, 'running', ?)`).run(startedAt, quote.usd, args.jobId ?? null).lastInsertRowid);
    let spent = 0, calls = 0, cacheHits = 0, checked = 0;
    const failed: KeywordCheckResult['failed'] = [];
    const skippedBudget: string[] = [];
    const r4 = (v: number) => Math.round(v * 10000) / 10000;
    const ledger = () => store.db.prepare('UPDATE portfolio_run SET spent_usd = ?, calls = ?, cache_hits = ? WHERE id = ?').run(r4(spent), calls, cacheHits, runId);
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      if (signal.aborted) break;
      if (args.budgetUsd != null && prior + spent + quote.usdPerKeyword > args.budgetUsd + 1e-9) { skippedBudget.push(t.keyword); continue; }
      update({ runId, keyword: t.keyword, done: i, total: targets.length, spentSoFar: r4(spent) });
      try {
        const r = await dfs.serpOrganic(t.keyword, t.locationCode, t.languageCode, depth, { resolvePoisonedResults: true, maxAgeDays: CHECK_MAX_AGE_DAYS });
        calls++; if (r.cached) cacheHits++; spent += r.cost || 0; ledger();
        writeCheck(store.db, t.keyword, t.locationCode, parseSerpPositions(r, domainsAt(domains, t.locationCode), depth), { cost: r.cost || 0, cached: r.cached });
        checked++;
      } catch (e) {
        const { status, error } = classifyDfsError(e);
        failed.push({ keyword: t.keyword, locationCode: t.locationCode, error: error.slice(0, 300) });
        // An API that is not enabled fails the same way every time: don't keep trying.
        if (status === 'not-enabled') { for (const rest of targets.slice(i + 1)) failed.push({ keyword: rest.keyword, locationCode: rest.locationCode, error: 'not tried: the SERP API is not enabled on this account' }); break; }
      }
    }
    ledger();
    const status = signal.aborted ? 'cancelled' : skippedBudget.length ? 'partial-budget' : failed.length ? (checked ? 'partial' : 'failed') : 'completed';
    const note = [
      `${checked} of ${targets.length} keyword${targets.length === 1 ? '' : 's'} checked at depth ${depth}, ${calls} SERP calls (${cacheHits} from cache), spent $${r4(spent)} (quoted $${quote.usd})`,
      failed.length ? `${failed.length} failed` : '',
      skippedBudget.length ? `${skippedBudget.length} skipped to stay within the $${args.budgetUsd} monthly budget` : '',
    ].filter(Boolean).join('; ');
    store.db.prepare(`UPDATE portfolio_run SET finished_at = ?, status = ?, note = ? WHERE id = ?`).run(new Date().toISOString(), status, note, runId);
    if (!signal.aborted && targets.length > 0 && checked === 0 && failed.length > 0) {
      throw new Error(`Keyword check failed: no keyword was checked. First error: ${failed[0].error}`);
    }
    return { runId, checked, failed, skippedBudget, spent: r4(spent), cacheHits, quoted: quote.usd, note };
  } finally { store.close(); }
}
