// Copyright (c) 2026 Richard Baxter / Houtini — Apache-2.0 (see LICENSE)
import { AuditDatabase } from './AuditDatabase.js';
import { dbPathFor } from './paths.js';
import { urlKey, hostFormForProperty } from './url-key.js';
import { gscFreshness } from './gscFreshness.js';
import { fetchCompetitorContent, routeFor } from './reconResearch.js';
import { fetchOwnPage } from './reconFetch.js';
import { parseSerpForRecon, reconVerdict } from './serpRecon.js';
import type { DataForSeoClient } from './DataForSeoClient.js';
import { dashboardServerUrl } from './webServer.js';
import { selectReconTargets, deterministicTodos, persistReconPage, insertTodos, pageState, crawlRealityOverride, clusterCannibalisation, opportunityBasis } from '../audit/recon.js';

/** recon_targets' arguments, as stored on a queued job (#56). */
export interface ReconJobArgs {
  siteUrl: string;
  limit?: number;
  minImpressions?: number;
  location?: string | number;
  urls?: string[];
  scrapeCompetitors?: boolean;
  competitorLimit?: number;
  crawlAs?: 'browser' | 'googlebot';
}

// The same dashboard pointer server.ts appends to tool output. In the MCP process it names the
// live dashboard server; in the job runner (no served port) it names get_dashboard and friends.
function browserLink(siteUrl?: string): string {
  const base = dashboardServerUrl();
  if (base) return `\n\n📊 Browser dashboard: ${base}/dashboard${siteUrl ? `?siteUrl=${encodeURIComponent(siteUrl)}` : ''}`;
  return `\n\n📊 See it in the dashboard — run get_dashboard${siteUrl ? ` for ${siteUrl}` : ''} (interactive, in chat), serve_dashboard (browser tab), or export_report (shareable HTML).`;
}

