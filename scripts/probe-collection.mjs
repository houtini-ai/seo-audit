// Data-collection regressions: jobs that used to report "completed" having done nothing, phases
// that took a whole refresh down, an optional tier that failed a paid tool, and a SERP call that
// paid for three pages to read one. No network: fakes, and the DataForSEO client's fetchImpl hook.
// Run: npm run build:server && node scripts/probe-collection.mjs
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DataForSeoClient } from '../dist/core/DataForSeoClient.js';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { dbPathFor } from '../dist/core/paths.js';
import { UrlInspector, INSPECT_MAX_CONSECUTIVE_REFUSALS } from '../dist/core/UrlInspector.js';
import { Refresh } from '../dist/core/Refresh.js';
import { LinkIntersect } from '../dist/core/LinkIntersect.js';
import { PortfolioStore } from '../dist/core/PortfolioStore.js';
import { runPortfolioRefresh } from '../dist/core/PortfolioRefresh.js';
import { listChecks } from '../dist/audit/engine.js';

let pass = 0, fail = 0;
const check = (name, cond, detail) => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name} :: ${detail}`); } };
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir = mkdtempSync(path.join(tmpdir(), 'sac-collection-'));
const noUpdate = () => {};
const live = () => new AbortController().signal;
const closers = [];
const dfsClient = (fetchImpl) => { const c = new DataForSeoClient('u', 'p', path.join(dir, `dfs-${closers.length}.db`), 20, { fetchImpl }); closers.push(c); return c; };
const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// ── URL Inspection: a refused run stops early and fails with the reason ────────────────────
console.log('inspect_urls');
{
  const siteUrl = 'https://inspect.test/';
  const db = new AuditDatabase(dbPathFor(dir, siteUrl));
  db.upsertProperty(siteUrl, 'asis');
  const ins = db.db.prepare(`INSERT INTO gsc_page_totals (date, page_key, page, clicks) VALUES ('2026-11-01', ?, ?, ?)`);
  for (let i = 0; i < 20; i++) ins.run(`inspect.test/p${i}`, `https://inspect.test/p${i}`, 20 - i);
  db.close();
  const quota = () => Object.assign(new Error('Quota exceeded for quota metric'), { response: { status: 429 } });

  let calls = 0;
  let err = null;
  try { await new UrlInspector({ inspectUrl: async () => { calls++; throw quota(); } }, dir).run(siteUrl, { delayMs: 0, limit: 20 }, noUpdate, live()); } catch (e) { err = e.message; }
  check('a spent quota stops the run after a few URLs, not all of them', calls === INSPECT_MAX_CONSECUTIVE_REFUSALS, `calls ${calls}`);
  check('nothing inspected is a FAILED job that names the reason', !!err && /Quota exceeded/.test(err) && /Nothing was inspected/.test(err), String(err));

  calls = 0; err = null;
  try { await new UrlInspector({ inspectUrl: async () => { calls++; throw new Error('socket hang up'); } }, dir).run(siteUrl, { delayMs: 0, limit: 5 }, noUpdate, live()); } catch (e) { err = e.message; }
  check('errors that are not quota/permission try every URL, then still fail the job', calls === 5 && !!err && /all 5 URL\(s\) failed/.test(err) && /socket hang up/.test(err), `calls ${calls}: ${err}`);

  calls = 0;
  const partial = await new UrlInspector({ inspectUrl: async () => { if (++calls <= 4) return { indexStatusResult: { verdict: 'PASS' } }; throw quota(); } }, dir).run(siteUrl, { delayMs: 0, limit: 20 }, noUpdate, live());
  check('a quota hit part-way keeps what was inspected and says it stopped', partial.inspected === 4 && partial.failed === INSPECT_MAX_CONSECUTIVE_REFUSALS && /consecutive quota/.test(partial.stopped ?? ''), JSON.stringify(partial));

  calls = 0;
  const mixed = await new UrlInspector({ inspectUrl: async () => { if (++calls % 2) throw quota(); return {}; } }, dir).run(siteUrl, { delayMs: 0, limit: 10 }, noUpdate, live());
  check('isolated refusals (never several in a row) do not stop the run', mixed.inspected === 5 && mixed.failed === 5 && !mixed.stopped, JSON.stringify(mixed));
}

