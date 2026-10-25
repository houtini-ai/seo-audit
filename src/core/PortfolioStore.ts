import Database from 'better-sqlite3';
import path from 'node:path';
import { AuditDatabase } from './AuditDatabase.js';
import { listLocalProperties } from './webServer.js';
import { isValidDomain, normaliseDomain, targetForProperty } from './portfolioTarget.js';

/**
 * The portfolio database: `_portfolio.db` in the data dir, beside
 * `_jobs.db`. Cross-property by nature (watched domains have no property), so it is NOT a property
 * DB: no `property_meta` table (property enumeration needs one), and the leading underscore keeps it
 * clear of any property stem. Every domain-scoped table is keyed on (domain, location_code): DataForSEO
 * estimates are per country, and one domain can be watched in two.
 */
export const PORTFOLIO_DB_NAME = '_portfolio.db';
export const PORTFOLIO_JOB_SCOPE = PORTFOLIO_DB_NAME;
export const portfolioDbPath = (dataDir: string): string => path.join(dataDir, PORTFOLIO_DB_NAME);
export const MAX_WATCHED = 50;
export const DEFAULT_LOCATION_CODE = 2840; // United States (US-first default)

/** DataForSEO location codes for the countries people actually set. A property may store its location
 * as a NAME ("Australia"); the portfolio needs the code, because it keys on it. */
export const LOCATION_CODES: Record<string, number> = {
  'united states': 2840, 'united kingdom': 2826, 'australia': 2036, 'canada': 2124, 'new zealand': 2554,
  'ireland': 2372, 'germany': 2276, 'france': 2250, 'spain': 2724, 'italy': 2380, 'netherlands': 2528,
  'belgium': 2056, 'sweden': 2752, 'norway': 2578, 'denmark': 2208, 'finland': 2246, 'poland': 2616,
  'portugal': 2620, 'switzerland': 2756, 'austria': 2040, 'india': 2356, 'singapore': 2702,
  'south africa': 2710, 'japan': 2392, 'brazil': 2076, 'mexico': 2484,
};
export const LOCATION_LABEL: Record<number, string> = Object.fromEntries(
  Object.entries(LOCATION_CODES).map(([n, c]) => [c, n.replace(/\b\w/g, ch => ch.toUpperCase())]),
);
// ISO country code for flags / short labels.
export const LOCATION_ISO: Record<number, string> = {
  2840: 'US', 2826: 'GB', 2036: 'AU', 2124: 'CA', 2554: 'NZ', 2372: 'IE', 2276: 'DE', 2250: 'FR', 2724: 'ES',
  2380: 'IT', 2528: 'NL', 2056: 'BE', 2752: 'SE', 2578: 'NO', 2208: 'DK', 2246: 'FI', 2616: 'PL', 2620: 'PT',
  2756: 'CH', 2040: 'AT', 2356: 'IN', 2702: 'SG', 2710: 'ZA', 2392: 'JP', 2076: 'BR', 2484: 'MX',
};

/** A stored location (code or name) → a code; unknown names fall back to the US default, flagged. */
export function resolveLocation(loc: string | number | undefined | null): { code: number; note?: string } {
  if (typeof loc === 'number' && Number.isFinite(loc)) return { code: loc };
  if (typeof loc === 'string' && loc.trim()) {
    if (/^\d+$/.test(loc.trim())) return { code: Number(loc.trim()) };
    const c = LOCATION_CODES[loc.trim().toLowerCase()];
    if (c) return { code: c };
    return { code: DEFAULT_LOCATION_CODE, note: `location "${loc}" is not in the portfolio's country list; set a DataForSEO location code with the portfolio tool` };
  }
  return { code: DEFAULT_LOCATION_CODE };
}

/** A country-code TLD → its DataForSEO location, used only when a property has no saved location:
 * an unset .com.au site estimated at the US default reads near zero (ehi: US 258 vs AU 5,170 visits). */
const TLD_LOCATIONS: [RegExp, number][] = [
  [/.(com.)?au$/, 2036], [/.(co.)?nz$/, 2554], [/.(co.)?uk$/, 2826], [/.ie$/, 2372], [/.ca$/, 2124],
  [/.de$/, 2276], [/.fr$/, 2250], [/.es$/, 2724], [/.it$/, 2380], [/.nl$/, 2528], [/.be$/, 2056], [/.se$/, 2752],
  [/.no$/, 2578], [/.dk$/, 2208], [/.fi$/, 2246], [/.pl$/, 2616], [/.pt$/, 2620], [/.ch$/, 2756], [/.at$/, 2040],
  [/.(co.)?in$/, 2356], [/.sg$/, 2702], [/.(co.)?za$/, 2710], [/.(co.)?jp$/, 2392], [/.(com.)?br$/, 2076], [/.(com.)?mx$/, 2484],
];
export function locationFromTld(domain: string): number | null {
  for (const [re, code] of TLD_LOCATIONS) if (re.test(domain)) return code;
  return null;
}