// Strip any scheme/sc-domain:/path down to a bare host (same rule as server.ts's dfsHost).
const dfsHost = (t: string): string =>
  t.trim().replace(/^sc-domain:/, '').replace(/^https?:\/\//, '').replace(/[/?#].*$/, '').replace(/^www\./, '').toLowerCase();

/**
 * The recon_targets job body: per target page, our live page + the live SERP → a verdict, to-dos
 * and (optionally) the fetched competitors. Lifted out of server.ts unchanged so the job can run
 * from its stored arguments, in the MCP process or in the job runner (#56).
 */
export async function runReconJob(
  dataDir: string,
  client: DataForSeoClient,
  args: ReconJobArgs,
  update: (p: Record<string, unknown>) => void,
  signal: AbortSignal,
): Promise<unknown> {
  const { siteUrl, limit, minImpressions, location, urls, scrapeCompetitors, competitorLimit, crawlAs } = args;
  const db = new AuditDatabase(dbPathFor(dataDir, siteUrl));
  try {
    const fresh = gscFreshness(db.db);
    if (!fresh.effectiveMax) return { siteUrl, empty: true, note: 'No synced GSC data — run refresh_property first.' };
    const today = new Date().toISOString().slice(0, 10);
    const ownDomain = dfsHost(siteUrl);
    const hostForm = hostFormForProperty(siteUrl) ?? 'asis';
    const SERP_DEPTH = 20;
    // Every GSC number below is this window and only this window. Undeclared, a 28-day figure
    // read against an all-time baseline looks exactly like a decline.
    const windowStart = db.db.prepare(`SELECT date(?, '-27 days') d`).get(fresh.effectiveMax) as { d: string };
    const gscWindow = { start: windowStart.d, end: fresh.effectiveMax, days: 28, metric: 'Search Console, last 28 days of synced data (not all-time)' };

    let targets;
    if (urls?.length) {
      targets = [];
      for (const u of urls) {
        const key = urlKey(u, { hostForm });
        const row = db.db.prepare(`SELECT query, SUM(impressions) imp, SUM(clicks) clk, SUM(position*impressions)*1.0/NULLIF(SUM(impressions),0) pos
          FROM gsc_rows WHERE page_key=? AND query IS NOT NULL AND date > date(?, '-28 days') AND date <= ? GROUP BY query ORDER BY imp DESC LIMIT 1`)
          .get(key, fresh.effectiveMax, fresh.effectiveMax) as { query: string; imp: number; clk: number; pos: number } | undefined;
        if (row?.query) targets.push({ urlKey: key, query: row.query, impressions: row.imp, clicks: row.clk, position: Math.round(row.pos * 10) / 10, priorPosition: null, slipped: false, competingUrls: 0 });
      }
    } else {
      targets = selectReconTargets(db.db, { ...(limit != null ? { limit } : {}), ...(minImpressions != null ? { minImpressions } : {}), maxDate: fresh.effectiveMax });
    }
    if (!targets.length) return { siteUrl, targets: [], note: `No recon targets (declining/striking pages, position 3-15, ${minImpressions ?? 300}+ impressions). Lower minImpressions or pass urls.` };

    const results: any[] = [];
    let cost = 0;
    for (let i = 0; i < targets.length; i++) {
      if (signal.aborted) break;
      const t = targets[i];
      update({ phase: 'recon', done: i, total: targets.length, current: t.urlKey });
      let own = null;
      try { own = await fetchOwnPage(t.urlKey, hostForm === 'asis' ? 'asis' : hostForm); } catch { /* page unreachable — classify on SERP alone */ }
      const serpResp = await client.serpOrganic(t.query, location, 'en', SERP_DEPTH, { loadAsyncAiOverview: true, resolvePoisonedResults: true });
      cost += serpResp.cost;
      const serp = parseSerpForRecon(serpResp, ownDomain, SERP_DEPTH);
      // The crawl row overrides the SERP/GSC read: GSC keeps reporting impressions for URLs
      // that have since been canonicalised away or set noindex.
      const state = pageState(db.db, t.urlKey);
      const serpVerdict = reconVerdict(serp);
      const verdict = crawlRealityOverride(serpVerdict, state) ?? serpVerdict;
      const cluster = clusterCannibalisation(db.db, t.query, fresh.effectiveMax);
      const basis = opportunityBasis(t.impressions, serp.ourOrganicRank, t.position, verdict.verdict);
      const baseline = { organicRank: serp.ourOrganicRank, serpDepth: SERP_DEPTH, aioCitesUs: serp.aioCitesUs, gscPosition: t.position, gscImpressions: t.impressions, window: gscWindow, at: today };
      persistReconPage(db.db, {
        urlKey: t.urlKey, query: t.query, verdict: verdict.verdict, verdictNote: verdict.note,
        organicRank: serp.ourOrganicRank, gscPosition: t.position, gscImpressions: t.impressions,
        aioPresent: serp.aioPresent, aioCitesUs: serp.aioCitesUs, videoPresent: serp.videoPresent,
        hasProductSchema: own?.hasProductOrReview ?? false, schemaTypes: own?.jsonLdTypes ?? [],
        competitors: { organicAbove: serp.organicAbove, aioReferences: serp.aioReferences, videoItems: serp.videoItems },
      });
      const todos = own ? deterministicTodos(t, own, serp, verdict, today, { state, cluster }) : [];
      const inserted = todos.length ? insertTodos(db.db, t.urlKey, t.query, todos, baseline, 'auto') : 0;

      let competitorContent: any = undefined;
      let competitorFetch: any = undefined;
      // No API keys are needed: every route is a free fetch. (It used to be gated on a
      // paid-fetcher key, so without one scrapeCompetitors:true silently did nothing -
      // including the keyless Reddit and plain-HTTP paths it advertised.)
      if (scrapeCompetitors) {
        // Build a routed candidate set: organic-above + AI-Overview references + the ranking
        // videos, deduped, our own domain removed. Each URL routes by HOST (Reddit→.json,
        // video→listed not fetched, else→browser-profile fetch). What we don't fetch is
        // REPORTED, not silently dropped — an undeclared cap of 3 is what made this look like
        // it returned nothing.
        const seen = new Set<string>();
        const candidates: { url: string; from: string; route: string }[] = [];
        const add = (url: string | undefined, from: string) => {
          if (url && !seen.has(url) && dfsHost(url) !== ownDomain) { seen.add(url); candidates.push({ url, from, route: routeFor(url) }); }
        };
        serp.organicAbove.forEach(o => add(o.url, `organic #${o.rank}`));
        serp.aioReferences.slice(0, 6).forEach(r => add(r.url, 'aio-reference'));
        serp.videoItems.slice(0, 2).forEach(v => add(v.url, 'video-pack'));

        const lim = competitorLimit ?? 5;
        // Video can't be read over HTTP (a player shell), so ranking videos don't spend a
        // fetch slot: they're listed for the research session to watch. Every slot goes to an
        // editorial page or thread, organic-above first - the pages actually worth diffing.
        const videos = candidates.filter(c => c.route === 'video');
        const readable = candidates.filter(c => c.route !== 'video');
        const chosen = readable.slice(0, lim);
        const skipped = readable.slice(lim);

        competitorContent = [];
        for (const c of chosen) {
          competitorContent.push(await fetchCompetitorContent(c.url, { maxChars: 4000, ua: crawlAs }));
        }
        const notes = [
          skipped.length ? `${skipped.length} identified competitor page(s) not fetched (competitorLimit ${lim}) — raise competitorLimit or fetch them directly.` : '',
          videos.length ? `${videos.length} ranking video(s) listed, not fetched (no readable text over HTTP) — watch them; video often wins these SERPs.` : '',
        ].filter(Boolean);
        competitorFetch = {
          limit: lim,
          identified: candidates.length,
          attempted: chosen.length,
          fetched: competitorContent.filter((c: any) => !c.error && c.content).length,
          failed: competitorContent.filter((c: any) => c.error).length,
          empty: competitorContent.filter((c: any) => !c.error && !c.content).length,
          routes: chosen.map(c => ({ url: c.url, from: c.from, route: c.route })),
          skipped: skipped.map(c => ({ url: c.url, from: c.from, route: c.route })),
          videos: videos.map(c => ({ url: c.url, from: c.from })),
          note: notes.length ? notes.join(' ') : undefined,
        };
      }

      results.push({
        urlKey: t.urlKey, query: t.query, window: gscWindow,
        impressions: t.impressions, gscPosition: t.position, priorPosition: t.priorPosition, slipped: t.slipped,
        organicRank: serp.ourOrganicRank, serpDepth: SERP_DEPTH,
        organicRankNote: serp.ourOrganicRank == null ? `absent from the top ${SERP_DEPTH} organic results — position beyond ${SERP_DEPTH} was not measured` : undefined,
        aioPresent: serp.aioPresent, aioCitesUs: serp.aioCitesUs, aioResolved: serp.aioResolved, aioAsync: serp.aioAsync,
        aioNote: serp.aioCitesUs == null && serp.aioPresent ? 'AI Overview present but citations unresolved — citation status UNKNOWN, not "not cited"' : undefined,
        videoPresent: serp.videoPresent,
        verdict: verdict.verdict, verdictNote: verdict.note,
        ...(verdict.verdict === 'page-cannot-rank' ? { serpVerdict: serpVerdict.verdict, serpVerdictNote: serpVerdict.note } : {}),
        pageState: state, priorityBasis: basis, cannibalisationCluster: cluster,
        ownHeadings: own?.headings.map(h => h.heading) ?? null, schemaTypes: own?.jsonLdTypes ?? null, hasProductSchema: own?.hasProductOrReview ?? null, dateModified: own?.dateModified ?? null,
        todos, todosInserted: inserted,
        competitors: { organicAbove: serp.organicAbove, aioReferences: serp.aioReferences, videoItems: serp.videoItems },
        ...(competitorContent ? { competitorContent, competitorFetch } : {}),
      });
    }
    update({ phase: 'done', done: results.length, total: targets.length });

    const md = `# Content recon — ${siteUrl}\n\n${results.length} page(s), ${results.reduce((s, r) => s + r.todosInserted, 0)} to-dos saved. DataForSEO SERP cost $${cost.toFixed(4)}.\n` +
      `All Search Console figures below are **${gscWindow.start} to ${gscWindow.end}** (28 days) — not all-time; SERP ranks are live at depth ${SERP_DEPTH} organic.\n\n` +
      results.map(r => {
        const aio = !r.aioPresent ? 'no AIO'
          : r.aioCitesUs == null ? 'AIO: citation UNKNOWN (unresolved)'
          : r.aioCitesUs ? 'AIO: cited' : `AIO: NOT cited (${r.competitors.aioReferences.length} refs checked)`;
        const flags = [aio, r.videoPresent ? 'video pack' : null].filter(Boolean).join(' · ');
        const rank = r.organicRank != null ? `organic #${r.organicRank}` : `not in the top ${SERP_DEPTH} organic`;
        const cann = r.cannibalisationCluster?.cannibalising ? `\nCluster overlap: ${r.cannibalisationCluster.urls.length} of your URLs across "${r.cannibalisationCluster.core.join(' ')}", colliding on ${r.cannibalisationCluster.collidingQueries} of ${r.cannibalisationCluster.clusterQueries} queries.` : '';
        const cf = r.competitorFetch
          ? `\nCompetitors: ${r.competitorFetch.fetched}/${r.competitorFetch.attempted} fetched of ${r.competitorFetch.identified} identified (limit ${r.competitorFetch.limit})${r.competitorFetch.skipped.length ? `; skipped ${r.competitorFetch.skipped.map((s: any) => s.url).join(', ')}` : ''}.` +
            (r.competitorFetch.videos?.length ? `\nRanking videos (watch these; not fetched): ${r.competitorFetch.videos.map((v: any) => v.url).join(', ')}` : '')
          : '';
        return `## ${r.urlKey}\n"${r.query}" — ${rank} (GSC avg ${r.gscPosition}${r.slipped ? `, slipped from ${r.priorPosition}` : ''}), ${r.impressions} impr. ${flags}\n` +
          `**${r.verdict}** — ${r.verdictNote}\nOpportunity: ~${r.priorityBasis.opportunityClicks} clicks/28d if it moved from ${r.priorityBasis.position} (${r.priorityBasis.positionSource}) to ${r.priorityBasis.targetPosition}.${cann}${cf}\n` +
          (r.todos.length ? '\nTo do:\n' + r.todos.map((t: any) => `- [${t.type}] ${t.action}`).join('\n') : '');
      }).join('\n\n') +
      (() => {
        const blocked = results.flatMap(r => (r.competitorContent ?? []).filter((c: any) => c.error) as any[]);
        if (!blocked.length) return '';
        return `\n\n${blocked.length} competitor(s) couldn't be fetched (bot-protection like Cloudflare, a block, or a fetch error): ${blocked.slice(0, 5).map(c => `${c.url} [${c.via}: ${c.error}]`).join('; ')}. If one matters, paste its copy here or drop a text file and I'll diff it in.`;
      })() +
      `\n\nNext: research the competitors (transcribe the videos, read the reachable pages), write gaps back with save_recon_todo, and track with recon_todos.` + browserLink(siteUrl);
    // The poll (check_sync_status) injects this result into the model's context, which the
    // host caps (~25k tokens). The full per-page detail (heading lists, competitor URL arrays,
    // full to-do objects, cannibalisation clusters) is already persisted to the ledger and read
    // back via recon_todos, so the job result returns the readable `summary` plus a SLIM per-page
    // view — verdict, ranks, opportunity — and keeps only competitorContent (the scraped research
    // payload, which lives nowhere else). This keeps a 10-page poll well under the cap.
    const slimTargets = results.map(r => ({
      urlKey: r.urlKey, query: r.query, window: r.window,
      impressions: r.impressions, gscPosition: r.gscPosition, priorPosition: r.priorPosition, slipped: r.slipped,
      organicRank: r.organicRank, serpDepth: r.serpDepth, organicRankNote: r.organicRankNote,
      aioPresent: r.aioPresent, aioCitesUs: r.aioCitesUs, aioResolved: r.aioResolved, aioNote: r.aioNote, videoPresent: r.videoPresent,
      verdict: r.verdict, verdictNote: r.verdictNote,
      opportunityClicks: r.priorityBasis?.opportunityClicks, positionSource: r.priorityBasis?.positionSource, targetPosition: r.priorityBasis?.targetPosition,
      hasProductSchema: r.hasProductSchema, dateModified: r.dateModified, todosInserted: r.todosInserted,
      ...(r.competitorContent ? { competitorContent: r.competitorContent, competitorFetch: r.competitorFetch } : {}),
    }));
    return { siteUrl, cost, window: gscWindow, serpDepth: SERP_DEPTH, targets: slimTargets, summary: md };
  } finally { db.close(); }
}
