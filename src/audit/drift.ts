import type Database from 'better-sqlite3';
import { parseJsonLdNodes, nodeType } from './templates.js';

/**
 * Change-detection ("drift"): snapshot the SEO-salient fields of a crawl, then diff the two most
 * recent snapshots per URL. This is what turns the audit from a one-off into a monitor — it
 * answers "what changed on the site since last time, and does it matter?". Field-level (not body
 * hashing): the signals that move rankings are status, indexability, canonical, robots/noindex,
 * title/meta/H1 and schema presence — all of which we already capture.
 */

export type DriftSeverity = 'crit' | 'high' | 'med' | 'low' | 'info';
export interface FieldChange { field: string; from: unknown; to: unknown; severity: DriftSeverity }
export interface PageChange { urlKey: string; kind: 'modified' | 'added' | 'removed'; changes: FieldChange[] }
export interface DriftResult {
  baselineCrawl: string | null;
  currentCrawl: string | null;
  baselineAt: string | null;
  currentAt: string | null;
  changes: PageChange[];
  summary: Record<string, number>;
  /** Set when a completed crawl is newer than the newest snapshot — the diff below is NOT current. */
  staleness?: { newestCrawl: string; newestCrawlAt: string; snapshotAt: string | null; note: string };
}

const SNAP_COLS = 'crawl_id,url_key,captured_at,status_code,indexable,indexable_reason,title,meta_description,h1,canonical_key,robots,x_robots_tag,word_count,schema_types';

function schemaTypes(jsonLd: string | null): string {
  const set = new Set<string>();
  for (const n of parseJsonLdNodes(jsonLd)) { const t = nodeType(n); if (t) set.add(t); }
  return [...set].sort().join(',');
}

// captured_at arrives in two formats: ISO 'YYYY-MM-DDTHH:MM:SSZ' (crawl finished_at) and
// SQLite 'YYYY-MM-DD HH:MM:SS' (the killed-crawl fallback). Normalise to the SQLite form at
// WRITE time so plain ORDER BY works; readers keep a REPLACE() guard for legacy rows.
const normaliseAt = (at: string): string => at.replace('T', ' ').replace(/Z$/, '').slice(0, 19);

/** The two most recent crawls in page_snapshots (newest first), legacy-format-safe. */
export function latestTwoCrawls(db: Database.Database): { crawl_id: string; at: string }[] {
  return db.prepare(
    `SELECT crawl_id, MAX(REPLACE(REPLACE(captured_at, 'T', ' '), 'Z', '')) at FROM page_snapshots GROUP BY crawl_id ORDER BY at DESC LIMIT 2`,
  ).all() as { crawl_id: string; at: string }[];
}

/** Capture the current crawl's pages into page_snapshots. Idempotent per crawl_id. */
export function snapshotCrawl(db: Database.Database, crawlId: string, capturedAt: string): void {
  capturedAt = normaliseAt(capturedAt);
  const already = db.prepare('SELECT 1 FROM page_snapshots WHERE crawl_id=? LIMIT 1').get(crawlId);
  if (already) return;
  const pages = db.prepare(
    `SELECT url_key, status_code, indexable, indexable_reason, title, meta_description, h1, canonical_key, robots, x_robots_tag, word_count, json_ld
     FROM pages WHERE crawl_id=?`,
  ).all(crawlId) as any[];
  if (!pages.length) return;
  const ins = db.prepare(
    `INSERT OR IGNORE INTO page_snapshots (crawl_id,url_key,captured_at,status_code,indexable,indexable_reason,title,meta_description,h1,canonical_key,robots,x_robots_tag,word_count,schema_types)
     VALUES (@crawl_id,@url_key,@captured_at,@status_code,@indexable,@indexable_reason,@title,@meta_description,@h1,@canonical_key,@robots,@x_robots_tag,@word_count,@schema_types)`,
  );
  db.transaction(() => {
    for (const p of pages) ins.run({
      crawl_id: crawlId, captured_at: capturedAt, url_key: p.url_key, status_code: p.status_code,
      indexable: p.indexable, indexable_reason: p.indexable_reason, title: p.title, meta_description: p.meta_description,
      h1: p.h1, canonical_key: p.canonical_key, robots: p.robots, x_robots_tag: p.x_robots_tag,
      word_count: p.word_count, schema_types: schemaTypes(p.json_ld),
    });
  })();
}