export interface PortfolioDomain {
  domain: string;
  locationCode: number;
  kind: 'owned' | 'watched';
  languageCode: string;
  groupLabel: string | null;
  siteUrls: string[];          // owned: every property that maps to this domain (sc-domain + URL-prefix + www)
  addedAt: string;
  locationNote?: string;
}

export type PortfolioTier = 'weekly' | 'monthly';
export type FetchStatus = 'ok' | 'empty' | 'not-enabled' | 'error' | 'skipped-budget';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS portfolio_domain (
  domain TEXT NOT NULL, location_code INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('owned','watched')),
  language_code TEXT NOT NULL DEFAULT 'en', group_label TEXT,
  added_at TEXT NOT NULL DEFAULT (datetime('now')), removed_at TEXT,
  PRIMARY KEY (domain, location_code));
CREATE TABLE IF NOT EXISTS portfolio_domain_property (
  site_url TEXT PRIMARY KEY, domain TEXT NOT NULL, location_code INTEGER NOT NULL);
-- Monthly history. source: 'labs' (historical_rank_overview), 'backlinks' (backlinks/history),
-- 'llm' (llm_mentions/historical; one row per platform via the platform column).
CREATE TABLE IF NOT EXISTS domain_month (
  domain TEXT NOT NULL, location_code INTEGER NOT NULL, month TEXT NOT NULL,
  source TEXT NOT NULL, platform TEXT NOT NULL DEFAULT '',
  organic_count REAL, organic_etv REAL, paid_count REAL, paid_etv REAL,
  pos_1_3 REAL, pos_4_10 REAL, pos_11_20 REAL, pos_21_50 REAL, pos_51_100 REAL,
  rank REAL, referring_main_domains REAL, referring_domains REAL, backlinks REAL,
  new_referring_main_domains REAL, lost_referring_main_domains REAL,
  mentions REAL, ai_search_volume REAL,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (domain, location_code, month, source, platform));
-- Weekly bulk tier. Its own history accrues: the Domain Rank and SERP-mix trends come from here,
-- because DataForSEO keeps no history for those.
CREATE TABLE IF NOT EXISTS domain_snapshot (
  domain TEXT NOT NULL, location_code INTEGER NOT NULL, captured_at TEXT NOT NULL,
  organic_count REAL, organic_etv REAL, paid_count REAL, paid_etv REAL,
  rank REAL, referring_main_domains REAL, referring_domains REAL, backlinks REAL,
  new_referring_main_domains_30d REAL, lost_referring_main_domains_30d REAL,
  serp_organic REAL, serp_paid REAL, serp_aio_ref REAL, serp_featured REAL, serp_local REAL,
  llm_mentions_aio REAL, llm_volume_aio REAL, llm_mentions_chatgpt REAL, llm_volume_chatgpt REAL,
  PRIMARY KEY (domain, location_code, captured_at));
CREATE TABLE IF NOT EXISTS domain_country (
  domain TEXT NOT NULL, location_code INTEGER NOT NULL, captured_at TEXT NOT NULL,
  country_code INTEGER NOT NULL, etv REAL, count REAL,
  PRIMARY KEY (domain, location_code, captured_at, country_code));
CREATE TABLE IF NOT EXISTS domain_top_page (
  domain TEXT NOT NULL, location_code INTEGER NOT NULL, captured_at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('traffic','links','cited')), platform TEXT NOT NULL DEFAULT '',
  rank_order INTEGER NOT NULL, url TEXT NOT NULL, metrics_json TEXT NOT NULL,
  PRIMARY KEY (domain, location_code, captured_at, kind, platform, rank_order));
CREATE TABLE IF NOT EXISTS domain_cited_source (
  domain TEXT NOT NULL, location_code INTEGER NOT NULL, captured_at TEXT NOT NULL, platform TEXT NOT NULL,
  source_domain TEXT NOT NULL, mentions REAL, ai_search_volume REAL,
  PRIMARY KEY (domain, location_code, captured_at, platform, source_domain));
CREATE TABLE IF NOT EXISTS portfolio_fetch (
  domain TEXT NOT NULL, location_code INTEGER NOT NULL, endpoint TEXT NOT NULL,
  fetched_at TEXT NOT NULL, status TEXT NOT NULL, error TEXT,
  PRIMARY KEY (domain, location_code, endpoint));
