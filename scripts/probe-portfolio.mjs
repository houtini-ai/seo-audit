// Portfolio dashboard probe . Fixture-fed: DataForSEO responses come
// from scripts/fixtures/portfolio/*.json (raw live responses, 24 Oct 2026) through the client's
// fetchImpl hook, so nothing touches the network or spends money.
// Run: npm run build:server && node scripts/probe-portfolio.mjs
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync as rmRaw, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { DataForSeoClient } from '../dist/core/DataForSeoClient.js';
import { RankTracker } from '../dist/core/RankTracker.js';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { dbPathFor } from '../dist/core/paths.js';
import { targetForProperty, isValidDomain } from '../dist/core/portfolioTarget.js';
import { PortfolioStore, MAX_WATCHED } from '../dist/core/PortfolioStore.js';
import { planRefresh, quotePlan } from '../dist/core/portfolioPlan.js';
import { runPortfolioRefresh, quotePortfolioRefresh } from '../dist/core/PortfolioRefresh.js';
import { getPortfolioData, getDomainOverview } from '../dist/core/portfolioData.js';
import { saveSchedule, claimDue, previewSchedule, nextWeekly, nextMonthly } from '../dist/core/portfolioSchedule.js';
import { listLocalProperties } from '../dist/core/webServer.js';

