// Portfolio follow-ups (#79): competitor suggestions + keyword position tracking. No network: the
// DataForSEO responses are live captures (27 Nov 2026, scripts/fixtures/portfolio/
// competitors_domain.json + serp_organic_depth100.json) served through the client's fetchImpl hook,
// and every database is in a temp dir.
// Run: npm run build:server && node scripts/probe-portfolio-tracking.mjs
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync as rmRaw, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DataForSeoClient } from '../dist/core/DataForSeoClient.js';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { dbPathFor } from '../dist/core/paths.js';
import { PortfolioStore } from '../dist/core/PortfolioStore.js';
import { serpCheckPrice, competitorsPrice } from '../dist/core/portfolioPlan.js';
import { organicHost, hostMatchesDomain, isGoogleRedirect } from '../dist/core/serpHost.js';
import {
  normalizeKeyword, addTrackedKeywords, removeTrackedKeywords, listTrackedKeywords, parseSerpPositions, serpDatetime,
  positionStatus, positionLabel, changeLabel, readTrackedPositions, quoteKeywordCheck, runKeywordCheck, MAX_TRACKED_KEYWORDS, writeCheck,
} from '../dist/core/keywordTracking.js';
import { parseCompetitorSuggestions, quoteSuggest, runSuggest, ownedRowFor } from '../dist/core/competitorSuggest.js';
import { getDomainOverview } from '../dist/core/portfolioData.js';
import { JOB_KINDS } from '../dist/core/jobKinds.js';