const SEV_ICON: Record<DriftSeverity, string> = { crit: '🔴', high: '🟠', med: '🟡', low: '⚪', info: '🔵' };
const fmt = (v: unknown): string => { if (v === null || v === undefined || v === '') return '∅'; const s = String(v); return s.length > 70 ? s.slice(0, 67) + '…' : s; };

/** Render a drift result as a human-readable markdown report (for the detect_changes tool). */
export function buildDriftMarkdown(d: DriftResult, siteUrl: string, limit = 50): string {
  const stale = d.staleness ? `\n> ⚠️ **This diff is not current.** ${d.staleness.note}\n` : '';
  if (!d.baselineCrawl) {
    return `# Change detection — ${siteUrl}\n${stale}\nOnly one crawl snapshot exists so far. Change detection compares two crawls — run \`refresh_property\` again (e.g. tomorrow) then re-check.`;
  }
  const s = d.summary;
  const out: string[] = [
    `# Change detection — ${siteUrl}`,
    stale,
    `\nComparing **${d.baselineAt}** → **${d.currentAt}**`,
    `\n**${s.pagesChanged || 0}** URLs changed · ${s.modified || 0} modified · ${s.added || 0} added · ${s.removed || 0} removed · 🔴 ${s.crit || 0} critical · 🟠 ${s.high || 0} high\n`,
  ];
  if (!d.changes.length) { out.push('No changes detected since the last crawl. ✅'); return out.join('\n'); }
  for (const c of d.changes.slice(0, limit)) {
    if (c.kind === 'added') { out.push(`- 🟢 **new page** \`${c.urlKey}\``); continue; }
    if (c.kind === 'removed') { out.push(`- ⚫ **page gone** \`${c.urlKey}\` (no longer reached by the crawl)`); continue; }
    out.push(`- \`${c.urlKey}\``);
    for (const f of c.changes) out.push(`    - ${SEV_ICON[f.severity]} **${f.field}**: ${fmt(f.from)} → ${fmt(f.to)}`);
  }
  if (d.changes.length > limit) out.push(`\n…and ${d.changes.length - limit} more changed URLs.`);
  return out.join('\n');
}

/**
 * A completed crawl that never made it into page_snapshots means the diff below is stale — it
 * compares older crawls while a newer one sits unsnapshotted. Historically this happened whenever
 * a crawl wasn't followed by run_audit (the only place that used to snapshot); the crawler now
 * snapshots itself, so this covers legacy DBs and crawls killed before finalising.
 */
function stalenessOf(db: Database.Database, newestSnapAt: string | null): DriftResult['staleness'] {
  const r = db.prepare(
    `SELECT crawl_id, REPLACE(REPLACE(finished_at, 'T', ' '), 'Z', '') at FROM crawl_metadata
     WHERE status='completed' AND finished_at IS NOT NULL ORDER BY at DESC LIMIT 1`,
  ).get() as { crawl_id: string; at: string } | undefined;
  if (!r) return undefined;
  const snapped = db.prepare('SELECT 1 FROM page_snapshots WHERE crawl_id=? LIMIT 1').get(r.crawl_id);
  if (snapped) return undefined;
  return {
    newestCrawl: r.crawl_id, newestCrawlAt: r.at, snapshotAt: newestSnapAt,
    note: `Crawl ${r.crawl_id} (${r.at}) has no snapshot, so it is NOT in the diff below — these changes are older than your latest crawl. Run run_audit to snapshot it, then re-run detect_changes.`,
  };
}