// ── refresh_property: a failing ranks / inspect phase is reported, and the later phases run ─
console.log('refresh_property');
{
  const ran = [];
  const refresh = new Refresh(
    null,
    { run: async () => { ran.push('crawl'); return { crawled: 1 }; } },
    { run: async () => { ran.push('inspect'); throw new Error('URL Inspection failed: quota'); } },
    { run: async () => { ran.push('ranks'); throw new Error('DataForSEO 402 Payment Required'); } },
    { run: async () => { ran.push('crux'); return { ok: 1 }; } },
  );
  const out = await refresh.run('https://refresh.test/', {}, noUpdate, live());
  check('ranks failing does not fail the refresh: it is reported as ranksError', /402/.test(out.ranksError ?? '') && out.ranks === undefined, JSON.stringify(out));
  check('inspect failing is reported as inspectError', /quota/.test(out.inspectError ?? ''), JSON.stringify(out));
  check('CrUX still runs after the failed phases', ran.join(',') === 'crawl,inspect,ranks,crux' && out.crux?.ok === 1, ran.join(','));
  check('a phase without credentials is still reported as skipped', out.gscSkipped === 'no GSC credentials', JSON.stringify(out));
}

// ── link_intersect: Majestic failing falls back to the DataForSEO sort ──────────────────────
console.log('link_intersect');
{
  const entry = (target, rank) => ({ target, rank, backlinks: 5, referring_domains: 1, referring_pages: 3, referring_pages_nofollow: 0, backlinks_spam_score: 2 });
  const items = [['low.example.net', 100], ['high.example.net', 400]].map(([d, rank]) => ({ domain_intersection: { 1: entry(d, rank) }, summary: { intersections_count: 1 } }));
  const dfs = dfsClient(async () => jsonRes({ status_code: 20000, cost: 0.024, tasks: [{ status_code: 20000, result: [{ total_count: 2, items }] }] }));
  const siteUrl = 'https://links.test/';
  let err = null, res = null;
  try { res = await new LinkIntersect(dfs, dir).run(siteUrl, { competitors: ['rival.com'] }, { getIndexItemInfo: async () => { throw new Error('Majestic InsufficientIndexItemInfoUnits: out of units'); } }); } catch (e) { err = e.message; }
  check('a Majestic error does not fail the intersect', err === null && res?.prospects.length === 2, String(err));
  check('it reports majesticError and sorts by DataForSEO domain rank', /out of units/.test(res?.majesticError ?? '') && res?.sortedBy === 'domainTrust' && res?.majesticEnriched === 0 && res?.prospects[0].domain === 'high.example.net', JSON.stringify({ e: res?.majesticError, s: res?.sortedBy, first: res?.prospects[0]?.domain }));
  const a = new AuditDatabase(dbPathFor(dir, siteUrl));
  const stored = a.db.prepare('SELECT COUNT(*) n FROM link_prospects').get().n;
  a.close();
  check('the prospects are still persisted', stored === 2, `rows ${stored}`);
  const okRes = await new LinkIntersect(dfs, dir).run(siteUrl, { competitors: ['rival.com'] }, { getIndexItemInfo: async (ds) => ds.map((item, i) => ({ item, trustFlow: 10 + i, citationFlow: 5, topicalTrustFlow: [] })) });
  check('with Majestic answering there is no majesticError and Trust Flow sorts', okRes.majesticError === undefined && okRes.sortedBy === 'trustFlow' && okRes.majesticEnriched === 2, JSON.stringify({ e: okRes.majesticError, s: okRes.sortedBy }));
}

