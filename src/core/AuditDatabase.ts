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
        indexable INTEGER,               -- derived: 200 + not noindex + self-canonical
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
        inlink_count INTEGER DEFAULT 0,  -- in-degree (computed post-crawl: orphans)
        ipr REAL DEFAULT 0,              -- internal PageRank (computed post-crawl)
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

  close(): void {
    this.db.close();
  }
}