CREATE TABLE IF NOT EXISTS portfolio_schedule (
  id INTEGER PRIMARY KEY CHECK (id = 1), enabled INTEGER NOT NULL DEFAULT 0,
  weekly_dow INTEGER NOT NULL DEFAULT 1, monthly_dom INTEGER NOT NULL DEFAULT 3,
  budget_usd_month REAL NOT NULL DEFAULT 0,
  consent_domains INTEGER, consent_quote_weekly REAL, consent_quote_monthly REAL, consented_at TEXT,
  next_weekly_due TEXT, next_monthly_due TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS portfolio_run (
  id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT NOT NULL, finished_at TEXT,
  tier TEXT NOT NULL, trigger TEXT NOT NULL CHECK (trigger IN ('manual','schedule')),
  quoted_usd REAL, spent_usd REAL NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0,
  cache_hits INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, note TEXT, job_id TEXT);
CREATE INDEX IF NOT EXISTS idx_portfolio_run_started ON portfolio_run(started_at);
`;

export class PortfolioStore {
  readonly db: Database.Database;
  constructor(readonly dataDir: string, opts: { readonly?: boolean } = {}) {
    this.db = new Database(portfolioDbPath(dataDir), opts.readonly ? { readonly: true, fileMustExist: true } : {});
    if (!opts.readonly) {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('busy_timeout = 5000');
      this.db.exec(SCHEMA);
    }
  }

  /** Open read-only when the file exists, else null (a portfolio never set up has nothing to read). */
  static openReadonly(dataDir: string): PortfolioStore | null {
    try { return new PortfolioStore(dataDir, { readonly: true }); } catch { return null; }
  }

  close(): void { this.db.close(); }

  /**
   * Owned rows come from the local property DBs, re-derived on every call: a property added or
   * removed since the last read is reflected without a migration. Several properties can map to one
   * (domain, location): sc-domain:x.com and https://www.x.com/ are both x.com.
   */
  syncOwned(): void {
    const props = listLocalProperties(this.dataDir);
    const seen = new Set<string>();
    const upDomain = this.db.prepare(
      `INSERT INTO portfolio_domain (domain, location_code, kind) VALUES (?, ?, 'owned')
       ON CONFLICT(domain, location_code) DO UPDATE SET kind='owned', removed_at=NULL`);
    const upProp = this.db.prepare(
      `INSERT INTO portfolio_domain_property (site_url, domain, location_code) VALUES (?, ?, ?)
       ON CONFLICT(site_url) DO UPDATE SET domain=excluded.domain, location_code=excluded.location_code`);
    const tx = this.db.transaction(() => {
      for (const p of props) {
        const domain = targetForProperty(p.siteUrl);
        if (!isValidDomain(domain)) continue;
        let loc: string | number | undefined;
        try { const a = new AuditDatabase(path.join(this.dataDir, p.file)); try { loc = a.getDfsLocation(p.siteUrl); } finally { a.close(); } } catch { /* unreadable */ }
        // A saved location wins; else the country-code TLD; else the US default.
        const { code } = loc != null && loc !== '' ? resolveLocation(loc) : { code: locationFromTld(domain) ?? DEFAULT_LOCATION_CODE };
        upDomain.run(domain, code);
        upProp.run(p.siteUrl, domain, code);
        seen.add(p.siteUrl);
      }
      // Properties whose DB is gone: drop the link; an owned domain with no property left is retired.
      for (const r of this.db.prepare('SELECT site_url FROM portfolio_domain_property').all() as { site_url: string }[]) {
        if (!seen.has(r.site_url)) this.db.prepare('DELETE FROM portfolio_domain_property WHERE site_url = ?').run(r.site_url);
      }
      this.db.exec(`UPDATE portfolio_domain SET removed_at = datetime('now')
        WHERE kind='owned' AND removed_at IS NULL AND NOT EXISTS (
          SELECT 1 FROM portfolio_domain_property p WHERE p.domain = portfolio_domain.domain AND p.location_code = portfolio_domain.location_code)`);
    });
    tx();
  }

  list(): PortfolioDomain[] {
    const rows = this.db.prepare(
      `SELECT d.domain, d.location_code, d.kind, d.language_code, d.group_label, d.added_at,
              (SELECT json_group_array(p.site_url) FROM portfolio_domain_property p
                 WHERE p.domain = d.domain AND p.location_code = d.location_code) AS sites
       FROM portfolio_domain d WHERE d.removed_at IS NULL
       ORDER BY d.kind DESC, d.domain`).all() as any[];
    return rows.map(r => ({
      domain: r.domain, locationCode: r.location_code, kind: r.kind, languageCode: r.language_code,
      groupLabel: r.group_label, siteUrls: JSON.parse(r.sites || '[]'), addedAt: r.added_at,
    }));
  }

  /** Add a watched domain. Owned domains are never added here (they come from the property DBs). */
  addWatched(input: string, opts: { locationCode?: number; group?: string | null; languageCode?: string } = {}): PortfolioDomain {
    const domain = normaliseDomain(input);
    if (!isValidDomain(domain)) throw new Error(`"${input}" is not a domain name (expected something like example.com).`);
    const locationCode = opts.locationCode ?? DEFAULT_LOCATION_CODE;
    const existing = this.db.prepare('SELECT kind, removed_at FROM portfolio_domain WHERE domain = ? AND location_code = ?').get(domain, locationCode) as { kind: string; removed_at: string | null } | undefined;
    if (existing?.kind === 'owned' && !existing.removed_at) throw new Error(`${domain} is already in the portfolio as an owned property.`);
    const watched = (this.db.prepare(`SELECT COUNT(*) n FROM portfolio_domain WHERE kind='watched' AND removed_at IS NULL`).get() as { n: number }).n;
    if (!existing || existing.removed_at) {
      if (watched >= MAX_WATCHED) throw new Error(`The portfolio already watches ${MAX_WATCHED} domains, the limit. Remove one first.`);
    }
    const group = opts.group?.trim() ? opts.group.trim().slice(0, 60) : null;
    this.db.prepare(
      `INSERT INTO portfolio_domain (domain, location_code, kind, language_code, group_label) VALUES (?, ?, 'watched', ?, ?)
       ON CONFLICT(domain, location_code) DO UPDATE SET removed_at=NULL, group_label=excluded.group_label, language_code=excluded.language_code`,
    ).run(domain, locationCode, opts.languageCode ?? 'en', group);
    return this.list().find(d => d.domain === domain && d.locationCode === locationCode)!;
  }

  /** Remove a watched domain (soft: its history stays for the record). Owned rows can't be removed here. */
  removeWatched(input: string, locationCode?: number): number {
    const domain = normaliseDomain(input);
    const r = this.db.prepare(
      `UPDATE portfolio_domain SET removed_at = datetime('now')
       WHERE domain = ? AND kind = 'watched' AND removed_at IS NULL ${locationCode != null ? 'AND location_code = ?' : ''}`,
    ).run(...(locationCode != null ? [domain, locationCode] : [domain]));
    return r.changes;
  }

  setGroup(input: string, group: string | null, locationCode?: number): number {
    const domain = normaliseDomain(input);
    const g = group?.trim() ? group.trim().slice(0, 60) : null;
    return this.db.prepare(
      `UPDATE portfolio_domain SET group_label = ? WHERE domain = ? AND removed_at IS NULL ${locationCode != null ? 'AND location_code = ?' : ''}`,
    ).run(...(locationCode != null ? [g, domain, locationCode] : [g, domain])).changes;
  }

  recordFetch(domain: string, locationCode: number, endpoint: string, status: FetchStatus, error?: string): void {
    this.db.prepare(
      `INSERT INTO portfolio_fetch (domain, location_code, endpoint, fetched_at, status, error) VALUES (?, ?, ?, datetime('now'), ?, ?)
       ON CONFLICT(domain, location_code, endpoint) DO UPDATE SET fetched_at=excluded.fetched_at, status=excluded.status, error=excluded.error`,
    ).run(domain, locationCode, endpoint, status, error ?? null);
  }

  fetchState(): Map<string, { status: FetchStatus; error: string | null; fetchedAt: string }> {
    const m = new Map<string, { status: FetchStatus; error: string | null; fetchedAt: string }>();
    for (const r of this.db.prepare('SELECT domain, location_code, endpoint, status, error, fetched_at FROM portfolio_fetch').all() as any[]) {
      m.set(`${r.domain}|${r.location_code}|${r.endpoint}`, { status: r.status, error: r.error, fetchedAt: r.fetched_at });
    }
    return m;
  }

  /** Portfolio spend this calendar month (UTC), from the ledger: what the budget cap is checked against. */
  spentThisMonth(now: Date = new Date()): number {
    const month = now.toISOString().slice(0, 7);
    return (this.db.prepare(`SELECT COALESCE(SUM(spent_usd), 0) s FROM portfolio_run WHERE substr(started_at, 1, 7) = ?`).get(month) as { s: number }).s;
  }
}