// ── refresh_portfolio: every family failing is a failed job ────────────────────────────────
console.log('refresh_portfolio');
{
  const pdir = mkdtempSync(path.join(tmpdir(), 'sac-collection-pf-'));
  const store = new PortfolioStore(pdir);
  store.addWatched('rival.com', { locationCode: 2840 });
  store.close();
  const denied = dfsClient(async () => jsonRes({ status_code: 40100, status_message: 'You are not authorized to access this resource.' }, 401));
  let err = null;
  try { await runPortfolioRefresh(pdir, denied, null, { tier: 'weekly', trigger: 'manual' }, noUpdate, live()); } catch (e) { err = e.message; }
  check('all families failing fails the job with the first error', !!err && /all 3 endpoint families failed/.test(err) && /not authorized/.test(err), String(err));
  const s2 = new PortfolioStore(pdir);
  const run = s2.db.prepare('SELECT status, finished_at FROM portfolio_run ORDER BY id DESC LIMIT 1').get();
  s2.close();
  check('the run row is still closed (not left "running")', run?.status === 'partial' && !!run.finished_at, JSON.stringify(run));

  // One family down (Backlinks not activated), the rest fine: the job completes and says so.
  const mixed = dfsClient(async (url) => String(url).includes('/v3/backlinks/')
    ? jsonRes({ status_code: 20000, tasks: [{ status_code: 40204, status_message: 'Access denied.' }] })
    : jsonRes({ status_code: 20000, cost: 0.01, tasks: [{ status_code: 20000, result: [{ items: [] }] }] }));
  let res = null; err = null;
  try { res = await runPortfolioRefresh(pdir, mixed, null, { tier: 'weekly', trigger: 'manual' }, noUpdate, live()); } catch (e) { err = e.message; }
  check('a partial failure still completes and names the failed family', err === null && res?.families.some(f => f.status === 'failed') && res.families.some(f => f.status === 'ok') && /1 family failed/.test(res.note), err ?? JSON.stringify(res?.families));
  rmSync(pdir, { recursive: true, force: true });
}

// ── related_terms: one SERP page, not three ────────────────────────────────────────────────
console.log('related_terms');
{
  let body = null;
  const dfs = dfsClient(async (_url, init) => { body = JSON.parse(init.body)[0]; return jsonRes({ status_code: 20000, cost: 0.002, tasks: [{ status_code: 20000, result: [{ items: [
    { type: 'people_also_ask', items: [{ title: 'what is x?' }] }, { type: 'related_searches', items: ['x near me', { title: 'best x' }] },
  ] }] }] }); });
  const r = await dfs.relatedTerms('x');
  check('relatedTerms asks for depth 10 (PAA and related searches are page-1 elements)', body?.depth === 10, JSON.stringify(body));
  check('and still returns both lists', r.peopleAlsoAsk.length === 1 && r.relatedSearches.length === 2, JSON.stringify(r));
}

// ── The check count the package files state is the live registry's ─────────────────────────
console.log('check count');
{
  const n = listChecks().length;
  const count = (s) => [...String(s).matchAll(/\b(\d+) (?:deterministic and judgement-labelled )?checks\b/g)].map(m => Number(m[1]));
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const man = JSON.parse(readFileSync(path.join(root, 'mcpb', 'manifest.json'), 'utf8'));
  const stated = { 'package.json description': count(pkg.description), 'manifest description': count(man.description), 'manifest long_description': count(man.long_description) };
  for (const [where, nums] of Object.entries(stated)) check(`${where} states the live check count (${n})`, nums.length > 0 && nums.every(x => x === n), JSON.stringify(nums));
  check('package.json, server.json and the manifest agree on the version', pkg.version === man.version && pkg.version === JSON.parse(readFileSync(path.join(root, 'server.json'), 'utf8')).version, `${pkg.version} / ${man.version}`);
}

for (const c of closers) c.close();
try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir; the OS cleans it */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