let pass = 0, fail = 0;
const clients = [];
// Windows can't delete a folder holding an open SQLite file: close the test clients first, and never fail on cleanup.
const rmSync = (d, o) => { for (const c of clients.splice(0)) c.close(); try { rmRaw(d, o); } catch { /* temp dir; the OS cleans it */ } };
const check = (name, cond, detail) => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name} :: ${detail}`); } };

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'portfolio');
const fixture = (name) => JSON.parse(readFileSync(path.join(FIX, `${name}.json`), 'utf8')).tasks;

// Endpoint path → fixture tasks. relevant_pages has no live fixture: a minimal synthetic one.
const RELEVANT = [{ status_code: 20000, cost: 0.015, result: [{ items: [
  { page_address: 'https://simracingcockpit.gg/a/', metrics: { organic: { etv: 900, count: 40, pos_1: 3 } } },
  { page_address: 'https://simracingcockpit.gg/b/', metrics: { organic: { etv: 1200, count: 55 } } },
] }] }];
const ROUTES = {
  '/v3/backlinks/bulk_ranks/live': 'bulk_ranks',
  '/v3/backlinks/bulk_referring_domains/live': 'bulk_referring_domains',
  '/v3/backlinks/bulk_backlinks/live': 'bulk_backlinks',
  '/v3/backlinks/bulk_new_lost_referring_domains/live': 'bulk_new_lost_referring_domains',
  '/v3/dataforseo_labs/google/bulk_traffic_estimation/live': 'bulk_traffic_estimation',
  '/v3/dataforseo_labs/google/domain_rank_overview/live': 'domain_rank_overview_all_locations',
  '/v3/dataforseo_labs/google/ranked_keywords/live': 'ranked_keywords_item_types',
  '/v3/dataforseo_labs/google/historical_rank_overview/live': 'historical_rank_overview',
  '/v3/backlinks/history/live': 'backlinks_history',
  '/v3/backlinks/domain_pages/live': 'domain_pages',
  '/v3/ai_optimization/llm_mentions/historical/live': 'llm_historical',
  '/v3/ai_optimization/llm_mentions/top_mentioned_pages/live': 'llm_top_pages',
  '/v3/ai_optimization/llm_mentions/top_mentioned_domains/live': 'llm_top_domains',
};
function makeFetch({ notEnabled = [], log = [] } = {}) {
  return async (url) => {
    const p = new URL(url).pathname;
    log.push(p);
    if (notEnabled.some(x => p.startsWith(x))) {
      return { ok: true, status: 200, json: async () => ({ status_code: 20000, cost: 0, tasks: [{ status_code: 40204, status_message: 'Access denied. Visit Plans and Subscriptions to activate your subscription.', result: null }] }) };
    }
    const tasks = p === '/v3/dataforseo_labs/google/relevant_pages/live' ? RELEVANT : ROUTES[p] ? fixture(ROUTES[p]) : null;
    if (!tasks) throw new Error(`no fixture for ${p}`);
    return { ok: true, status: 200, json: async () => ({ status_code: 20000, cost: tasks[0].cost ?? 0.01, tasks }) };
  };
}

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'sac-portfolio-'));
  // An owned property: sc-domain:simracingcockpit.gg (US), with a little GSC.
  const site = 'sc-domain:simracingcockpit.gg';
  const db = new AuditDatabase(dbPathFor(dir, site));
  db.upsertProperty(site, 'asis');
  db.setDfsLocation(site, 2840);
  const sa = db.db.prepare(`INSERT INTO search_analytics (date,query,page,page_key,device,country,clicks,impressions,ctr,position) VALUES (?,?,?,?,'','',?,?,?,?)`);
  const day = (d) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
  for (let d = 4; d <= 60; d++) sa.run(day(d), 'sim rig', 'https://simracingcockpit.gg/a/', 'https://simracingcockpit.gg/a/', d <= 31 ? 10 : 30, 300, 0.03, 4);
  db.close();
  return { dir, site };
}

const client = (dir, opts) => { const c = new DataForSeoClient('u', 'p', path.join(dir, 'dataforseo-cache.db'), 20, { fetchImpl: makeFetch(opts) }); clients.push(c); return c; };

// ── 1. Target derivation + validation ─────────────────────────────────────────────────────────
check('sc-domain → bare domain', targetForProperty('sc-domain:Example.com') === 'example.com', targetForProperty('sc-domain:Example.com'));
check('URL-prefix www → root (root domain)', targetForProperty('https://www.example.com/') === 'example.com', targetForProperty('https://www.example.com/'));
check('a real subdomain stays a subdomain', targetForProperty('https://shop.example.com/') === 'shop.example.com', targetForProperty('https://shop.example.com/'));
check('domain validation rejects IPs, single labels, spaces', !isValidDomain('10.0.0.1') && !isValidDomain('localhost') && !isValidDomain('a b.com') && isValidDomain('ehi.com.au'), 'validation');

// ── 2. Store ──────────────────────────────────────────────────────────────────────────────────
{
  const { dir } = setup();
  const s = new PortfolioStore(dir);
  s.syncOwned();
  const owned = s.list().filter(d => d.kind === 'owned');
  check('owned domains come from the property DBs', owned.length === 1 && owned[0].domain === 'simracingcockpit.gg' && owned[0].locationCode === 2840, JSON.stringify(owned));
  check('_portfolio.db is not enumerated as a property', listLocalProperties(dir).every(p => !p.file.startsWith('_')), JSON.stringify(listLocalProperties(dir)));
  const w = s.addWatched('https://www.EHI.com.au/path', { locationCode: 2036, group: 'competitors' });
  check('watched domains are normalised (scheme, www, path, case)', w.domain === 'ehi.com.au' && w.locationCode === 2036 && w.groupLabel === 'competitors', JSON.stringify(w));
  let threw = ''; try { s.addWatched('simracingcockpit.gg', { locationCode: 2840 }); } catch (e) { threw = e.message; }
  check('an owned domain cannot be added as watched', /owned/.test(threw), threw);
  threw = ''; try { s.addWatched('not a domain'); } catch (e) { threw = e.message; }
  check('a non-domain is refused', /not a domain/.test(threw), threw);
  for (let i = 0; i < MAX_WATCHED - 1; i++) s.addWatched(`w${i}.example.com`);
  threw = ''; try { s.addWatched('one-too-many.example.com'); } catch (e) { threw = e.message; }
  check(`watched domains are capped at ${MAX_WATCHED}`, /limit/.test(threw), threw);
  check('remove is soft and only for watched rows', s.removeWatched('w0.example.com') === 1 && s.removeWatched('simracingcockpit.gg') === 0, 'remove');
  s.close();
  rmSync(dir, { recursive: true, force: true });
}

// ── 3. Plan + quote ───────────────────────────────────────────────────────────────────────────
{
  const ds = [
    { domain: 'simracingcockpit.gg', locationCode: 2840, kind: 'owned', siteUrls: [], languageCode: 'en', groupLabel: null, addedAt: '' },
    { domain: 'ehi.com.au', locationCode: 2036, kind: 'watched', siteUrls: [], languageCode: 'en', groupLabel: null, addedAt: '' },
  ];
  const w = planRefresh(ds, 'weekly');
  const calls = Object.fromEntries(w.map(f => [f.id, f.calls.length]));
  check('weekly: bulk traffic is one call per LOCATION (2), backlinks bulk 4, SERP mix per domain (2)', calls.traffic === 2 && calls['backlinks-bulk'] === 4 && calls['serp-mix'] === 2, JSON.stringify(calls));
  const m = planRefresh(ds, 'monthly');
  const llm = m.find(f => f.id === 'llm-history');
  check('monthly: LLM history is per domain per platform, ChatGPT always at the US (2840)', llm.calls.length === 4 && llm.calls.filter(c => c.platform === 'chat_gpt').every(c => c.locationCode === 2840), JSON.stringify(llm.calls));
  const q = quotePlan([...w, ...m], 'all', 2);
  check('the quote is calls × observed price, summed', q.calls === 8 + m.reduce((s, f) => s + f.calls.length, 0) && q.usd > 1 && q.usd < 2, JSON.stringify({ calls: q.calls, usd: q.usd }));
}

// ── 4. A full refresh from fixtures; then a re-run served from the cache ─────────────────────
{
  const { dir, site } = setup();
  const s = new PortfolioStore(dir); s.addWatched('ehi.com.au', { locationCode: 2036, group: 'competitors' }); s.close();
  const log = [];
  const dfs = client(dir, { log });
  const rt = new RankTracker(dfs, dir);
  const quote = quotePortfolioRefresh(dir, 'all');
  const r = await runPortfolioRefresh(dir, dfs, rt, { tier: 'all', trigger: 'manual', budgetUsd: null }, () => {}, new AbortController().signal);
  check('a full refresh completes with every family ok', r.families.every(f => f.status === 'ok'), JSON.stringify(r.families.map(f => [f.id, f.status])));
  check('the ledger records actual spend (summed response costs), not the quote', r.spent > 0 && Math.abs(r.spent - r.quoted) / r.quoted < 0.5, JSON.stringify({ spent: r.spent, quoted: r.quoted }));
  check('the run used exactly the planned calls', r.calls === quote.calls, `${r.calls} vs ${quote.calls}`);
  // Owned: rank_history written from the SAME (cached) historical_rank_overview response.
  const hroCalls = log.filter(p => p.includes('historical_rank_overview')).length;
  const pdb = new Database(dbPathFor(dir, site), { readonly: true });
  const rh = pdb.prepare('SELECT COUNT(*) n FROM rank_history').get().n; pdb.close();
  check('owned domains: rank_history is written too, without a second paid call', rh > 0 && hroCalls === 2, `rank_history ${rh} rows, ${hroCalls} historical calls for 2 domains`);
  const r2 = await runPortfolioRefresh(dir, dfs, rt, { tier: 'all', trigger: 'manual', budgetUsd: null }, () => {}, new AbortController().signal);
  check('an immediate re-run is served from the cache at $0', r2.spent === 0 && r2.cacheHits === r2.calls, JSON.stringify({ spent: r2.spent, hits: r2.cacheHits, calls: r2.calls }));

  // ── 5. Payload ──
  const now = new Date('2026-10-24T12:00:00Z');
  const p = getPortfolioData(dir, now);
  const sim = p.rows.find(x => x.domain === 'simracingcockpit.gg'), ehi = p.rows.find(x => x.domain === 'ehi.com.au');
  check('payload: one row per (domain, location), owned + watched', p.counts.owned === 1 && p.counts.watched === 1 && !!sim && !!ehi, JSON.stringify(p.counts));
  check('payload: headline values come from the weekly snapshot', sim.domainRank.value === 45 && sim.domainRank.source === 'snapshot' && sim.referringDomains.value === 607, JSON.stringify({ r: sim.domainRank.value, src: sim.domainRank.source, rd: sim.referringDomains.value }));
  check('payload: changes compare the last COMPLETE month (Sep) with Aug, never the partial October', sim.referringDomains.month?.to === '2026-09' && sim.referringDomains.month?.from === '2026-08', JSON.stringify(sim.referringDomains.month));
  check('payload: a lagging series compares its own latest complete month (Labs history ends 2026-07)', sim.organicTraffic.month?.to === '2026-07', JSON.stringify(sim.organicTraffic.month));
  check('payload: AI mentions month-to-date (Oct) is flagged partial, not compared', sim.aiMentions.partial != null && sim.aiMentions.month?.to === '2026-09', JSON.stringify({ partial: sim.aiMentions.partial, m: sim.aiMentions.month }));
  check('payload: a non-US domain flags ChatGPT as US-only', ehi.aiMentions.chatgptUsOnly === true && sim.aiMentions.chatgptUsOnly === false, 'chatgptUsOnly');
  check('payload: owned rows carry measured GSC clicks (28 days) with their window', !!sim.clicks28 && sim.clicks28.value > 0 && /^\d{4}-\d{2}-\d{2}$/.test(sim.clicks28.window.end) && ehi.clicks28 === null, JSON.stringify(sim.clicks28));
  check('payload: 12-point sparklines', sim.referringDomains.spark.length === 12 && sim.referringDomains.spark.filter(v => v != null).length >= 10, JSON.stringify(sim.referringDomains.spark));

  // ── 6. Domain overview ──
  const o = getDomainOverview(dir, 'simracingcockpit.gg', undefined, now);
  check('overview: countries are summed per location and sorted by traffic', getDomainOverview(dir, 'ehi.com.au', 2036, now).countries[0]?.code === 2036, 'countries');
  check('overview: co-cited sources exclude the domain itself', o.citedSources.length > 0 && o.citedSources.every(c => !/simracingcockpit\.gg$/.test(c.domain)), JSON.stringify(o.citedSources.slice(0, 3)));
  check("overview: cited pages are the domain's own pages only", o.topPages.cited.length > 0 && o.topPages.cited.every(c => new URL(c.url).hostname.endsWith('simracingcockpit.gg')), JSON.stringify(o.topPages.cited.slice(0, 2)));
  check('overview: SERP mix carries AI Overview references (item_types sent)', o.serpMix?.aiOverviewReference === 1465, JSON.stringify(o.serpMix));
  check('overview: the AI series is per platform, and the current month is partial', o.series.some(x => x.aiGoogle.mentions != null) && o.series.filter(x => x.partial).every(x => x.month > '2026-09'), 'series');
  check('overview: owned domains get the measured GSC strip', !!o.gsc && o.gsc.clicks28 > 0, JSON.stringify(o.gsc));
  check('overview: AI Mode / Gemini / Perplexity are stated as not measured', o.notes.some(n => /AI Mode, Gemini and Perplexity/.test(n)), JSON.stringify(o.notes));
  rmSync(dir, { recursive: true, force: true });
}

// ── 7. An API family that is not enabled fails alone, and the cell says why ──────────────────
{
  const { dir } = setup();
  const dfs = client(dir, { notEnabled: ['/v3/backlinks/'] });
  const r = await runPortfolioRefresh(dir, dfs, null, { tier: 'weekly', trigger: 'manual' }, () => {}, new AbortController().signal);
  const bl = r.families.find(f => f.id === 'backlinks-bulk'), tr = r.families.find(f => f.id === 'traffic');
  check('Backlinks not enabled: that family fails, Labs still succeeds', bl.status === 'failed' && tr.status === 'ok', JSON.stringify(r.families.map(f => [f.id, f.status])));
  check('...and stops after the first 40204 instead of paying for every call', bl.calls === 1, `calls ${bl.calls}`);
  const row = getPortfolioData(dir).rows[0];
  check('...and the empty cell names the reason', /Backlinks API not enabled/.test(row.referringDomains.empty ?? '') && row.organicTraffic.value != null, JSON.stringify({ rd: row.referringDomains.empty, etv: row.organicTraffic.value }));
  rmSync(dir, { recursive: true, force: true });
}

// ── 8. Budget guard (between families) ────────────────────────────────────────────────────────
{
  const { dir } = setup();
  const dfs = client(dir);
  const r = await runPortfolioRefresh(dir, dfs, null, { tier: 'all', trigger: 'schedule', budgetUsd: 0.06 }, () => {}, new AbortController().signal);
  const skipped = r.families.filter(f => f.status === 'skipped-budget');
  check('a run stops spending at the cap: later families are skipped, not run', skipped.length > 0 && r.spent <= 0.06 + 1e-9, JSON.stringify({ spent: r.spent, skipped: skipped.map(f => f.id) }));
  const st = new PortfolioStore(dir);
  const run = st.db.prepare('SELECT status, note FROM portfolio_run ORDER BY id DESC LIMIT 1').get(); st.close();
  check('...the run is recorded as partial-budget with a note', run.status === 'partial-budget' && /budget/.test(run.note), JSON.stringify(run));
  rmSync(dir, { recursive: true, force: true });
}

// ── 9. Scheduler: atomic claim, catch-up once, consent drift ──────────────────────────────────
{
  const { dir } = setup();
  const now = new Date('2026-10-26T09:00:00Z'); // a Monday
  check('next weekly run is strictly in the future, on the weekday', nextWeekly(now, 1).toISOString() === '2026-11-02T06:00:00.000Z' && nextWeekly(new Date('2026-10-26T05:00:00Z'), 1).toISOString() === '2026-10-26T06:00:00.000Z', nextWeekly(now, 1).toISOString());
  check('next monthly run clamps to day 28 and rolls to next month', nextMonthly(now, 31).toISOString() === '2026-10-28T06:00:00.000Z' && nextMonthly(now, 3).toISOString() === '2026-11-03T06:00:00.000Z', nextMonthly(now, 31).toISOString());
  const prev = previewSchedule(dir, { budgetUsd: 10 }, now);
  const peek = new PortfolioStore(dir); const saved = peek.db.prepare('SELECT 1 FROM portfolio_schedule').get(); peek.close();
  check('preview projects the month and saves nothing', prev.projectedMonthUsd > 0 && !saved, JSON.stringify(prev));
  saveSchedule(dir, { budgetUsd: 10 }, now);
  // Make both tiers three weeks overdue (the machine was off).
  const st = new PortfolioStore(dir);
  st.db.prepare(`UPDATE portfolio_schedule SET next_weekly_due = '2026-10-05T06:00:00.000Z', next_monthly_due = '2026-10-03T06:00:00.000Z'`).run();
  st.close();
  const a = claimDue(dir, now), b = claimDue(dir, now);
  check('two claimers at once: exactly one wins', (a ? 1 : 0) + (b ? 1 : 0) === 1 && a?.tier === 'all', JSON.stringify({ a, b }));
  check('the claim carries the budget for the job to enforce', a?.args.budgetUsd === 10 && a?.args.trigger === 'schedule', JSON.stringify(a?.args));
  const st2 = new PortfolioStore(dir);
  const sch = st2.db.prepare('SELECT next_weekly_due w, next_monthly_due m FROM portfolio_schedule').get();
  check('a missed run catches up ONCE: the next due date is computed from now', sch.w > now.toISOString() && sch.m > now.toISOString(), JSON.stringify(sch));
  // Consent drift: pretend the user agreed to a far cheaper weekly run, then make it due.
  st2.db.prepare(`UPDATE portfolio_schedule SET consent_quote_weekly = 0.01, next_weekly_due = '2026-10-20T06:00:00.000Z'`).run();
  st2.close();
  const c = claimDue(dir, now);
  const st3 = new PortfolioStore(dir);
  const skip = st3.db.prepare(`SELECT status, note FROM portfolio_run ORDER BY id DESC LIMIT 1`).get(); st3.close();
  check('a quote 25%+ over the consented one is skipped with re-confirm', c === null && skip?.status === 'skipped-reconfirm' && /Re-confirm/.test(skip.note), JSON.stringify({ c, skip }));
  rmSync(dir, { recursive: true, force: true });
}

// ── 10. Attention rules: positives and near misses ────────────────────────────────────────────
{
  const { dir } = setup();
  const st = new PortfolioStore(dir); st.syncOwned();
  const put = st.db.prepare(`INSERT OR REPLACE INTO domain_month (domain, location_code, month, source, platform, organic_etv, referring_main_domains, rank, mentions) VALUES ('simracingcockpit.gg', 2840, ?, ?, ?, ?, ?, ?, ?)`);
  // Labs ETV: 1000 → 650 (-35%) in Sep: one month at 30%+ fires.
  put.run('2026-08', 'labs', '', 1000, null, null, null); put.run('2026-09', 'labs', '', 650, null, null, null);
  // Referring domains: 100 → 92 (-8%): a near miss under 10%. Rank 50 → 44: fires.
  put.run('2026-08', 'backlinks', '', null, 100, 50, null); put.run('2026-09', 'backlinks', '', null, 92, 44, null);
  // AI mentions: 15 → 2: prior under the 20 base, so silent.
  put.run('2026-08', 'llm', 'google', null, null, null, 15); put.run('2026-09', 'llm', 'google', null, null, null, 2);
  st.close();
  const row = getPortfolioData(dir, new Date('2026-10-24T12:00:00Z')).rows[0];
  const reasons = row.attention.join(' | ');
  check('ETV down 35% in one complete month is flagged, with its month', /Organic traffic \(estimated\) down 35% in 2026-09/.test(reasons), reasons);
  check('Domain Rank down 6 points is flagged', /Domain Rank \(DataForSEO\) down 6 points/.test(reasons), reasons);
  check('referring domains down 8% is NOT flagged (under 10%)', !/Referring domains down/.test(reasons), reasons);
  check('AI mentions from a base under 20 are NOT flagged', !/AI mentions down/.test(reasons), reasons);
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
