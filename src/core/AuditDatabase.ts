/**
 * AuditDatabase — one SQLite database per GSC property, colocating:
 *   - GSC history       (search_analytics)            ← from better-search-console
 *   - crawl snapshot     (crawl_metadata, pages, links, errors) ← from seo-crawler-mcp
 *   - audit results      (audit_runs, findings)        ← new
 *
 * The join spine is the normalised URL key (`page_key` / `url_key`), written by
 * url-key.ts on both the GSC and crawl write paths. See plan/architecture §2.
 *
 * Never console.log — MCP speaks JSON-RPC over stdio; use console.error for debug.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type FindingLabel = 'D' | 'N' | 'L' | 'G' | 'S';
export type Severity = 'crit' | 'high' | 'med' | 'low' | 'info';

export class AuditDatabase {
  readonly db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL'); // WAL + NORMAL: durable enough, far fewer fsyncs
    this.db.pragma('busy_timeout = 10000');  // wait for locks instead of throwing SQLITE_BUSY (concurrent access)
    this.db.pragma('foreign_keys = ON');
    this.initializeTables();
  }

  private initializeTables(): void {
    // ── Property + sync/crawl bookkeeping ──────────────────────────────────
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS property_meta (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        site_url TEXT UNIQUE NOT NULL,
        host_form TEXT,                 -- 'apex' | 'www' | 'asis' (for url-key)
        permission_level TEXT,
        dfs_location_code INTEGER,      -- DataForSEO location (e.g. 2036 AU, 2826 UK, 2840 US)
        dfs_location_name TEXT,         -- or a name, e.g. 'Australia'
        last_synced_at TEXT,
        last_crawl_id TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);

    // ── GSC history (from better-search-console) + page_key for the join ───
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS search_analytics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        query TEXT,
        page TEXT,
        page_key TEXT,                  -- normalised join key (urlKey(page))
        device TEXT,
        country TEXT,
        search_appearance TEXT,
        clicks INTEGER NOT NULL DEFAULT 0,
        impressions INTEGER NOT NULL DEFAULT 0,
        ctr REAL NOT NULL DEFAULT 0,
        position REAL NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sa_unique
        ON search_analytics(date, query, page, device, country);
      CREATE INDEX IF NOT EXISTS idx_sa_date        ON search_analytics(date);
      CREATE INDEX IF NOT EXISTS idx_sa_query       ON search_analytics(query);
      CREATE INDEX IF NOT EXISTS idx_sa_page_key    ON search_analytics(page_key);
      CREATE INDEX IF NOT EXISTS idx_sa_date_pagekey ON search_analytics(date, page_key, clicks, impressions, position);
      CREATE INDEX IF NOT EXISTS idx_sa_query_date  ON search_analytics(query, date);
      CREATE INDEX IF NOT EXISTS idx_sa_date_metrics ON search_analytics(date, clicks, impressions, ctr, position);
      -- Covering indexes for the windowed GROUP BYs in the merged checks (page_key / query+page_key),
      -- in group-key order so SQLite can aggregate without a full re-sort on big GSC tables.
      CREATE INDEX IF NOT EXISTS idx_sa_pk_date ON search_analytics(page_key, date, clicks, impressions, position);
      CREATE INDEX IF NOT EXISTS idx_sa_q_pk_date ON search_analytics(query, page_key, date, impressions, clicks, position);
    `);

    // ── Crawl snapshot (from seo-crawler-mcp), url_key added, redirects captured ─
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS crawl_metadata (
        crawl_id TEXT PRIMARY KEY,
        base_url TEXT NOT NULL,
        base_domain TEXT NOT NULL,
        status TEXT DEFAULT 'running',  -- running | completed | failed | interrupted | cancelled
        max_depth INTEGER,
        max_pages INTEGER,
        user_agent TEXT,
        rendered INTEGER DEFAULT 0,      -- 0 = HTTP only, 1 = render tier used
        urls_discovered INTEGER DEFAULT 0,
        urls_crawled INTEGER DEFAULT 0,
        urls_failed INTEGER DEFAULT 0,
        urls_skipped INTEGER DEFAULT 0,
        started_at TEXT,
        finished_at TEXT,
        duration_ms INTEGER,
        error TEXT
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        crawl_id TEXT NOT NULL,
        url TEXT NOT NULL,
        url_key TEXT NOT NULL,           -- urlKey(url) — the join key
        status_code INTEGER,
        content_type TEXT,
        content_encoding TEXT,           -- br/gzip (compression war-story W6)
        cache_control TEXT,
        last_modified TEXT,
        etag TEXT,
        vary TEXT,                       -- Vary:User-Agent war-story (#54)
        bytes INTEGER,                   -- transfer/decoded size (excessive-resource check)
        response_time_ms INTEGER,        -- TTFB proxy
        depth INTEGER,
        is_internal INTEGER,
        indexable INTEGER,               -- derived: 200 + HTML + not noindex + self-canonical
        indexable_reason TEXT,           -- why NOT indexable: http-404/http-500/noindex-meta/noindex-header/canonicalised/non-html/robots-disallowed/redirect
        noindex INTEGER,
        title TEXT,
        title_length INTEGER,
        meta_description TEXT,
        meta_description_length INTEGER,
        h1 TEXT,
        h1_count INTEGER,
        word_count INTEGER,
        lang TEXT,
        charset TEXT,
        canonical_url TEXT,
        canonical_key TEXT,              -- urlKey(canonical_url) for D5 canonical-conflict
        robots TEXT,
        x_robots_tag TEXT,
        viewport TEXT,
        json_ld TEXT,                    -- raw JSON-LD blocks (schema validation)
        og_tags TEXT,
        hreflang TEXT,
        redirects TEXT,                  -- captured 3xx chain (crawler bug fix)
        internal_links INTEGER,
        external_links INTEGER,
        image_count INTEGER DEFAULT 0,         -- <img> count (image-alt check)
        images_without_alt INTEGER DEFAULT 0,  -- <img> lacking non-empty alt
        images_missing_dimensions INTEGER DEFAULT 0, -- <img> lacking width&height (CLS)
        canonical_count INTEGER DEFAULT 0,     -- # rel=canonical tags (multiple-canonical)
        canonical_relative INTEGER DEFAULT 0,  -- canonical declared as a relative URL
        h2_count INTEGER DEFAULT 0,
        heading_skips INTEGER DEFAULT 0,       -- skipped heading levels (h1→h3)
        rel_next INTEGER DEFAULT 0,
        rel_prev INTEGER DEFAULT 0,
        rel_amphtml TEXT,                      -- declared AMP version URL
        mixed_content_count INTEGER DEFAULT 0, -- http subresources on https page
        twitter_tags TEXT,                     -- JSON of twitter:* meta
        has_microdata INTEGER DEFAULT 0,
        has_rdfa INTEGER DEFAULT 0,
        inlink_count INTEGER DEFAULT 0,  -- in-degree (computed post-crawl: orphans)
        ipr REAL DEFAULT 0,              -- internal PageRank 0–100 (computed post-crawl)
        click_depth INTEGER,             -- body-only shortest path from home (post-crawl; null=unreachable via body)
        rendered INTEGER DEFAULT 0,      -- did this row come from the render tier?
        render_diff TEXT,                -- raw-vs-rendered diff summary (JSON), if rendered
        security_headers TEXT,           -- {csp,hsts,xFrame,referrer,...} JSON
        crawled_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (crawl_id) REFERENCES crawl_metadata(crawl_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_pages_urlkey ON pages(url_key);
      CREATE INDEX IF NOT EXISTS idx_pages_status   ON pages(status_code);
      CREATE INDEX IF NOT EXISTS idx_pages_depth    ON pages(depth);
      CREATE INDEX IF NOT EXISTS idx_pages_indexable ON pages(indexable);
      CREATE INDEX IF NOT EXISTS idx_pages_ipr      ON pages(ipr DESC);
    `);

    // ── Change-detection (drift): one persistent snapshot per (crawl, URL) of the SEO-salient
    // fields. `pages` only ever holds the latest crawl (unique url_key), so cross-crawl diffing
    // needs its own history table. Written once per crawl at audit time (INSERT OR IGNORE). ──
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS page_snapshots (
        crawl_id TEXT NOT NULL,
        url_key TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        status_code INTEGER,
        indexable INTEGER,
        indexable_reason TEXT,
        title TEXT,
        meta_description TEXT,
        h1 TEXT,
        canonical_key TEXT,
        robots TEXT,
        x_robots_tag TEXT,
        word_count INTEGER,
        schema_types TEXT,               -- sorted distinct JSON-LD @types, comma-joined
        PRIMARY KEY (crawl_id, url_key)
      );
      CREATE INDEX IF NOT EXISTS idx_snap_urlkey ON page_snapshots(url_key);
      CREATE INDEX IF NOT EXISTS idx_snap_captured ON page_snapshots(captured_at);
    `);

    // Agent-readiness result (one row per origin) — populated by check_agent_readiness, read by
    // the dashboard. Live HTTP probe, not crawl-derived, so it persists separately.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_readiness (
        origin TEXT PRIMARY KEY,
        score INTEGER,
        level TEXT,
        checks TEXT,        -- JSON [{id,category,label,present,detail,fix}]
        by_category TEXT,   -- JSON [{category,passed,total}]
        checked_at TEXT
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        crawl_id TEXT NOT NULL,
        source_url TEXT NOT NULL,
        source_key TEXT NOT NULL,
        target_url TEXT NOT NULL,
        target_key TEXT NOT NULL,        -- join key both ends → fixes false orphans
        anchor_text TEXT,
        is_internal INTEGER,
        placement TEXT,                  -- navigation | footer | body
        rel TEXT,
        FOREIGN KEY (crawl_id) REFERENCES crawl_metadata(crawl_id)
      );
      CREATE INDEX IF NOT EXISTS idx_links_source  ON links(source_key);
      CREATE INDEX IF NOT EXISTS idx_links_target  ON links(target_key);
      CREATE INDEX IF NOT EXISTS idx_links_internal ON links(is_internal);
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS errors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        crawl_id TEXT NOT NULL,
        url TEXT NOT NULL,
        error_type TEXT,
        error_message TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (crawl_id) REFERENCES crawl_metadata(crawl_id)
      );
      CREATE INDEX IF NOT EXISTS idx_errors_type ON errors(error_type);
    `);

    // ── GSC URL Inspection (authoritative per-URL index status) ─────────────
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS url_inspection (
        url_key TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        verdict TEXT,
        coverage_state TEXT,
        indexing_state TEXT,
        robots_txt_state TEXT,
        page_fetch_state TEXT,
        last_crawl_time TEXT,
        google_canonical TEXT,           -- Google-selected canonical
        user_canonical TEXT,             -- declared canonical (mismatch = D5 finding)
        crawled_as TEXT,
        mobile_usability TEXT,
        rich_results TEXT,               -- JSON of detected rich-result types/issues
        inspected_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_inspection_coverage ON url_inspection(coverage_state);
    `);

    // ── DataForSEO rank history (over-time sequence, monthly) ───────────────
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rank_history (
        period TEXT PRIMARY KEY,         -- YYYY-MM
        pos_1_3 INTEGER DEFAULT 0,
        pos_4_10 INTEGER DEFAULT 0,
        pos_11_20 INTEGER DEFAULT 0,
        pos_21_100 INTEGER DEFAULT 0,
        etv REAL DEFAULT 0,              -- estimated organic traffic value
        keyword_count INTEGER DEFAULT 0, -- total ranking keywords (not 'count' — clashes with COUNT())
        source TEXT,
        fetched_at TEXT DEFAULT (datetime('now'))
      );
    `);

    // ── Audit results (new) ────────────────────────────────────────────────
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_runs (
        run_id TEXT PRIMARY KEY,
        crawl_id TEXT,
        scope TEXT,                      -- core | full
        gsc_window_start TEXT,
        gsc_window_end TEXT,
        integrity_ok INTEGER,            -- crawl-integrity gates passed?
        started_at TEXT,
        finished_at TEXT,
        finding_count INTEGER DEFAULT 0
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS findings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        check_id TEXT NOT NULL,
        category TEXT,                   -- integrity|crawlability|indexation|onpage|schema|performance|war-stories|agentic|merged
        severity TEXT,                   -- crit|high|med|low|info
        labels TEXT,                     -- JSON array of D|N|L|G|S
        certainty REAL,                  -- 1.0 deterministic, 0.5 judgement
        url_key TEXT,                    -- affected page (null = site-wide)
        evidence TEXT,                   -- JSON proof payload
        traffic_at_risk TEXT,            -- JSON {clicks,impressions,position,searchVolume}
        effort TEXT,                     -- JSON {base,scaleModifier,fixType}
        priority REAL,                   -- P = (S × C × V) / E
        recommendation TEXT,             -- JSON {text, generated?}
        FOREIGN KEY (run_id) REFERENCES audit_runs(run_id)
      );
      CREATE INDEX IF NOT EXISTS idx_findings_run      ON findings(run_id);
      CREATE INDEX IF NOT EXISTS idx_findings_priority ON findings(priority DESC);
      CREATE INDEX IF NOT EXISTS idx_findings_check    ON findings(check_id);
    `);

    // ── Backlinks (DataForSEO, on-demand) — page-level counts + live HTTP status ──
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS page_backlinks (
        url_key TEXT PRIMARY KEY,          -- normalised join key (urlKey of the page)
        url TEXT NOT NULL,                 -- the page address DataForSEO reported
        backlinks INTEGER DEFAULT 0,
        referring_domains INTEGER DEFAULT 0,
        dofollow INTEGER DEFAULT 0,        -- dofollow backlink count
        status_code INTEGER,              -- live HTTP status of the backlinked page (null = unchecked)
        fetched_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_pbl_backlinks ON page_backlinks(backlinks DESC);
    `);

    // ── Sitemap URLs (for crawl↔sitemap reconciliation) ────────────────────
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sitemap_urls (
        url_key TEXT PRIMARY KEY,        -- normalised join key of a URL listed in the XML sitemap(s)
        url TEXT NOT NULL,
        fetched_at TEXT DEFAULT (datetime('now'))
      );
    `);

    // ── DataForSEO on-demand enrichments persisted for the audit (6a) ────────
    // Keyword intent (Labs search_intent) → powers intent-vs-pagetype-mismatch.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS keyword_intent (
        keyword TEXT PRIMARY KEY,
        intent TEXT,                    -- informational | navigational | commercial | transactional
        probability REAL,
        fetched_at TEXT DEFAULT (datetime('now'))
      );
    `);
    // Per-URL lab Core Web Vitals (On-Page Lighthouse) → powers high-yield-cwv-fail.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS page_cwv (
        url_key TEXT PRIMARY KEY,        -- urlKey of the audited URL (join spine)
        url TEXT NOT NULL,
        for_mobile INTEGER DEFAULT 1,
        performance REAL,                -- Lighthouse performance score 0–1
        lcp_ms REAL,                     -- largest-contentful-paint numericValue (ms)
        cls REAL,                        -- cumulative-layout-shift numericValue
        tbt_ms REAL,                     -- total-blocking-time numericValue (ms)
        fetched_at TEXT DEFAULT (datetime('now'))
      );
    `);

    // ── Wikidata entity layer (6d) — heuristic H1→QID resolution + relationship edges ──
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS page_entity (
        url_key TEXT PRIMARY KEY,        -- page resolved to a Wikidata entity
        qid TEXT NOT NULL,               -- Wikidata QID (e.g. Q42)
        label TEXT,
        description TEXT,
        source TEXT,                     -- 'h1' | 'title' | 'declared' (how we resolved)
        fetched_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_page_entity_qid ON page_entity(qid);
      CREATE TABLE IF NOT EXISTS entity_edge (
        qid TEXT NOT NULL,               -- child / part entity
        related_qid TEXT NOT NULL,       -- parent / whole entity (P279 subclass-of / P361 part-of target)
        relation TEXT NOT NULL,          -- 'subclass_of' | 'part_of'
        PRIMARY KEY (qid, related_qid, relation)
      );
      CREATE INDEX IF NOT EXISTS idx_entity_edge_related ON entity_edge(related_qid);
    `);

    this.migrate();
  }

  /** Idempotent column additions for DBs created before a column existed. */
  private migrate(): void {
    const cols = (table: string): Set<string> =>
      new Set((this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name));
    const ensure = (table: string, col: string, ddl: string): void => {
      if (!cols(table).has(col)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    };
    ensure('pages', 'image_count', 'image_count INTEGER DEFAULT 0');
    ensure('pages', 'images_without_alt', 'images_without_alt INTEGER DEFAULT 0');
    ensure('pages', 'images_missing_dimensions', 'images_missing_dimensions INTEGER DEFAULT 0');
    ensure('pages', 'canonical_count', 'canonical_count INTEGER DEFAULT 0');
    ensure('pages', 'canonical_relative', 'canonical_relative INTEGER DEFAULT 0');
    ensure('pages', 'h2_count', 'h2_count INTEGER DEFAULT 0');
    ensure('pages', 'heading_skips', 'heading_skips INTEGER DEFAULT 0');
    ensure('pages', 'rel_next', 'rel_next INTEGER DEFAULT 0');
    ensure('pages', 'rel_prev', 'rel_prev INTEGER DEFAULT 0');
    ensure('pages', 'rel_amphtml', 'rel_amphtml TEXT');
    ensure('pages', 'mixed_content_count', 'mixed_content_count INTEGER DEFAULT 0');
    ensure('pages', 'twitter_tags', 'twitter_tags TEXT');
    ensure('pages', 'has_microdata', 'has_microdata INTEGER DEFAULT 0');
    ensure('pages', 'has_rdfa', 'has_rdfa INTEGER DEFAULT 0');
    ensure('pages', 'click_depth', 'click_depth INTEGER');
    ensure('pages', 'indexable_reason', 'indexable_reason TEXT');
    // property-level backlink profile summary (from DataForSEO backlinks/summary)
    ensure('property_meta', 'total_backlinks', 'total_backlinks INTEGER');
    ensure('property_meta', 'referring_domains', 'referring_domains INTEGER');
    ensure('property_meta', 'backlinks_spam_score', 'backlinks_spam_score REAL');
    ensure('property_meta', 'backlinks_fetched_at', 'backlinks_fetched_at TEXT');
  }

  // ── Minimal property accessors (full CRUD added as modules are wired) ─────
  upsertProperty(siteUrl: string, hostForm: string, permissionLevel?: string): void {
    this.db
      .prepare(
        `INSERT INTO property_meta (site_url, host_form, permission_level)
         VALUES (?, ?, ?)
         ON CONFLICT(site_url) DO UPDATE SET host_form = excluded.host_form,
           permission_level = COALESCE(excluded.permission_level, property_meta.permission_level)`,
      )
      .run(siteUrl, hostForm, permissionLevel ?? null);
  }

  getProperty(siteUrl: string): { site_url: string; host_form: string; last_synced_at: string | null } | undefined {
    return this.db.prepare('SELECT site_url, host_form, last_synced_at FROM property_meta WHERE site_url = ?').get(siteUrl) as
      | { site_url: string; host_form: string; last_synced_at: string | null }
      | undefined;
  }

  /** Persist the DataForSEO target location for a property (string name or numeric code). */
  setDfsLocation(siteUrl: string, location: string | number): void {
    this.db
      .prepare('UPDATE property_meta SET dfs_location_code = ?, dfs_location_name = ? WHERE site_url = ?')
      .run(typeof location === 'number' ? location : null, typeof location === 'string' ? location : null, siteUrl);
  }

  /** Resolved DataForSEO location for a property: a code, a name, or undefined. */
  getDfsLocation(siteUrl: string): string | number | undefined {
    const r = this.db.prepare('SELECT dfs_location_code c, dfs_location_name n FROM property_meta WHERE site_url = ?').get(siteUrl) as
      | { c: number | null; n: string | null }
      | undefined;
    return r?.c ?? r?.n ?? undefined;
  }

  close(): void {
    this.db.close();
  }
}