/** Diff the two most recent snapshots in the DB. */
export function diffLatest(db: Database.Database): DriftResult {
  const crawls = latestTwoCrawls(db);
  if (crawls.length < 2) {
    return {
      baselineCrawl: null, currentCrawl: crawls[0]?.crawl_id ?? null, baselineAt: null,
      currentAt: crawls[0]?.at ?? null, changes: [], summary: {},
      staleness: stalenessOf(db, crawls[0]?.at ?? null),
    };
  }
  const [cur, base] = crawls;
  const load = (id: string): Map<string, any> => {
    const m = new Map<string, any>();
    for (const r of db.prepare(`SELECT ${SNAP_COLS} FROM page_snapshots WHERE crawl_id=?`).all(id) as any[]) m.set(r.url_key, r);
    return m;
  };
  const newer = load(cur.crawl_id), older = load(base.crawl_id);
  const changes: PageChange[] = [];

  for (const [k, n] of newer) {
    const o = older.get(k);
    if (!o) { changes.push({ urlKey: k, kind: 'added', changes: [] }); continue; }
    const fc: FieldChange[] = [];
    const push = (field: string, from: unknown, to: unknown, severity: DriftSeverity): void => { fc.push({ field, from, to, severity }); };

    if (n.status_code !== o.status_code) push('status_code', o.status_code, n.status_code, (o.status_code === 200 && n.status_code !== 200) ? 'crit' : 'high');
    if ((n.indexable ?? 0) !== (o.indexable ?? 0)) push('indexable', !!o.indexable, !!n.indexable, n.indexable ? 'info' : 'crit');
    if ((n.canonical_key || '') !== (o.canonical_key || '')) push('canonical', o.canonical_key, n.canonical_key, 'high');
    if ((n.robots || '') !== (o.robots || '')) push('robots', o.robots, n.robots, /noindex/i.test(n.robots || '') ? 'crit' : 'med');
    if ((n.x_robots_tag || '') !== (o.x_robots_tag || '')) push('x_robots_tag', o.x_robots_tag, n.x_robots_tag, /noindex/i.test(n.x_robots_tag || '') ? 'crit' : 'med');
    if ((n.title || '') !== (o.title || '')) push('title', o.title, n.title, 'med');
    if ((n.h1 || '') !== (o.h1 || '')) push('h1', o.h1, n.h1, 'low');
    if ((n.meta_description || '') !== (o.meta_description || '')) push('meta_description', o.meta_description, n.meta_description, 'low');
    if ((n.schema_types || '') !== (o.schema_types || '')) {
      const lost = (o.schema_types || '').split(',').filter((t: string) => t && !(n.schema_types || '').split(',').includes(t));
      push('schema_types', o.schema_types, n.schema_types, lost.length ? 'med' : 'info');
    }
    // word_count: only flag a big swing (>=40%) — small edits are noise
    if (o.word_count && n.word_count != null) {
      const delta = Math.abs(n.word_count - o.word_count) / o.word_count;
      if (delta >= 0.4) push('word_count', o.word_count, n.word_count, 'low');
    }
    if (fc.length) changes.push({ urlKey: k, kind: 'modified', changes: fc });
  }
  for (const k of older.keys()) if (!newer.has(k)) changes.push({ urlKey: k, kind: 'removed', changes: [] });

  // sort by worst severity per page, then by number of changes
  const rank: Record<DriftSeverity, number> = { crit: 0, high: 1, med: 2, low: 3, info: 4 };
  const worst = (c: PageChange): number => c.kind === 'removed' ? 1 : c.kind === 'added' ? 4 : Math.min(...c.changes.map(x => rank[x.severity]));
  changes.sort((a, b) => worst(a) - worst(b) || b.changes.length - a.changes.length);

  const summary: Record<string, number> = { pagesChanged: changes.length, added: 0, removed: 0, modified: 0, crit: 0, high: 0 };
  for (const c of changes) {
    summary[c.kind]++;
    if (c.kind === 'modified') { if (c.changes.some(x => x.severity === 'crit')) summary.crit++; if (c.changes.some(x => x.severity === 'high')) summary.high++; }
  }
  return {
    baselineCrawl: base.crawl_id, currentCrawl: cur.crawl_id, baselineAt: base.at, currentAt: cur.at,
    changes, summary, staleness: stalenessOf(db, cur.at),
  };
}
