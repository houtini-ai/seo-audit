// Pinpoint the slow dashboard queries on the large property (simracing, 1.84M rows).
import Database from 'better-sqlite3';
import { homedir } from 'node:os';
import path from 'node:path';
import { dbPathFor } from '../dist/core/paths.js';

const dataDir = process.env.SAC_DATA_DIR ?? path.join(homedir(), 'Documents', 'seo-audit-console');
const db = new Database(dbPathFor(dataDir, 'sc-domain:simracingcockpit.gg'), { readonly: true });
const mx = db.prepare('SELECT MAX(date) d FROM search_analytics').get().d;
const UB = `date <= '${mx}'`;
const time = (label, sql, ...args) => { const t0 = Date.now(); const r = db.prepare(sql).all(...args); console.log(`${(Date.now() - t0 + 'ms').padStart(7)}  ${label} (${r.length} rows)`); };

time('rankTrend 90d', `SELECT date, SUM(clicks) c, AVG(position) p FROM search_analytics WHERE ${UB} AND date > date(?, '-90 days') GROUP BY date`, mx);
time('rankingDist 90d', `SELECT date, SUM(CASE WHEN position<=3 THEN impressions ELSE 0 END) b1 FROM search_analytics WHERE ${UB} AND date > date(?, '-90 days') GROUP BY date`, mx);
time('quickWins 28d groupby query', `SELECT query, SUM(impressions) i, SUM(clicks) c, SUM(position*impressions)*1.0/NULLIF(SUM(impressions),0) pos FROM search_analytics WHERE query IS NOT NULL AND ${UB} AND date > date(?, '-28 days') GROUP BY query HAVING SUM(impressions)>=50 AND pos<=20`, mx);
time('keywordMovement 90d + subqueries', `WITH q AS (SELECT query, MIN(date) fd, MAX(date) ld FROM search_analytics WHERE query IS NOT NULL AND ${UB} AND date > date(?, '-90 days') GROUP BY query HAVING SUM(impressions)>=50 AND MIN(date)<MAX(date)) SELECT q.query, (SELECT AVG(position) FROM search_analytics s WHERE s.query=q.query AND s.date=q.fd AND s.impressions>0) fp FROM q LIMIT 40`, mx);
time('cannTable pp 90d', `WITH pp AS (SELECT query, page_key, SUM(impressions) imp, SUM(clicks) clk, SUM(position*impressions)*1.0/NULLIF(SUM(impressions),0) pos FROM search_analytics WHERE query IS NOT NULL AND page_key IS NOT NULL AND ${UB} AND date > date(?, '-90 days') GROUP BY query, page_key HAVING pos<20 AND imp>=30), multi AS (SELECT query FROM pp GROUP BY query HAVING COUNT(*)>=2) SELECT pp.query, pp.page_key FROM pp JOIN multi ON multi.query=pp.query`, mx);
time('branded 28d CASE scan', `SELECT SUM(CASE WHEN (' '||LOWER(query)||' ') LIKE '% x %' THEN clicks ELSE 0 END) b, SUM(clicks) t FROM search_analytics WHERE query IS NOT NULL AND ${UB} AND date > date(?, '-28 days')`, mx);
time('pagePerf 28d groupby page', `SELECT page_key, SUM(clicks) c FROM search_analytics WHERE page_key IS NOT NULL AND ${UB} AND date > date(?, '-28 days') GROUP BY page_key ORDER BY c DESC LIMIT 40`, mx);
db.close();
