// Probe (0.16.1): the run_audit reply stays small on a big site. `top` is parsed objects capped at 10
// (topLimit up to 50), each check's title + fix appears once in `checks`, evidence arrays are cut to 3,
// and the whole reply (text + structuredContent) stays under ~24k characters (~6k tokens).
// Run: node scripts/probe-audit-size.mjs   (after npm run build:server). No network.
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { dbPathFor } from '../dist/core/paths.js';
import { urlKey, hostFormForProperty } from '../dist/core/url-key.js';
import { runAudit, compactEvidence, TOP_DEFAULT, TOP_MAX } from '../dist/audit/engine.js';
import { buildAuditMarkdown } from '../dist/audit/report.js';
import { IMAGE_ACCEPT } from '../dist/core/Crawler.js';

process.env.SAC_AUTOSERVE = '0';
let pass = 0, fail = 0;
const check = (name, cond, detail = '') => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name} :: ${detail}`); } };
const SITE = 'sc-domain:big.test';
const W = 'https://www.big.test';
const K = (p) => urlKey(`${W}${p}`, { hostForm: hostFormForProperty(SITE) });
const REPLY_MAX_CHARS = 24_000;

// ── compactEvidence ──
{
  const ev = { samplePages: Array.from({ length: 10 }, (_, i) => `/p${i}`), note: 'x'.repeat(500), pos: 3.14159, nested: { list: [1, 2, 3, 4, 5], deeper: { deepest: { v: 1 } } }, n: 7 };
  const c = compactEvidence(ev);
  check('compactEvidence: arrays capped at 3 with <key>Total', c.samplePages.length === 3 && c.samplePagesTotal === 10, JSON.stringify(c));
  check('compactEvidence: long strings cut at 200 chars', typeof c.note === 'string' && c.note.length === 200 && c.note.endsWith('…'), String(c.note?.length));
  check('compactEvidence: numbers rounded, ints kept', c.pos === 3.14 && c.n === 7, JSON.stringify(c));
  check('compactEvidence: nested objects trimmed too', c.nested.list.length === 3 && c.nested.listTotal === 5, JSON.stringify(c.nested));
  check('compactEvidence: non-objects give {}', JSON.stringify(compactEvidence(null)) === '{}' && JSON.stringify(compactEvidence([1])) === '{}');
}

// ── A big fixture: 400 pages, each with on-page gaps and GSC traffic, plus 80 oversized images
//    loaded by every page (so each image finding carries a 10-page samplePages list). ──
const dir = mkdtempSync(path.join(tmpdir(), 'sac-size-'));
try {
  const D = new Date(Date.now() - 4 * 86400000).toISOString().slice(0, 10);
  const adb = new AuditDatabase(dbPathFor(dir, SITE));
  adb.upsertProperty(SITE, 'apex');
  const db = adb.db;
  db.prepare(`INSERT INTO crawl_metadata (crawl_id, base_url, base_domain, status, started_at, finished_at) VALUES ('c1', ?, 'big.test', 'completed', '2026-09-01T00:00:00Z', '2026-09-01T01:00:00Z')`).run(`${W}/`);
  const pg = db.prepare(`INSERT INTO pages (crawl_id,url,url_key,status_code,content_type,is_internal,indexable,ipr,inlink_count,title,title_length,h1_count,a11y_links_no_name) VALUES ('c1',?,?,200,'text/html',1,1,1,1,?,?,0,4)`);
  const pr = db.prepare(`INSERT INTO page_resources (crawl_id,page_key,resource_url,type,party,position) VALUES ('c1',?,?,'img','first','body')`);
  const sa = db.prepare(`INSERT INTO search_analytics (date,query,page,page_key,device,country,clicks,impressions,ctr,position) VALUES (?,?,?,?,'','',?,?,0,?)`);
  const ia = db.prepare(`INSERT INTO image_assets (url,bytes,status,content_type,used_on,accept) VALUES (?,?,200,'image/jpeg',400,?)`);
  db.transaction(() => {
    for (let i = 0; i < 400; i++) {
      const p = `/article-${i}-${'long-slug-'.repeat(4)}`;
      const t = i % 3 === 0 ? null : 'T'.repeat(80); // missing titles + over-long titles
      pg.run(`${W}${p}`, K(p), t, t ? t.length : null);
      sa.run(D, `query ${i}`, `${W}${p}`, K(p), 50 + i, 2000 + i * 10, 6);
      for (let j = 0; j < 80; j++) pr.run(K(p), `${W}/img/hero-${j}.jpg`);
    }
    for (let j = 0; j < 80; j++) ia.run(`${W}/img/hero-${j}.jpg`, 400_000 + j, IMAGE_ACCEPT);
  })();
  adb.close();

  const reply = (r) => JSON.stringify({ content: [{ type: 'text', text: buildAuditMarkdown(r, SITE) }], structuredContent: r });
  const r = runAudit(dir, SITE, {});
  check('fixture is big (hundreds of findings)', r.total > 500, String(r.total));
  check(`top defaults to ${TOP_DEFAULT}`, r.top.length === TOP_DEFAULT, String(r.top.length));
  const t0 = r.top[0];
  check('top items are parsed objects (no JSON strings)', r.top.every(f => typeof f.evidence === 'object' && typeof f.effort === 'object' && typeof f.traffic === 'object' && typeof f.id === 'number'), JSON.stringify(t0));
  check('top carries no per-finding recommendation text', r.top.every(f => !('recommendation' in f)), Object.keys(t0).join(','));
  const ids = [...new Set(r.top.map(f => f.checkId))].sort();
  check('checks map: exactly the checks in top, each with title + fix', JSON.stringify(Object.keys(r.checks).sort()) === JSON.stringify(ids) && ids.every(id => r.checks[id].title && r.checks[id].fix), JSON.stringify(Object.keys(r.checks)));
  const arraysOk = r.top.every(f => Object.values(f.evidence).every(v => !Array.isArray(v) || v.length <= 3));
  check('evidence arrays in top are capped at 3', arraysOk, JSON.stringify(r.top.map(f => f.evidence)).slice(0, 300));
  const md = buildAuditMarkdown(r, SITE);
  const fixRepeats = ids.map(id => md.split(r.checks[id].fix).length - 1);
  check('markdown prints each check\'s fix once', fixRepeats.every(n => n === 1), JSON.stringify(fixRepeats));
  check('byCheck, bySeverity, byCategory kept', r.byCheck.length > 0 && Object.keys(r.bySeverity).length > 0 && Object.keys(r.byCategory).length > 0);
  const size = reply(r).length;
  check(`default reply under ${REPLY_MAX_CHARS} chars`, size < REPLY_MAX_CHARS, String(size));
  console.log(`      default reply: ${size} chars (~${Math.round(size / 4)} tokens), ${r.total} findings`);

  const r50 = runAudit(dir, SITE, { topLimit: 50 });
  check('topLimit 50 returns 50', r50.top.length === 50, String(r50.top.length));
  check('topLimit is clamped to TOP_MAX', runAudit(dir, SITE, { topLimit: 999 }).top.length === TOP_MAX);
  const pr50 = r50.top.map(f => f.priority);
  check('top is sorted by priority', pr50.every((p, i) => i === 0 || p <= pr50[i - 1]));

  // ── The health score counts pages past the per-check findings cap (review/12) ───────────────────
  // 1,200 pages share one title: duplicate-title (high) finds all 1,200 but stores 500. Counting only
  // stored findings made health 58 ("Fair"); every page carries a high issue, so it is 0.
  {
    const dirH = mkdtempSync(path.join(tmpdir(), 'sac-health-cap-'));
    const SITE_H = 'sc-domain:cap.test';
    try {
      const adb = new AuditDatabase(dbPathFor(dirH, SITE_H));
      adb.upsertProperty(SITE_H, 'apex');
      adb.db.prepare(`INSERT INTO crawl_metadata (crawl_id,base_url,base_domain,status,urls_crawled,started_at,finished_at) VALUES ('c1','https://cap.test','cap.test','completed',1200,'2026-10-01T00:00:00Z','2026-10-01T01:00:00Z')`).run();
      const ins = adb.db.prepare(`INSERT INTO pages (crawl_id,url,url_key,status_code,content_type,is_internal,indexable,title,title_length,meta_description,h1,h1_count,word_count,viewport,lang,ipr,inlink_count,click_depth) VALUES ('c1',?,?,200,'text/html',1,1,'Same title',10,'d','h',1,500,'w','en',10,3,1)`);
      adb.db.transaction(() => { for (let i = 0; i < 1200; i++) ins.run(`https://cap.test/p${i}`, `https://cap.test/p${i}`); })();
      adb.close();
      const res = runAudit(dirH, SITE_H, {});
      const t = res.truncatedChecks?.find(c => c.checkId === 'duplicate-title');
      check('duplicate-title is capped at 500 stored of 1,200 found', t?.stored === 500 && t?.totalFound === 1200, JSON.stringify(t));
      const a2 = new AuditDatabase(dbPathFor(dirH, SITE_H));
      const h = a2.db.prepare('SELECT health_score, health_error_pages, health_total_pages FROM audit_runs WHERE run_id = ?').get(res.runId);
      a2.close();
      check('health counts every page with a high issue, not just the stored 500 (0 / 1,200 error pages)', h.health_score === 0 && h.health_error_pages === 1200 && h.health_total_pages === 1200, JSON.stringify(h));
    } finally { rmSync(dirH, { recursive: true, force: true }); }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