let pass = 0, fail = 0;
const clients = [];
// Windows can't delete a folder holding an open SQLite file: close the test clients first.
const rmSync = (d) => { for (const c of clients.splice(0)) { try { c.cache.close(); } catch { /* closed */ } } try { rmRaw(d, { recursive: true, force: true }); } catch { /* temp dir */ } };
const check = (name, cond, detail) => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name} :: ${detail}`); } };

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'portfolio');
const load = (name) => JSON.parse(readFileSync(path.join(FIX, `${name}.json`), 'utf8'));
const SERP = load('serp_organic_depth100');
const COMP = load('competitors_domain');

/** fetchImpl serving fixtures; `state.serp` can be swapped to simulate a later check. */
function makeFetch(state) {
  return async (url, init) => {
    const p = new URL(url).pathname;
    state.log.push({ p, body: JSON.parse(init.body) });
    const fx = p.endsWith('/competitors_domain/live') ? COMP : p.endsWith('/serp/google/organic/live/advanced') ? state.serp : null;
    if (!fx) throw new Error(`no fixture for ${p}`);
    return { ok: true, status: 200, json: async () => ({ status_code: 20000, cost: fx.cost, tasks: fx.tasks }) };
  };
}
const client = (dir, state, cacheName = 'dataforseo-cache.db') => {
  const c = new DataForSeoClient('u', 'p', path.join(dir, cacheName), 20, { fetchImpl: makeFetch(state) });
  clients.push(c);
  return c;
};

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'sac-pf-track-'));
  const site = 'sc-domain:simracingcockpit.gg';
  const db = new AuditDatabase(dbPathFor(dir, site));
  db.upsertProperty(site, 'asis');
  db.setDfsLocation(site, 2840);
  db.db.prepare(`UPDATE property_meta SET last_synced_at = datetime('now') WHERE site_url = ?`).run(site);
  db.close();
  return { dir, site };
}

/** The same SERP a week later with some results moved: our page from #9 to #5, trakracer gone. */
function laterSerp() {
  const s = structuredClone(SERP);
  const r = s.tasks[0].result[0];
  r.datetime = '2026-12-04 07:00:00 +00:00';
  for (const it of r.items) {
    if (it.type !== 'organic') continue;
    if (/^https:\/\/simracingcockpit\.gg › best-sim-rigs/.test(it.breadcrumb ?? '')) it.rank_group = 5;
    if (/trakracer\.com/.test(it.breadcrumb ?? '')) it.breadcrumb = 'https://othersite.example › x';
  }
  return s;
}

// ── 1. Host attribution: DataForSEO wraps every organic result in a google.com redirect ────────────
{
  const org = SERP.tasks[0].result[0].items.filter(i => i.type === 'organic');
  check('fixture: every organic item is domain google.com with a goto redirect', org.every(i => i.domain === 'google.com' && isGoogleRedirect(i.url)), org[0]?.domain);
  const h = organicHost(org.find(i => /nextlevelracing\.com › racing-cockpits/.test(i.breadcrumb)));
  check('host read from the breadcrumb, never google.com; the redirect is not kept as the URL', h.host === 'nextlevelracing.com' && h.via === 'breadcrumb' && h.url === null, JSON.stringify(h));
  const yt = organicHost(org.find(i => /^YouTube/.test(i.website_name ?? '')));
  check('a video result is attributed to youtube.com from website_name', yt.host === 'youtube.com' && yt.via === 'platform', JSON.stringify(yt));
  check('www stripped from a breadcrumb host', organicHost({ domain: 'google.com', url: 'https://google.com/goto?url=x', breadcrumb: 'https://www.fanatec.com › cockpits' }).host === 'fanatec.com', '');
  check('a real domain/url is used as-is', organicHost({ domain: 'www.example.com', url: 'https://www.example.com/a' }).host === 'example.com', '');
  check('a truncated breadcrumb host is not a host', organicHost({ domain: 'google.com', url: 'https://google.com/goto?url=x', breadcrumb: 'https://averyveryverylongdom... › x' }).host === null, '');
  check('an unknown platform label stays unattributed', organicHost({ domain: 'google.com', url: 'https://google.com/goto?url=x', breadcrumb: '3 years ago', website_name: 'Somewhere · person' }).host === null, '');
  check('host match is exact-or-subdomain', hostMatchesDomain('shop.readysetsim.com', 'readysetsim.com') && hostMatchesDomain('readysetsim.com', 'readysetsim.com'), '');
  check('host match is never a substring (x.com vs pimax.com)', !hostMatchesDomain('pimax.com', 'x.com') && !hostMatchesDomain('notfanatec.com', 'fanatec.com'), '');
}

// ── 2. Prices are the observed costs ─────────────────────────────────────────────────────────────
{
  check('SERP depth 100 + poisoned repair = observed $0.0175', serpCheckPrice(100) === SERP.cost, `${serpCheckPrice(100)} vs ${SERP.cost}`);
  check('SERP depth 30 = $0.005 + $0.002 repair', serpCheckPrice(30) === 0.007, String(serpCheckPrice(30)));
  check('competitors_domain 21 rows = observed $0.01452', competitorsPrice(21) === COMP.cost, `${competitorsPrice(21)} vs ${COMP.cost}`);
  check('suggest quote asks for limit + 1 rows, capped', quoteSuggest(20).rows === 21 && quoteSuggest(20).usd === COMP.cost && quoteSuggest(500).rows === 51, JSON.stringify(quoteSuggest(500)));
}

// ── 3. Parsing positions from the live fixture ───────────────────────────────────────────────────
{
  const p = parseSerpPositions(SERP, ['simracingcockpit.gg', 'nextlevelracing.com', 'trakracer.com', 'absent-domain.example'], 100);
  const by = Object.fromEntries(p.positions.map(x => [x.domain, x]));
  check('100 organic results read at depth 100', p.organicResults === 100 && p.serpDepth === 100, String(p.organicResults));
  check('simracingcockpit.gg found at #9 (best of its 2 results)', by['simracingcockpit.gg'].position === 9 && by['simracingcockpit.gg'].results === 2, JSON.stringify(by['simracingcockpit.gg']));
  check('ranking page shown as the breadcrumb, URL null (only a redirect was given)', /simracingcockpit\.gg › best-sim-rigs/.test(by['simracingcockpit.gg'].shownAs) && by['simracingcockpit.gg'].url === null, JSON.stringify(by['simracingcockpit.gg']));
  check('nextlevelracing.com #1, trakracer.com #4', by['nextlevelracing.com'].position === 1 && by['trakracer.com'].position === 4, JSON.stringify([by['nextlevelracing.com'], by['trakracer.com']]));
  check('a domain not in the results is null (not in top 100), never 0', by['absent-domain.example'].position === null && positionLabel({ position: null, serpDepth: 100 }) === 'not in top 100', JSON.stringify(by['absent-domain.example']));
  check('every result attributed (video results via the platform label)', p.unattributed === 0, String(p.unattributed));
  check('from_web (restored poisoned page) detected', p.fromWeb === true, String(p.fromWeb));
  check('checkedAt is the SERP datetime in UTC', p.checkedAt === '2026-11-27 07:03:12' && serpDatetime('2026-11-27 08:03:12 +01:00') === '2026-11-27 07:03:12', p.checkedAt);
  const shallow = parseSerpPositions(SERP, ['simracingcockpit.gg', 'shop.readysetsim.com'], 30);
  check('depth limits what counts: results past N are ignored', shallow.organicResults === 30 && shallow.positions[1].position === null, JSON.stringify(shallow.positions));
}

// ── 4. Change labels ─────────────────────────────────────────────────────────────────────────────
{
  const s = (c, p) => positionStatus(c, p);
  check('first check', s({ position: 9, serpDepth: 100 }, null).status === 'first-check', '');
  const up = s({ position: 5, serpDepth: 100 }, { position: 9, serpDepth: 100 });
  check('up 4 (9 to 5)', up.status === 'up' && up.change === 4, JSON.stringify(up));
  check('dropped out', s({ position: null, serpDepth: 100 }, { position: 4, serpDepth: 100 }).status === 'dropped-out', '');
  check('entered', s({ position: 40, serpDepth: 100 }, { position: null, serpDepth: 100 }).status === 'entered', '');
  check('an absence at a different depth is not compared', s({ position: 45, serpDepth: 100 }, { position: null, serpDepth: 30 }).status === 'depth-changed', '');
  check('labels', changeLabel({ status: 'dropped-out', change: null, previous: 4, serpDepth: 100 }) === 'was #4, now not in top 100' && changeLabel({ status: 'down', change: -3, previous: 2, serpDepth: 100 }) === 'down 3', '');
}

// ── 5. The keyword list: normalised, deduped, capped and reported ────────────────────────────────
{
  const { dir } = setup();
  const st = new PortfolioStore(dir);
  check('keywords normalised (case, spacing)', normalizeKeyword('  Sim   Racing COCKPIT ') === 'sim racing cockpit', '');
  const r1 = addTrackedKeywords(st, ['Sim Racing Cockpit', 'sim racing cockpit', '  ', 'x'.repeat(201)], 2840);
  check('duplicates collapse; empty and over-long are reported invalid', r1.added.length === 1 && r1.invalid.length === 2, JSON.stringify(r1));
  check('same keyword again reads as already tracked', addTrackedKeywords(st, ['sim racing cockpit'], 2840).alreadyTracked.length === 1, '');
  check('same keyword in another country is a separate entry', addTrackedKeywords(st, ['sim racing cockpit'], 2826).added.length === 1, '');
  const many = Array.from({ length: MAX_TRACKED_KEYWORDS + 5 }, (_, i) => `kw ${i}`);
  const r2 = addTrackedKeywords(st, many, 2840);
  check(`the list is capped at ${MAX_TRACKED_KEYWORDS}, and the overflow is named`, r2.total === MAX_TRACKED_KEYWORDS && r2.overCap.length === 7 && r2.added.length === MAX_TRACKED_KEYWORDS - 2, JSON.stringify({ total: r2.total, over: r2.overCap.length, added: r2.added.length }));
  const rm = removeTrackedKeywords(st, many, 2840);
  check('remove reports what was not tracked', rm.removed.length === MAX_TRACKED_KEYWORDS - 2 && rm.notTracked.length === 7, JSON.stringify({ r: rm.removed.length, n: rm.notTracked.length }));
  st.close();
  rmSync(dir);
}

// ── 6. A check end to end: quote, run (fixture), history, change, overview, budget ──────────────
{
  const { dir } = setup();
  const st = new PortfolioStore(dir);
  st.syncOwned();
  st.addWatched('nextlevelracing.com', { locationCode: 2840, group: 'competitors' });
  st.addWatched('trakracer.com', { locationCode: 2840, group: 'competitors' });
  st.addWatched('fanatec.com', { locationCode: 2826 }); // another country: not on a US SERP
  addTrackedKeywords(st, ['sim racing cockpit'], 2840);
  addTrackedKeywords(st, ['racing seat'], 2826);
  const q = quoteKeywordCheck(st, { locationCode: 2840 });
  check('quote = keywords x observed price, with the domains each location reports', q.keywords === 1 && q.usd === 0.0175 && q.byLocation[0].domains.join(',') === 'nextlevelracing.com,simracingcockpit.gg,trakracer.com', JSON.stringify(q));
  const qAll = quoteKeywordCheck(st, { keywords: ['Sim Racing Cockpit', 'never added'] });
  check('a keyword that is not tracked is named, not quoted', qAll.keywords === 1 && qAll.notTracked.join() === 'never added', JSON.stringify(qAll));
  st.close();

  const state = { serp: SERP, log: [] };
  const r1 = await runKeywordCheck(dir, client(dir, state), { locationCode: 2840 }, () => {}, new AbortController().signal);
  const body = state.log[0]?.body?.[0] ?? {};
  check('one SERP call per keyword, depth 100, poisoned repair on, at the keyword location', state.log.length === 1 && body.depth === 100 && body.resolve_poisoned_results === true && body.location_code === 2840 && body.keyword === 'sim racing cockpit', JSON.stringify(body));
  check('spend recorded = the response cost', r1.spent === 0.0175 && r1.checked === 1, JSON.stringify(r1));

  // A week later (a fresh cache, so the fixture is "live" again): our page moved up, trakracer left.
  const state2 = { serp: laterSerp(), log: [] };
  await runKeywordCheck(dir, client(dir, state2, 'cache2.db'), { locationCode: 2840 }, () => {}, new AbortController().signal);
  const rs = new PortfolioStore(dir);
  const view = readTrackedPositions(rs.db, { locationCode: 2840 });
  const by = Object.fromEntries(view[0].positions.map(p => [p.domain, p]));
  check('history kept: two checks stored', rs.db.prepare(`SELECT COUNT(*) n FROM keyword_check`).get().n === 2, '');
  check('owned page up 4 (#9 to #5)', by['simracingcockpit.gg'].position === 5 && by['simracingcockpit.gg'].status === 'up' && by['simracingcockpit.gg'].change === 4, JSON.stringify(by['simracingcockpit.gg']));
  check('trakracer dropped out of the top 100 (null, not 0)', by['trakracer.com'].position === null && by['trakracer.com'].status === 'dropped-out' && by['trakracer.com'].previous === 4, JSON.stringify(by['trakracer.com']));
  check('a domain in another country is not reported on this SERP', !by['fanatec.com'], Object.keys(by).join());
  const runs = rs.db.prepare(`SELECT tier, status, spent_usd FROM portfolio_run ORDER BY id`).all();
  check('each check is a ledger run (tier keywords)', runs.length === 2 && runs.every(r => r.tier === 'keywords' && r.status === 'completed' && r.spent_usd === 0.0175), JSON.stringify(runs));
  rs.close();

  const ov = getDomainOverview(dir, 'simracingcockpit.gg', 2840);
  const tk = ov?.trackedKeywords;
  check('overview carries the tracked keywords for this domain and location', tk?.total === 1 && tk.rows[0].keyword === 'sim racing cockpit' && tk.rows[0].position === 5 && tk.rows[0].status === 'up', JSON.stringify(tk));
  const ovW = getDomainOverview(dir, 'trakracer.com', 2840);
  check('watched domain overview shows its own position state', ovW?.trackedKeywords.rows[0].position === null && ovW.trackedKeywords.rows[0].status === 'dropped-out', JSON.stringify(ovW?.trackedKeywords));
  const ovUk = getDomainOverview(dir, 'fanatec.com', 2826);
  check('a tracked keyword never checked reads as not checked', ovUk?.trackedKeywords.rows[0].status === 'not-checked' && ovUk.trackedKeywords.unchecked === 1, JSON.stringify(ovUk?.trackedKeywords));

  // Budget: a cap already used up skips the call instead of spending.
  const state3 = { serp: SERP, log: [] };
  const r3 = await runKeywordCheck(dir, client(dir, state3, 'cache3.db'), { locationCode: 2840, budgetUsd: 0.03 }, () => {}, new AbortController().signal);
  check('over the monthly cap: no call, the keyword is named as skipped', state3.log.length === 0 && r3.skippedBudget.join() === 'sim racing cockpit', JSON.stringify(r3));
  rmSync(dir);
}

// ── 7. Competitor suggestions ───────────────────────────────────────────────────────────────────
{
  const portfolio = [
    { domain: 'simracingcockpit.gg', locationCode: 2840, kind: 'owned', groupLabel: null },
    { domain: 'fanatec.com', locationCode: 2840, kind: 'watched', groupLabel: 'competitors' },
    { domain: 'trakracer.com', locationCode: 2826, kind: 'watched', groupLabel: null }, // other country: still proposed here
  ];
  const r = parseCompetitorSuggestions(COMP, 'simracingcockpit.gg', 2840, portfolio, 21);
  check('the property itself is excluded with a reason', r.excluded.some(x => x.domain === 'simracingcockpit.gg' && /itself/.test(x.reason)), JSON.stringify(r.excluded));
  check('a domain already watched here is listed, not proposed', r.alreadyInPortfolio.some(a => a.domain === 'fanatec.com' && a.kind === 'watched') && !r.suggestions.some(s => s.domain === 'fanatec.com'), JSON.stringify(r.alreadyInPortfolio));
  check('a domain watched in another country is still proposed here', r.suggestions.some(s => s.domain === 'trakracer.com'), '');
  check('ranked by shared keywords: simracingsetup.com first with its evidence', r.suggestions[0].domain === 'simracingsetup.com' && r.suggestions[0].sharedKeywords === 2264 && r.suggestions[0].rank === 1 && r.suggestions[0].avgPosition != null && r.suggestions[0].sharedEtv != null, JSON.stringify(r.suggestions[0]));
  check('19 proposed + 1 already watched + 1 excluded = 21 rows', r.suggestions.length === 19 && r.returned === 21, `${r.suggestions.length}/${r.returned}`);
  const bb = r.suggestions.find(s => s.domain === 'bestbuy.com');
  check('big general sites are kept, with their size against yours', bb && bb.sizeVsYou > 1000, JSON.stringify(bb));
  check('the cap is reportable (total available vs returned)', r.totalAvailable === 12825, String(r.totalAvailable));
  const www = parseCompetitorSuggestions({ tasks: [{ result: [{ items: [{ domain: 'www.simracingcockpit.gg', intersections: 10 }, { domain: 'shop.simracingcockpit.gg', intersections: 5 }, { domain: 'rival.com', intersections: 3 }] }] }] }, 'simracingcockpit.gg', 2840, [], 4);
  check('www twin and own subdomain excluded', www.excluded.length === 2 && www.suggestions.map(s => s.domain).join() === 'rival.com', JSON.stringify(www));

  const { dir } = setup();
  const st = new PortfolioStore(dir);
  st.addWatched('fanatec.com', { locationCode: 2840 });
  let threw = '';
  try { ownedRowFor(st, 'fanatec.com'); } catch (e) { threw = e.message; }
  check('suggest refuses a watched (not owned) domain', /not an owned property/.test(threw), threw);
  st.close();
  const state = { serp: SERP, log: [] };
  const live = await runSuggest(dir, client(dir, state), 'sc-domain:simracingcockpit.gg', 20);
  const body = state.log[0]?.body?.[0] ?? {};
  check('one competitors_domain call at the property location for limit + 1 rows', state.log.length === 1 && body.target === 'simracingcockpit.gg' && body.location_code === 2840 && body.limit === 21, JSON.stringify(body));
  check('fanatec.com (watched) marked already in the portfolio', live.alreadyInPortfolio.some(a => a.domain === 'fanatec.com'), '');
  const st2 = new PortfolioStore(dir);
  const run = st2.db.prepare(`SELECT tier, status, spent_usd FROM portfolio_run`).get();
  check('suggest spend recorded in the ledger (tier suggest)', run.tier === 'suggest' && run.status === 'completed' && run.spent_usd === COMP.cost, JSON.stringify(run));
  check('suggest adds nothing to the portfolio', st2.list().filter(d => d.kind === 'watched').length === 1, '');
  st2.close();
  rmSync(dir);
}

// ── 8. Wiring ───────────────────────────────────────────────────────────────────────────────────
check('the keywords job kind is registered', typeof JOB_KINDS.keywords === 'function', '');
{
  const { dir } = setup();
  const s = new PortfolioStore(dir);
  check('tracked keyword list starts empty in a fresh portfolio', listTrackedKeywords(s.db).length === 0, '');
  s.close();
  rmSync(dir);
}

// ── Code-review regressions (1.0.8) ─────────────────────────────────────────────────────────────
{
  const dir = mkdtempSync(path.join(tmpdir(), 'sac-kt-reg-'));
  const st = new PortfolioStore(dir);
  addTrackedKeywords(st, ['sim rig'], 2840);
  const sp = (at, positions) => ({ checkedAt: at, serpDepth: 100, organicResults: 100, unattributed: 0, fromWeb: false, positions });
  const pos = (domain, position) => ({ domain, position, url: null, shownAs: null, results: position ? 1 : 0 });
  writeCheck(st.db, 'sim rig', 2840, sp('2026-11-01 10:00:00', [pos('a.com', 1), pos('b.com', 5)]), { cost: 0.0175, cached: false });
  writeCheck(st.db, 'sim rig', 2840, sp('2026-12-01 10:00:00', [pos('b.com', 3)]), { cost: 0.0175, cached: false });
  const v = readTrackedPositions(st.db, { locationCode: 2840 })[0];
  check('the list shows only domains measured in the latest check (no stale a.com under the December date)', v.lastCheckedAt === '2026-12-01 10:00:00' && v.positions.map(p => p.domain).join() === 'b.com', JSON.stringify(v.positions.map(p => [p.domain, p.checkedAt])));
  writeCheck(st.db, 'sim rig', 2840, sp('2026-12-01 10:00:00', [pos('b.com', 3)]), { cost: 0, cached: true });
  const c = st.db.prepare(`SELECT cost, cached FROM keyword_check WHERE checked_at = '2026-12-01 10:00:00'`).get();
  check('a cache-hit re-check keeps the paid check row', c.cost === 0.0175 && c.cached === 0, JSON.stringify(c));
  st.close(); rmSync(dir);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
