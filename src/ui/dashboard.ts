import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';
import {
  esc, fmtNum, fmtCompact, fmtDate, fmtMonth, fmtWeek, icons, sevBadge, statusBadge, badge, kpiGrid, filterGroup,
  attachSort, accordionItem, accordionSection, accordionControls,
  EChartWrapper, chartPalette, axisDefaults, tooltipDefaults, emptyState, countDelta, rankDelta,
} from './lib/index.js';
import { shareText, sharePct, quickWinsEmptyReason, trappedEmptyReason, CATEGORY_LABEL, categoryLabel, breakdownsEmptyReason as emptyBreakdowns } from '../core/displayRules.js';
import { TITLE_MAX_CHARS, META_DESC_MAX_CHARS } from '../core/onPageLimits.js';
import { renderSearchTop, renderHealthTop, renderSideFreshness, drawNetwork, isolatedText, pctChg, SEV_ORDER, SEV_LABEL, type OverviewCtx } from './panels.js';
import { renderSummary, aiSignalsHtml, type SummaryCtx } from './summary.js';
import { renderFieldCwv } from './cwv.js';
import { buildDomainPicker, showDomainsView, showWatchedDomain, setupOverviewTabs, setupActions, repaintDomainViews, type WebBoot } from './shell.js';

// Local view types (avoid importing core, which pulls node-only deps into the bundle).
interface Totals { clicks: number; impressions: number; ctr: number; position: number }
export interface DashboardData {
  siteUrl: string;
  freshness?: { sources: { kind: string; state: string; at: string | null; detail: string; error?: string | null }[]; crawlRuns: unknown[]; shownCrawl?: { crawlId: string; status: string; at: string | null; partial: boolean } };
  empty?: boolean;
  linkProspects?: { domain: string; intersections: number; linkedTargets: string[]; domainTrust: number | null; spamScore: number | null; dofollow: boolean; trustFlow: number | null; citationFlow: number | null; topTopic: string | null; competitors: string[]; fetchedAt: string | null }[];
  apiKeys?: { dataforseo: boolean; majestic: boolean };
  trappedAuthority?: { url: string; referringDomains: number; backlinks: number; clickDepth: number | null; ipr: number; trustFlow: number | null; topTopic: string | null }[];
  backlinkProfile?: {
    summary: { backlinks: number; referringDomains: number; domainRank: number | null; brokenBacklinks: number; brokenPages: number; nofollowPct: number | null; fetchedAt: string | null } | null;
    topPages: { url: string; backlinks: number; referringDomains: number; dofollow: number; status: number | null; trustFlow: number | null }[];
    brokenPages: { url: string; backlinks: number; referringDomains: number; status: number }[];
    pagesTotal: number; pagesUnchecked: number;
    referringDomains: { snapshotAt: string; live: number; lost: number; top: { domain: string; rank: number | null; backlinks: number; referringPages: number; nofollowPages: number; spamScore: number | null; firstSeen: string | null }[] } | null;
    anchors: { snapshotAt: string; mix: { kind: string; anchors: number; backlinks: number; referringDomains: number }[]; top: { anchor: string; kind: string; backlinks: number; referringDomains: number }[] } | null;
    history: { fetchedAt: string | null; months: { month: string; newDomains: number; lostDomains: number; referringDomains: number | null; backlinks: number | null; days: number }[] } | null;
  } | null;
  dateRange?: { current: string; prior?: string; maxDate: string; rawMaxDate?: string; trimmedDays?: number; days?: number; minDate?: string | null };
  summary?: { current: Totals; prior: Totals };
  rankTrend?: { date: string; clicks: number; impressions: number; position: number }[];
  rankingDistribution?: { date: string; b1: number; b2: number; b3: number; b4: number }[];
  strikingDistance?: { query: string; position: number; impressions: number; clicks: number }[];
  quickWins?: { query: string; position: number; impressions: number; clicks: number; ctr: number; expectedCtr: number; type: 'striking' | 'snippet' | 'serp' | 'ok'; potential: number }[];
  contentDecay?: { urlKey: string; prevClicks: number; clicks: number; lost: number; dropPct: number; impressions: number; position: number }[];
  cannibalisationTable?: { query: string; urlCount: number; totalImpressions: number; totalClicks: number; verdict: 'split' | 'dominant'; crossType: boolean; urls: { url: string; impressions: number; clicks: number; position: number; template: string }[] }[];
  brandedSplit?: { brand: string; variants?: string[]; uncertain?: { spellings: string[]; queries: number; impressions: number; clicks: number; joinedImpressions: number; joinedClicks: number } | null; branded: { clicks: number; impressions: number }; nonBranded: { clicks: number; impressions: number }; priorBrandedClicks: number; priorNonBrandedClicks: number };
  topKeywords?: { query: string; clicks: number; prevClicks: number; clicksChange: number; position: number; prevPosition: number }[];
  rankHistory?: { period: string; pos_1_3: number; pos_4_10: number; pos_11_20: number; pos_21_100: number; etv: number; keyword_count: number }[];
  dateAlignment?: { note: string };
  deviceBreakdown?: { device: string; clicks: number; prevClicks: number; impressions: number; ctr: number; position: number }[];
  countryBreakdown?: { country: string; clicks: number; prevClicks: number; impressions: number }[];
  segmentsLastDate?: string | null;
  breakdownWindowStart?: string;
  pagePerformance?: { urlKey: string; clicks: number; prevClicks: number; clicksChangePct: number | null; impressions: number; position: number; category: string }[];
  keywordMovement?: { query: string; firstPos: number; lastPos: number; delta: number; firstDate: string; lastDate: string; category: string }[];
  findings?: { runId: string; total: number; finishedAt: string | null; byCheck: any[]; top: any[]; recommendations?: any[] } | null;
  topLinkedPages?: { url: string; inlinks: number; status: number | null; indexable: boolean; reason: string | null }[];
  crawlHealth?: {
    responseCodes: { label: string; count: number }[];
    indexability: { label: string; count: number }[];
    speed: { label: string; count: number }[];
    htmlSize: { label: string; count: number }[];
    depth: { label: string; count: number }[];
    titles: { label: string; count: number }[];
    metas: { label: string; count: number }[];
    onPage: { label: string; count: number }[];
    serverErrors: { url: string; status: number }[];
    slowPages: { url: string; ms: number }[];
    largeImages: { url: string; kb: number; usedOn: number }[];
    imageStats: { sampled: number; over100kb: number; over300kb: number } | null;
    totalPages: number;
  };
}

const $ = (id: string): HTMLElement => document.getElementById(id)!;
const fmt = fmtNum;
const safeJson = (s: string): any => { try { return JSON.parse(s || '{}'); } catch { return {}; } };
const catClass = (c: string): string => /(top performer|gained|entered)/.test(c) ? 'cat-up' : /(low performer|lost|dropped)/.test(c) ? 'cat-down' : /declining/.test(c) ? 'cat-warn' : /improve/.test(c) ? 'cat-info' : 'cat-neutral';
const tableHtml = (headers: string[], rows: string[]): string => `<table><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
// Domain-stripped path, middle-truncated when long so the meaningful slug END survives (an SEO
// reads the page identifier at the end of the path - never truncate that off). Callers esc() it.
const shortPath = (u: string, max = 56): string => {
  const p = (u || '').replace(/^https?:\/\/[^/]+/, '') || '/';
  if (p.length <= max) return p;
  const keep = Math.floor((max - 1) / 2);
  return `${p.slice(0, keep)}…${p.slice(-keep)}`;
};

/** Category-axis label width (px): ~40% of the content width, capped, so long labels truncate
 *  with an ellipsis instead of being clipped at the card edge on a phone. */
const labelW = (max: number): number => {
  const cw = (document.getElementById('content')?.clientWidth || 900) - 48;
  return Math.max(70, Math.min(max, Math.round(cw * 0.4)));
};
const catAxis = (axis: any, max: number): any => ({ ...axis, axisLabel: { ...axis.axisLabel, width: labelW(max), overflow: 'truncate' } });
/** Ordered position buckets: categorical hues, not status colours (top-3 isn't "healthy"). */
const bucketColors = (col: any): string[] => [col.categorical[2], col.categorical[0], col.categorical[1], getComputedStyle(document.documentElement).getPropertyValue('--chart-context').trim() || col.grey];

// Chart palette - the semantic tokens plus the names the render code reads.
function palette() {
  const c = chartPalette();
  return {
    ...c,
    green: c.success, red: c.danger, amber: c.warning,
    blue: c.categorical[0], teal: c.categorical[4], violet: c.categorical[5], grey: c.categorical[7],
  };
}

// One EChartWrapper per chart element - lifecycle (ResizeObserver, theming,
// echarts.connect groups) lives in the wrapper; re-renders re-tint in place.
const chartsReg = new Map<string, EChartWrapper>();
function wrap(id: string, group?: string): EChartWrapper {
  let w = chartsReg.get(id);
  if (!w) { w = new EChartWrapper(id, { group }); chartsReg.set(id, w); }
  return w;
}


const csvCell = (v: unknown): string => `"${String(v ?? '').replace(/"/g, '""')}"`;
const toCsv = (rows: unknown[][]): string => rows.map(r => r.map(csvCell).join(',')).join('\r\n');

/** Brief visible notice (top-centre) - so download success/failure is never silent. */
function toast(msg: string, kind: 'ok' | 'warn' = 'ok'): void {
  const t = document.createElement('div');
  t.textContent = msg;
  t.style.cssText =
    'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:9999;' +
    'padding:10px 16px;border-radius:8px;font-size:13px;max-width:90%;' +
    'box-shadow:0 4px 16px rgba(0,0,0,.25);color:#fff;' +
    `background:${kind === 'ok' ? 'var(--color-accent,#2563eb)' : 'var(--color-warning,#b45309)'};`;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4200);
}

/** Copy text in a sandboxed iframe: clipboard API where allowed, else a hidden-textarea execCommand. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through to execCommand */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

// Direct <a download> blob clicks are blocked inside MCP-App sandboxed iframes - that's why the
// host exposes ui/download-file. We use it only when the host advertises the capability; otherwise
// we fall back to copying the CSV to the clipboard, and we always surface the outcome via a toast.
async function downloadCsv(filename: string, rows: unknown[][]): Promise<void> {
  const csv = toCsv(rows);

  // Standalone export or web mode (a real browser, not an MCP host): a normal blob download works.
  if ((window as any).__DASH_FIXTURE__ || __sacWeb) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
    return;
  }

  // In an MCP host: only call downloadFile if the host says it supports it.
  if (app.getHostCapabilities()?.downloadFile) {
    try {
      const r = await app.downloadFile({
        contents: [{ type: 'resource', resource: { uri: `file:///${filename}`, mimeType: 'text/csv', text: csv } }],
      });
      if (!r?.isError) { toast(`Saved ${filename}`); return; }
    } catch (e) { console.warn('downloadFile failed', e); }
    // denied / cancelled / threw → fall through to clipboard so the data isn't lost
  }

  const copied = await copyText(csv);
  toast(
    copied
      ? `This host can't save files - ${filename} copied to clipboard (paste into a .csv)`
      : `This host can't save files and clipboard is blocked - use “Export report” for a downloadable file`,
    'warn',
  );
}

let currentData: DashboardData | null = null;
// The full Network force layout is expensive; when its tab is hidden at render time the draw is
// deferred until the tab is first shown.
let pendingNetworkDraw: (() => void) | null = null;
const ARIA = { aria: { enabled: true } }; // ECharts-generated screen-reader description

const app = new App({ name: 'SEO Audit Console', version: '0.1.0' });

// Web mode: served by the local serve_dashboard webserver - data comes over plain HTTP
// from the same origin instead of the MCP-App host bridge. No host, no sandbox, no cache.
const __sacWeb = (window as any).__SAC_WEB__ as WebBoot | undefined;

/** One data path for both worlds: /api/call in web mode, app.callServerTool under an MCP host. */
async function callServer(name: string, args: Record<string, unknown>): Promise<any> {
  if (__sacWeb) {
    const r = await fetch('/api/call', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, arguments: args }),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => null) as { error?: string } | null;
      throw new Error(body?.error ?? `HTTP ${r.status}`);
    }
    return await r.json();
  }
  return app.callServerTool({ name, arguments: args });
}

function applyHostContext(ctx: { theme?: 'light' | 'dark'; styles?: { variables?: Record<string, string> } } | undefined) {
  if (!ctx) return;
  if (ctx.theme) {
    applyDocumentTheme(ctx.theme);
    document.documentElement.classList.toggle('dark', ctx.theme === 'dark');
  }
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
}

app.onhostcontextchanged = (ctx) => {
  applyHostContext(ctx as any);
  if (currentData) render(currentData); // re-tint charts for the new theme
  repaintDomainViews();
};

// get_dashboard returns only { siteUrl } (keeps the big payload out of the model context).
// The widget fetches the full dataset itself via the app-only get_dashboard_data tool -
// results route to the iframe, bypassing the model token cap.
let dataLoaded = false;
/** The Search Console window (days) the non-Summary tabs compare: current N days vs the N before. */
const WINDOWS = [7, 28, 90, 180];
let winDays = ((): number => { const d = Number(new URLSearchParams(location.search).get('days')); return WINDOWS.includes(d) ? d : 28; })();
let loadedSite = '';
async function loadDashboard(siteUrl: string): Promise<void> {
  if (dataLoaded || !siteUrl) return;
  dataLoaded = true;
  if (!loadedSite) setupOverviewTabs(siteUrl, callServer, () => (currentData ? aiSignalsHtml(currentData) : ''));
  loadedSite = siteUrl;
  // A cold build after a sync can take a minute on a big property: say so instead of a bare spinner.
  const slow = setTimeout(() => {
    const l = document.getElementById('loading');
    if (l && l.style.display !== 'none') l.textContent = 'Building the dashboard from the latest data. The first load after a sync, crawl or audit can take a minute on a large property; later loads are instant.';
  }, 4000);
  try {
    const res = await callServer('get_dashboard_data', { siteUrl, ...(winDays !== 28 ? { days: winDays } : {}) });
    const data = res?.structuredContent as DashboardData | undefined;
    if (!data) throw new Error('no data');
    clearTimeout(slow);
    currentData = data;
    render(data);
  } catch (e) {
    clearTimeout(slow);
    dataLoaded = false; // allow a retry on a later tool result
    $('loading').style.display = 'none';
    const empty = $('empty');
    empty.style.display = 'flex';
    empty.textContent = `Couldn’t load dashboard data${e instanceof Error ? ` (${e.message})` : ''}. Run refresh_property, then reopen.`;
  }
}

app.ontoolresult = (result) => {
  const sc = result.structuredContent as { siteUrl?: string; empty?: boolean } | undefined;
  if (sc?.siteUrl) loadDashboard(sc.siteUrl);
};

// Window/container resizes are handled per-chart by the wrapper's ResizeObserver.

// One label per area, shared with the Summary and the run_audit report (displayRules.ts).
const CAT_LABEL: Record<string, string> = CATEGORY_LABEL;

// Turn a finding's evidence JSON into a one-line, human example of the problem.
function evidenceSummary(ev: Record<string, unknown>): string {
  if (!ev || typeof ev !== 'object') return '';
  const issues = (ev as any).issues;
  if (Array.isArray(issues)) {
    const first = issues[0]?.detail ?? '';
    return issues.length > 1 ? `${first} (+${issues.length - 1} more)` : first;
  }
  return Object.entries(ev)
    .filter(([, v]) => v != null && typeof v !== 'object')
    .slice(0, 3).map(([k, v]) => `${k}: ${v}`).join(', ');
}

// Human labels for the evidence keys our checks emit (the rest fall back to a camelCase splitter).
const FI_LABEL: Record<string, string> = {
  competingUrls: 'Competing URLs', expectedCtr: 'Expected CTR', ctr: 'CTR', position: 'Position', positions: 'Position range',
  inboundInContentLinks: 'Inbound in-content links', linkingPages: 'Linking pages', impressionsChange: 'Impressions change',
  previousImpressions: 'Prev impressions', currentImpressions: 'Current impressions', previousClicks: 'Prev clicks',
  currentClicks: 'Current clicks', previousPosition: 'Prev position', currentPosition: 'Current position',
  slippedBy: 'Slipped by', clicksLost: 'Clicks lost', dropPercent: 'Drop', dropPct: 'Drop', h1Count: 'H1 count', titleLength: 'Title length',
};
// Long/free-text evidence reads better as a full-width note than a stat chip.
const FI_NOTE_KEYS = new Set(['note', 'metaDescription', 'title', 'googleCanonical', 'userCanonical', 'found']);
const humanizeKey = (k: string): string =>
  FI_LABEL[k] ?? ((s) => s.charAt(0).toUpperCase() + s.slice(1))(k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' '));
const fmtEvVal = (k: string, v: unknown): string =>
  typeof v === 'number' ? (/position/i.test(k) ? v.toFixed(1) : fmt(v)) : String(v);

// The expanded row: the full recommendation (untruncated) + every evidence field as a readable
// snapshot - stat chips for scalars, notes for free text - plus traffic-at-risk and the effort/payoff.
function findingDetailHtml(f: any): string {
  const rec = safeJson(f.recommendation), ev = safeJson(f.evidence) as Record<string, unknown>;
  const traf = safeJson(f.traffic_at_risk), eff = safeJson(f.effort);
  const chips: string[] = [], notes: string[] = [];
  for (const [k, v] of Object.entries(ev)) {
    if (v == null || typeof v === 'object') continue;
    if (k === 'query' || k === 'url') continue; // query is in the row label; url is linked below
    const sv = String(v);
    if (FI_NOTE_KEYS.has(k) || sv.length > 48) {
      const val = (k === 'googleCanonical' || k === 'userCanonical') ? `<code>${esc(sv)}</code>` : esc(sv);
      notes.push(`<div class="fi-note"><span class="fi-k">${esc(humanizeKey(k))}</span> ${val}</div>`);
    } else {
      chips.push(`<div class="fi-stat"><span class="fi-v">${esc(fmtEvVal(k, v))}</span><span class="fi-k">${esc(humanizeKey(k))}</span></div>`);
    }
  }
  const issues = (ev as any).issues;
  if (Array.isArray(issues) && issues.length) {
    notes.push(`<div class="fi-note"><span class="fi-k">Issues</span> ${issues.slice(0, 6).map((i: any) => esc(String(i?.detail ?? i))).join('; ')}${issues.length > 6 ? ` (+${issues.length - 6} more)` : ''}</div>`);
  }
  const meta: string[] = [];
  if (traf.clicks != null || traf.impressions != null) {
    meta.push(`<span class="fi-m"><b>${fmt(traf.clicks || 0)}</b> clicks · <b>${fmt(traf.impressions || 0)}</b> impr${traf.position != null ? ` · pos <b>${Number(traf.position).toFixed(1)}</b>` : ''} <span class="fi-mlbl">at risk</span></span>`);
  }
  if (eff && (eff.hours || eff.expectedClicks)) {
    meta.push(`<span class="fi-m">~<b>${eff.hours || 0}</b>h · ≈<b>${fmt(Math.round(eff.expectedClicks || 0))}</b> clicks${eff.fixType ? ` · ${esc(String(eff.fixType))}` : ''} <span class="fi-mlbl">payoff</span></span>`);
  }
  const url = f.url_key ? `<a class="fi-link" href="${esc(f.url_key)}" target="_blank" rel="noopener">${esc(f.url_key)}</a>` : '';
  return `<div class="fi-detail">` +
    (rec.text ? `<p class="fi-rec">${esc(rec.text)}</p>` : '') +
    (chips.length ? `<div class="fi-grid">${chips.join('')}</div>` : '') +
    notes.join('') +
    (meta.length || url ? `<div class="fi-meta">${meta.join('')}${url}<code class="fi-check">${esc(f.check_id)}</code></div>` : '') +
    `</div>`;
}

// Branded vs non-branded split - transparent brand match, surfaced so the user can verify it.
function renderBrandedSplit(data: DashboardData): void {
  const el = $('brandedSplit'); if (!el) return;
  const b = data.brandedSplit;
  if (!b) { el.innerHTML = '<p class="muted">Brand could not be auto-detected from this property.</p>'; return; }
  const hint = $('brandedHint');
  const un = b.uncertain;
  if (hint) hint.innerHTML = `Branded = queries that spell <strong>“${esc(b.brand)}”</strong> in whole words (auto-detected from the domain${b.variants?.length ? `; counted: ${b.variants.map(v => `“${esc(v)}”`).join(', ')}` : ''}). How much of your demand is people looking for you vs discovering you - last ${winDays} days.` +
    (un ? ` <span class="brand-uncertain" title="${esc(`On an exact-match domain the spaced spelling is also the generic search, so it counts as brand only when people also search the brand as one word: spaced spellings are set aside when they draw more impressions than the one-word brand and the one-word brand has earned no click. Here: ${fmt(un.impressions)} impressions on the spaced spelling, ${fmt(un.joinedImpressions)} and ${fmt(un.joinedClicks)} clicks on the one-word brand, over the held history.`)}"><strong>Uncertain (exact-match domain):</strong> ${un.spellings.map(v => `“${esc(v)}”`).join(', ')} (${fmt(un.queries)} quer${un.queries === 1 ? 'y' : 'ies'}) counted as non-brand - it is also the generic search, and nobody has clicked the brand typed as one word.</span>` : '');
  const bc = b.branded.clicks, nc = b.nonBranded.clicks, tc = bc + nc;
  const bpct = tc ? (bc / tc) * 100 : 0, npct = tc ? 100 - bpct : 0;
  el.innerHTML =
    `<div class="split-bar"><span class="split-branded" style="width:${bpct}%"></span><span class="split-nonbranded" style="width:${npct}%"></span></div>` +
    `<div class="split-legend">` +
    `<div class="split-item"><span class="split-dot dot-branded"></span><div><div class="split-k">Branded · ${shareText(bc, tc)}%</div><div class="split-v">${fmt(bc)} clicks ${countDelta(bc, b.priorBrandedClicks)} · ${fmt(b.branded.impressions)} impr</div></div></div>` +
    `<div class="split-item"><span class="split-dot dot-nonbranded"></span><div><div class="split-k">Non-branded · ${shareText(nc, tc)}%</div><div class="split-v">${fmt(nc)} clicks ${countDelta(nc, b.priorNonBrandedClicks)} · ${fmt(b.nonBranded.impressions)} impr</div></div></div>` +
    `</div>`;
}

// Content architecture: topic clusters (pillar + supporting demand) with coverage / gap / funnel.
function renderTopicClusters(d: DashboardData): void {
  const card = document.getElementById('topicClustersCard');
  if (!card) return;
  const tc = d.topicClusters;
  if (!tc || !tc.clusters.length) { card.style.display = 'none'; return; }
  card.style.display = '';
  const funnelLabel: Record<string, string> = { informational: 'TOFU · info', commercial: 'MOFU · commercial', transactional: 'BOFU · transactional', navigational: 'navigational', mixed: 'mixed', unknown: '' };
  const dot = (s: string): string => `<span class="ca-dot ca-${s}" title="${s}"></span>`;
  const html = tc.clusters.map(c => {
    const covColor = c.coverage >= 70 ? 'var(--intent-success)' : c.coverage >= 40 ? 'var(--intent-warning)' : 'var(--intent-danger)';
    const members = c.members.map(m => `<span class="ca-member">${dot(m.status)}${esc(m.topic)}<span class="ca-pos">${m.position}</span></span>`).join('');
    const gaps = c.gaps.length ? `<div class="ca-gaps"><span class="ca-gaps-lbl">Gaps</span> ${c.gaps.map(g => `${esc(g.topic)} <span class="ca-gap-impr">${fmt(g.impressions)}</span>`).join(' · ')}</div>` : '';
    const fn = funnelLabel[c.funnel] ?? c.funnel;
    const links = c.linkSuggestions.length ? `<span class="ca-links">${c.linkSuggestions.length} internal-link suggestion${c.linkSuggestions.length === 1 ? '' : 's'}</span>` : '';
    return `<div class="ca-cluster">`
      + `<div class="ca-chead"><span class="ca-pillar">${esc(c.pillar.label)}</span>`
      + (fn ? `<span class="ca-funnel">${esc(fn)}</span>` : '')
      + `<span class="ca-cov" style="color:${covColor}">${c.coverage}% covered</span>`
      + `<span class="ca-impr">${fmt(c.totalImpressions)} impr</span></div>`
      + `<div class="ca-members">${members}</div>`
      + gaps
      + (links ? `<div class="ca-foot">${links}</div>` : '')
      + `</div>`;
  }).join('');
  const list = $('topicClustersList');
  list.innerHTML = html;
  const SHOW = 10;
  const items = [...list.children] as HTMLElement[];
  if (items.length > SHOW) {
    items.slice(SHOW).forEach(el => { el.hidden = true; });
    const more = document.createElement('button');
    more.type = 'button'; more.className = 'btn ca-more';
    more.textContent = `Show all ${items.length} clusters`;
    more.onclick = (): void => { items.forEach(el => { el.hidden = false; }); more.remove(); };
    list.appendChild(more);
  }
  const capped = tc.clusters.length < tc.totalClusters;
  const countTxt = capped ? `Showing the top ${tc.clusters.length} of ${fmt(tc.totalClusters)} topic clusters, by demand.` : `${tc.clusters.length} topic clusters.`;
  $('topicClustersCount').textContent = countTxt;
  $('topicClustersSummary').textContent = `${countTxt} Coverage, gaps and funnel per cluster.`;
}

// Audit-deliverable view: issues grouped by category, each sub-headed with a real example + fix.
function renderRecommendations(fc: DashboardData['findings']): void {
  const el = $('recs');
  if (!fc || !fc.recommendations?.length) { el.innerHTML = `<p class="muted">${fc ? 'The latest audit found nothing to fix.' : 'No audit yet - run run_audit.'}</p>`; return; }
  const exampleRow = (ex: { urlKey: string | null; evidence: Record<string, unknown>; clicks: number; impressions: number }): string => {
    const fullPath = ex?.urlKey ? (ex.urlKey.replace(/^https?:\/\/[^/]+/, '') || '/') : '';
    const path = esc(ex?.urlKey ? shortPath(ex.urlKey) : '');
    const ev = (ex?.evidence ?? {}) as Record<string, unknown>;
    const detail = esc(evidenceSummary(ev));
    const traffic = (ex.clicks || ex.impressions) ? `<span class="rec-ex-traf">${fmt(ex.clicks)} clicks · ${fmt(ex.impressions)} impr</span>` : '';
    const loc = fullPath
      ? `<a class="rec-url" href="${esc(ex.urlKey || '')}" title="${esc(fullPath)}" target="_blank" rel="noopener">${path}</a>`
      : (ev.query ? `<span class="rec-q">“${esc(String(ev.query))}”</span>` : '<span class="muted">site-wide</span>');
    return `<div class="rec-ex">${loc}${detail ? ` <span class="rec-ex-detail">${detail}</span>` : ''}${traffic}</div>`;
  };
  el.innerHTML = fc.recommendations.map(cat => {
    const items = cat.checks.map(c => {
      const exs = (c.examples?.length ? c.examples : (c.example ? [c.example] : []));
      const examplesHtml = exs.length
        ? `<div class="rec-examples"><div class="rec-label">Example${exs.length > 1 ? 's' : ''}</div>${exs.map(exampleRow).join('')}</div>`
        : '';
      return accordionItem({
        summaryHtml: `${sevBadge(c.severity)}<span class="rec-title">${esc(c.title)}</span><span class="rec-count">${c.count}${c.coveragePct != null ? ` · ${c.coveragePct}% of pages` : ''}</span>`,
        bodyHtml: `<div class="rec-fix"><span class="rec-label">Fix</span> ${esc(c.fix)}</div>${examplesHtml}`,
      });
    }).join('');
    return accordionSection(categoryLabel(cat.category), cat.checks.length, items);
  }).join('');

  const ctrl = $('recsControls');
  if (ctrl) accordionControls(ctrl, el);
}

// Findings: severity count-chips (click to filter) + a prioritised table with a
// priority mini-bar and single-line fix text. Replaces the old non-actionable treemap.
/** Set by renderFindings: scope the Issues list to an area and/or one check (used by the Summary). */
let issuesFilter: ((f: { area?: string; check?: string }) => void) | null = null;
function renderFindings(fc: DashboardData['findings'], _col: ReturnType<typeof palette>): void {
  const chipsEl = $('sevChips'), tableEl = $('findingsTable');
  if (!fc || !fc.byCheck.length) {
    chipsEl.innerHTML = `<span class="muted">${fc ? 'The latest audit found nothing to fix.' : 'No audit yet - run run_audit.'}</span>`;
    tableEl.innerHTML = '';
    $('findingsSummary').textContent = fc ? 'The latest audit found nothing to fix.' : 'No audit findings yet.';
    return;
  }
  const sevCounts: Record<string, number> = {};
  for (const c of fc.byCheck) sevCounts[c.severity] = (sevCounts[c.severity] ?? 0) + c.count;
  const maxPrio = Math.max(...fc.top.map(f => f.priority), 0.0001);
  let active = 'all';
  let area = 'all';
  let check: string | null = null; // set from the Summary's "Do this first"; cleared from the chip

  // Severity health bar - proportion of all findings by severity, at a glance
  const HB_CLASS: Record<string, string> = { crit: 'hb-crit', high: 'hb-high', med: 'hb-med', low: 'hb-low', info: 'hb-low' };
  const hbTotal = SEV_ORDER.reduce((s, x) => s + (sevCounts[x] ?? 0), 0) || 1;
  const healthBar = `<div class="health-bar" role="img" aria-label="Findings by severity">` +
    SEV_ORDER.filter(s => sevCounts[s]).map(s =>
      `<span class="${HB_CLASS[s]}" style="width:${((sevCounts[s] / hbTotal) * 100).toFixed(1)}%" title="${SEV_LABEL[s]}: ${sevCounts[s]}"></span>`).join('') +
    `</div>`;

  // The payload holds the top 50 findings. A filter, or "Show more", asks the server for every
  // matching finding a page at a time (list_findings), so a chip that counts 386 lists 386. With no
  // server (a fixture or an exported report) it filters what it has and says so.
  type Row = typeof fc.top[number];
  const canQuery = !(window as any).__DASH_FIXTURE__ && !!currentData?.siteUrl;
  const PAGE = 100;
  let rows: Row[] = fc.top;
  let rowsTotal = fc.total;
  let loadingRows = false;
  let token = 0;
  const filtered = (): boolean => active !== 'all' || area !== 'all' || !!check;
  const fetchRows = async (offset: number): Promise<void> => {
    const my = ++token;
    loadingRows = true; drawTable();
    try {
      const res = await callServer('list_findings', {
        siteUrl: currentData!.siteUrl, offset, limit: PAGE,
        ...(active !== 'all' ? { severity: active } : {}), ...(area !== 'all' ? { category: area } : {}), ...(check ? { checkId: check } : {}),
      });
      if (my !== token) return; // a newer filter won
      const page = (res?.structuredContent ?? res) as { total: number; rows: Row[] };
      rows = offset ? rows.concat(page.rows) : page.rows;
      rowsTotal = page.total;
    } catch {
      if (my !== token) return;
      rows = fc.top.filter(f => (active === 'all' || f.severity === active) && (area === 'all' || f.category === area) && (!check || f.check_id === check));
      rowsTotal = -1; // unknown: we only have the top 50
    } finally {
      if (my === token) { loadingRows = false; drawTable(); }
    }
  };
  /** Re-read the list for the current filter: from the payload when unfiltered, else the server. */
  const refilter = (): void => {
    if (!filtered()) { token++; rows = fc.top; rowsTotal = fc.total; loadingRows = false; drawTable(); return; }
    if (canQuery) { rows = []; void fetchRows(0); return; }
    rows = fc.top.filter(f => (active === 'all' || f.severity === active) && (area === 'all' || f.category === area) && (!check || f.check_id === check));
    rowsTotal = -1; drawTable();
  };

  const drawTable = (): void => {
    // The .grid-virtual class (content-visibility:auto) keeps long lists cheap to render.
    const list = rows;
    const focus = document.getElementById('issuesFocus');
    if (focus) {
      const title = check ? (safeJson((list.find(f => f.check_id === check) ?? fc.top.find(f => f.check_id === check))?.recommendation ?? '').title || check) : '';
      focus.innerHTML = check ? `<span class="focus-chip">Showing one check: ${esc(title)} <button type="button" aria-label="Show all checks">×</button></span>` : '';
      const btn = focus.querySelector('button');
      if (btn) btn.onclick = (): void => { check = null; refilter(); };
    }
    const rowHtml = list.map((f, i) => {
      const rec = safeJson(f.recommendation), traf = safeJson(f.traffic_at_risk), ev = safeJson(f.evidence);
      const path = f.url_key ? shortPath(f.url_key) : '-';
      const pct = Math.max(3, Math.round((f.priority / maxPrio) * 100));
      const sz = (f.size ?? '').toString();
      const szClass = 'impact-' + (sz.toLowerCase() || 's');
      const qLabel = ev.query ? ` <span style="color:var(--text-muted);font-size:12px">“${esc(String(ev.query))}”</span>` : '';
      return `<tr class="fi-row" data-fi="${i}" tabindex="0" role="button" aria-expanded="false">` +
        `<td>${sevBadge(f.severity)}</td>` +
        `<td class="fi-issue"><span class="fi-chev" aria-hidden="true">${icons.chevron}</span>${esc(rec.title || f.check_id)}${qLabel}` +
        (rec.text ? `<div class="fi-fixline" title="${esc(rec.text)}">${esc(rec.text)}</div>` : '') + `</td>` +
        `<td class="url" title="${esc(f.url_key || '')}">${f.url_key ? esc(path) : '<span class="cell-null">site-wide</span>'}</td><td class="num">${fmt(traf.clicks || 0)}</td>` +
        `<td class="num">${fmt(traf.impressions || 0)}</td>` +
        `<td class="prio"><span class="impact ${szClass}">${esc(sz || '–')} ${f.impact ?? pct}</span></td></tr>` +
        `<tr class="fi-detail-row" hidden><td colspan="6">${findingDetailHtml(f)}</td></tr>`;
    });
    const shown = list.length;
    const more = rowsTotal > shown && canQuery && !loadingRows;
    const countLine = loadingRows && !shown ? '<p class="muted">Loading findings...</p>'
      : rowsTotal < 0 ? `<p class="muted fi-count">Showing ${fmt(shown)} from the 50 highest-priority findings. Open the live dashboard for every finding.</p>`
        : `<p class="muted fi-count">Showing ${fmt(shown)} of ${fmt(rowsTotal)} finding${rowsTotal === 1 ? '' : 's'}${filtered() ? ' matching the filter' : ''}, highest impact first.${more ? ` <button type="button" class="link-btn" data-more>Show ${fmt(Math.min(PAGE, rowsTotal - shown))} more</button>` : ''}${loadingRows && shown ? ' Loading...' : ''}</p>`;
    tableEl.innerHTML = rowHtml.length
      ? healthBar + `<table class="grid-virtual"><thead><tr><th>Sev</th><th>Issue</th><th>URL</th><th class="num">Clicks</th><th class="num">Impr</th><th>Impact</th></tr></thead><tbody>${rowHtml.join('')}</tbody></table>` + countLine
      : healthBar + (loadingRows ? countLine : `<p class="muted">No findings match this filter.</p>`);
    tableEl.querySelector<HTMLButtonElement>('[data-more]')?.addEventListener('click', () => { void fetchRows(shown); });
    tableEl.querySelectorAll<HTMLElement>('.fi-row').forEach(row => {
      const toggle = (): void => {
        const det = row.nextElementSibling as HTMLElement | null;
        if (!det || !det.classList.contains('fi-detail-row')) return;
        const open = det.hasAttribute('hidden');
        det.toggleAttribute('hidden', !open);
        row.classList.toggle('open', open);
        row.setAttribute('aria-expanded', String(open));
      };
      row.addEventListener('click', toggle);
      row.addEventListener('keydown', e => { const k = (e as KeyboardEvent).key; if (k === 'Enter' || k === ' ') { e.preventDefault(); toggle(); } });
    });
  };
  // By-area rail: findings per category (whole run), click to scope the table; click again to clear.
  const areaEl = document.getElementById('byArea');
  if (areaEl) {
    const byCat: Record<string, number> = {};
    for (const c of fc.byCheck) byCat[c.category] = (byCat[c.category] ?? 0) + c.count;
    const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
    const maxC = Math.max(...cats.map(c => c[1]), 1);
    const drawArea = (): void => {
      areaEl.innerHTML = `<h4>By area</h4><div class="hint" style="font-size:11px">Whole run; click to scope the list.</div>` + cats.map(([k, n]) =>
        `<button type="button" class="area-row${area === k ? ' active' : ''}" data-area="${esc(k)}" aria-pressed="${area === k}"><div class="ar-top"><span>${esc(categoryLabel(k))}</span><b>${fmt(n)}</b></div>` +
        `<div class="stat-track"><span style="width:${Math.max(2, (n / maxC) * 100).toFixed(1)}%;background:${area === k ? 'var(--accent)' : 'var(--chart-categorical-1)'}"></span></div></button>`).join('');
      areaEl.querySelectorAll<HTMLButtonElement>('[data-area]').forEach(b => {
        b.onclick = (): void => { area = area === b.dataset.area ? 'all' : b.dataset.area!; drawArea(); refilter(); };
      });
    };
    drawArea();
    issuesFilter = (f): void => { area = f.area ?? 'all'; check = f.check ?? null; active = 'all'; drawArea(); refilter(); };
  }
  filterGroup(
    chipsEl,
    [
      { key: 'all', label: 'All', count: fc.total },
      ...SEV_ORDER.filter(s => sevCounts[s]).map(s => ({ key: s, label: SEV_LABEL[s], count: sevCounts[s], variant: s })),
    ],
    key => { active = key; refilter(); },
    'all',
  );
  drawTable();
  $('findingsSummary').textContent = `${fc.total} findings across ${fc.byCheck.length} checks, ranked by impact ÷ effort.`;
}

// KPI tiles come from the display library (lib/kpi.ts: statBlock + kpiGrid).

function render(data: DashboardData): void {
  $('loading').style.display = 'none';
  renderSideFreshness(data); // the sidebar lives outside #content: show job status even with no GSC data
  if (data.empty || !data.summary) {
    // No Search Console yet. With a crawl or an audit the Summary still has plenty to say (health,
    // issues, changes, AI readiness, coverage) and Issues & fixes works; the GSC-driven tabs are
    // disabled with the reason, instead of rendering zeros.
    const crawlSide = !!(data as any).coverage?.crawlPages || !!data.findings;
    if (!crawlSide) { $('empty').style.display = 'flex'; return; }
    renderCrawlOnly(data);
    return;
  }
  document.querySelectorAll<HTMLButtonElement>('.tab-btn').forEach(b => { b.disabled = false; b.removeAttribute('title'); });
  $('content').style.display = 'block';
  $('site').textContent = data.siteUrl;
  $('site').title = data.siteUrl;
  const dr = data.dateRange;
  $('range').textContent = dr?.maxDate ? `to ${fmtDate(dr.maxDate)}` : '';
  applyWindowLabels();
  // Trailing unfinalised GSC days are excluded upstream (gscFreshness); the range already
  // states the end date - no visible caveat (hover-only explanation for the curious).
  if (dr && dr.trimmedDays && dr.trimmedDays > 0 && dr.rawMaxDate) {
    $('range').title = `Data to ${fmtDate(dr.maxDate)}; the last ${dr.trimmedDays} day${dr.trimmedDays > 1 ? 's' : ''} of Search Console data aren’t final yet and are excluded.`;
  }

  const c = data.summary.current, p = data.summary.prior;
  // The window's daily series for the KPI sparklines (tail of the 90-day rankTrend).
  const spark = (data.rankTrend ?? []).slice(-Math.min(winDays, 90));
  const sClicks = spark.map(d => d.clicks);
  const sImpr = spark.map(d => d.impressions);
  const sCtr = spark.map(d => d.impressions ? d.clicks / d.impressions : 0);
  const sPos = spark.map(d => d.position).filter(v => v > 0);
  $('metrics').outerHTML = kpiGrid([
    { label: 'Clicks', value: fmtCompact(c.clicks), changeHtml: countDelta(c.clicks, p.clicks), spark: sClicks },
    { label: 'Impressions', value: fmtCompact(c.impressions), changeHtml: countDelta(c.impressions, p.impressions, 'impression'), spark: sImpr },
    { label: 'CTR', value: `${(c.ctr * 100).toFixed(1)}%`, change: pctChg(c.ctr, p.ctr), spark: sCtr },
    // A rank's change is shown in positions, never as a % of the rank (#68 real-data fix).
    { label: 'Avg position', value: c.position.toFixed(1), changeHtml: rankDelta(c.position, p.position), lowerIsBetter: true, spark: sPos },
  ]).replace('<div class="metrics">', '<div class="metrics" id="metrics">');

  const col = palette();
  // Axis discipline (brief #4): whisper dashed gridlines; numeric axes get M/k labels.
  const axis = axisDefaults(col);
  const axisNum = axisDefaults(col, { numeric: true });

  // The Summary (landing view), the crawl-health header + status mix, and the Search performance
  // trend + top tables (the last two moved from the retired Overview).
  const octx: OverviewCtx = { wrap, col, shortPath, safeJson, redacted: document.documentElement.classList.contains('redacted') };
  renderSummary(data, summaryCtx(col));
  renderSearchTop(data, octx);
  renderHealthTop(data, octx);
  renderFieldCwv(data, { wrap, col, redacted: octx.redacted });

  renderBrandedSplit(data);
  // Audit findings - severity filter chips + prioritised table, then the categorised report
  renderFindings(data.findings, col);
  renderRecommendations(data.findings);
  renderTopicClusters(data);
  buildExportBar(data);

  // 0) Equity vs reality - template mismatch (bars) + per-URL scatter (the architecture flagship)
  const crawled = (data.crawlHealth?.totalPages ?? 0) > 0;
  const mm = data.templateMismatch ?? [];
  if (mm.length) {
    const labels = mm.map(m => m.template).reverse();
    wrap('mismatchChart').setOption({
      ...ARIA,
      grid: { left: labelW(120) + 14, right: 24, top: 32, bottom: 30 },
      legend: { top: 0, type: 'scroll', textStyle: { color: col.text, fontSize: 12 } },
      tooltip: { ...tooltipDefaults(col), axisPointer: { type: 'shadow' }, valueFormatter: (v: number) => v + '%' },
      xAxis: { type: 'value', name: '% share', max: 100, ...axis },
      yAxis: { type: 'category', data: labels, ...catAxis(axis, 120) },
      series: [
        { name: 'Internal equity', type: 'bar', data: mm.map(m => m.iprPct).reverse(), itemStyle: { color: col.blue } },
        { name: 'Organic traffic', type: 'bar', data: mm.map(m => m.trafficPct).reverse(), itemStyle: { color: col.categorical[2] } },
      ],
    });
    const sink = mm.find(m => m.iprPct >= 10 && m.trafficPct < m.iprPct * 0.3);
    $('mismatchSummary').textContent = sink
      ? `/${sink.template}/ absorbs ${sink.iprPct}% of internal equity but drives ${sink.trafficPct}% of traffic - equity flowing into a dead end.`
      : 'Internal equity share vs organic traffic share, by template.';
  } else {
    wrap('mismatchChart').setEmpty(crawled ? 'No indexable 200 page in the crawl to group by template' : 'Run a crawl to map equity flow', col);
    $('mismatchSummary').textContent = 'Run a crawl (refresh_property) to see equity flow by template.';
  }

  // 0b) Internal link explorer - folder-to-folder iPR flow as a bipartite Sankey.
  // Left nodes are sources ("x →"), right nodes targets ("→ x"): bipartite by construction,
  // so mutual flows (blog→products AND products→blog) can never form the cycles ECharts rejects.
  const lf = data.linkFlows;
  const lfCard = document.getElementById('linkFlowsCard');
  if (lfCard) lfCard.style.display = lf?.flows?.length ? '' : 'none';
  if (lf?.flows?.length) {
    const nodes = [
      ...lf.sources.map(s => ({ name: `${s} →`, itemStyle: { color: col.blue } })),
      ...lf.targets.map(t => ({ name: `→ ${t}`, itemStyle: { color: col.categorical[2] } })),
    ];
    wrap('linkFlowsChart').setOption({
      ...ARIA,
      tooltip: { ...tooltipDefaults(col), trigger: 'item', valueFormatter: (v: number) => `${v} iPR units` },
      series: [{
        type: 'sankey',
        left: 12, right: 110, top: 16, bottom: 16,
        nodeGap: 14,
        emphasis: { focus: 'adjacency' },
        lineStyle: { color: 'gradient', opacity: 0.35 },
        label: { color: col.text, fontSize: 12 },
        data: nodes,
        links: lf.flows.map(f => ({ source: `${f.source} →`, target: `→ ${f.target}`, value: f.value })),
      }],
    });
    const top = lf.flows[0];
    $('linkFlowsSummary').textContent = `${lf.flows.length} folder-to-folder equity flows; largest: ${top.source} into ${top.target} (${top.value} iPR units).`;
  }

  const sc = data.equityScatter ?? [];
  const bucketColor: Record<string, string> = { content: col.blue, category: col.categorical[4], homepage: col.categorical[1], other: col.muted };
  const scGroups: Record<string, { value: number[]; id: string }[]> = {};
  for (const pt of sc) (scGroups[pt.t] ??= []).push({ value: [pt.x, Math.max(1, pt.y)], id: pt.u }); // max(1) keeps the log axis valid
  if (sc.length) {
    wrap('scatterChart').setOption({
      ...ARIA,
      grid: { left: 60, right: 24, top: 52, bottom: 48 },
      legend: { top: 0, right: 0, textStyle: { color: col.text, fontSize: 12 } },
      tooltip: { ...tooltipDefaults(col, 'item'), formatter: (p: any) => `${esc(shortPath(p.data.id, 44))}<br/>iPR ${p.value[0]} · ${fmt(p.value[1])} impressions` },
      xAxis: { type: 'value', name: 'internal PageRank', min: 0, max: 100, ...axis },
      yAxis: { type: 'log', name: 'impressions', ...axisNum },
      dataZoom: [{ type: 'inside', xAxisIndex: 0, filterMode: 'none' }, { type: 'inside', yAxisIndex: 0, filterMode: 'none' }],
      series: Object.entries(scGroups).map(([t, pts]) => ({ name: t, type: 'scatter', symbolSize: t === 'category' ? 9 : 7, itemStyle: { color: bucketColor[t] ?? col.muted, opacity: 0.6 }, emphasis: { itemStyle: { opacity: 1, borderColor: col.accent, borderWidth: 1.5 } }, data: pts })),
    });
    // Click a point to open that page in a new tab (consistent with the structure map).
    wrap('scatterChart').on('click', (p: any) => { if (p?.data?.id) window.open(p.data.id, '_blank', 'noopener'); });
    $('scatterSummary').textContent = `${sc.length} URLs by internal PageRank and impressions; bottom-right = high-authority pages earning no traffic. Scroll to zoom, click a point to open the page.`;
  } else {
    wrap('scatterChart').setEmpty(crawled ? `No page has iPR 15+ or 5+ impressions in the last ${winDays} days to plot` : 'Run a crawl to map equity vs traffic', col);
    $('scatterSummary').textContent = 'Run a crawl (refresh_property) to see the equity map.';
  }

  // 0c) Crawl network (the signature visual): the internal link skeleton of the highest-equity
  // pages as a force graph. Node size = iPR; colour = health. Shared with the Overview preview.
  const sg = data.structureGraph;
  const sgCard = document.getElementById('structureCard');
  if (sgCard) sgCard.style.display = sg?.nodes?.length ? '' : 'none';
  const drawFullNetwork = (): void => {
    if (!drawNetwork(data, octx, 'structureChart', { compact: false })) return;
    wrap('structureChart').on('click', (p: any) => {
      if (p?.dataType !== 'edge' && p?.data?.id) window.open(p.data.id, '_blank', 'noopener');
    });
  };
  if (sg?.nodes?.length) {
    const broken = sg.nodes.filter((n: any) => n.status == null || n.status >= 300).length;
    const iso: any[] = (sg as any).isolated ?? [];
    $('structureNote').innerHTML = iso.length
      ? `<b>${iso.length} mapped page${iso.length === 1 ? ' has' : 's have'} no in-content link to or from the other pages here</b> (dashed outline, set apart at the bottom left): ` +
        iso.slice(0, 6).map(n => `<code>${esc(shortPath(n.id, 40))}</code> ${esc(isolatedText(n).replace(/, so it has no in-content link in this map\.$/, '.'))}`).join(' ') + (iso.length > 6 ? ` And ${iso.length - 6} more.` : '')
      : '';
    $('structureSummary').textContent = `Internal link skeleton of the top ${sg.nodes.length} pages by internal PageRank (of ${fmt(sg.totalPages)} crawled); node size = iPR, ${broken} broken or redirected. Scroll to zoom, drag to pan, click a node to open the page.`;
    const networkVisible = !!document.querySelector('.tab-panel.active[data-panel="architecture"]');
    if (networkVisible) { pendingNetworkDraw = null; drawFullNetwork(); } else pendingNetworkDraw = drawFullNetwork;
  } else {
    pendingNetworkDraw = null;
    $('structureNote').innerHTML = '';
    $('structureSummary').textContent = 'Run a crawl (refresh_property) to map your internal link structure.';
  }

  // 0d) Security / HTTPS coverage (V2) - header coverage bars, status-coloured (grey the context,
  // red/amber the gaps). Site-wide headers read as 100% / 0%; partials show the real share.
  const sec = data.securityCoverage;
  const secCard = document.getElementById('securityCard');
  if (secCard) secCard.style.display = sec && sec.total ? '' : 'none';
  if (sec && sec.total) {
    const hs = sec.headers.slice().reverse();
    const pct = hs.map(h => Math.round((h.present / sec.total) * 100));
    const barColor = (p: number) => p >= 95 ? col.success : p >= 50 ? col.warning : col.danger;
    wrap('securityChart').setOption({
      ...ARIA,
      grid: { left: labelW(220) + 12, right: 48, top: 8, bottom: 30 },
      tooltip: { ...tooltipDefaults(col), axisPointer: { type: 'shadow' }, valueFormatter: (v: number) => `${v}% of pages` },
      xAxis: { type: 'value', max: 100, name: '% of pages', ...axis },
      yAxis: { type: 'category', data: hs.map(h => h.label), ...catAxis(axis, 220) },
      series: [{ type: 'bar', barWidth: 15, data: pct.map(p => ({ value: p, itemStyle: { color: barColor(p) } })), label: { show: true, position: 'right', formatter: (p: any) => sharePct(hs[p.dataIndex].present, sec.total), color: col.muted, fontSize: 11 } }],
    });
    const missing = sec.headers.filter(h => h.present / sec.total < 0.95).map(h => h.label.replace(/ \(.*\)/, ''));
    $('securitySummary').textContent = (missing.length ? `Missing or partial: ${missing.join(', ')}.` : 'All key security headers present across crawled pages.') + (sec.mixedContent ? ` ${sec.mixedContent} pages load mixed content.` : '');
  }

  // 0e) Structured-data coverage (V2) - the JSON-LD @type footprint across crawled pages.
  const sch = data.schemaCoverage;
  const schCard = document.getElementById('schemaCard');
  if (schCard) schCard.style.display = sch && sch.types.length ? '' : 'none';
  if (sch && sch.types.length) {
    const t = sch.types.slice().reverse();
    wrap('schemaChart').setOption({
      ...ARIA,
      grid: { left: labelW(160) + 12, right: 56, top: 8, bottom: 30 },
      tooltip: { ...tooltipDefaults(col), axisPointer: { type: 'shadow' }, valueFormatter: (v: number) => `${fmt(v)} pages` },
      xAxis: { type: 'value', name: 'pages', ...axisNum },
      yAxis: { type: 'category', data: t.map(x => x.type), ...catAxis(axis, 160) },
      series: [{ type: 'bar', barWidth: 14, itemStyle: { color: col.accent }, data: t.map(x => x.pages), label: { show: true, position: 'right', formatter: (p: any) => fmt(p.value), color: col.muted, fontSize: 11 } }],
    });
    $('schemaSummary').textContent = `${fmt(sch.pagesWithSchema)} of ${fmt(sch.totalPages)} crawled pages carry structured data, across ${sch.types.length}${sch.types.length >= 12 ? '+' : ''} rich-result types.`;
  }

  // 0f) GSC index coverage (V2) - coverage-state distribution from URL Inspection.
  const ic = data.indexCoverage;
  const icCard = document.getElementById('indexCoverageCard');
  if (icCard) icCard.style.display = ic && ic.states.length ? '' : 'none';
  if (ic && ic.states.length) {
    const s = ic.states.slice().reverse();
    $('indexCoverageChart').style.height = `${Math.max(120, s.length * 34 + 56)}px`;
    const stateColor = (st: string) => (/indexed/i.test(st) && !/not indexed/i.test(st)) ? col.success
      : /redirect|error|not found|excluded|noindex|not indexed|blocked|soft 404/i.test(st) ? col.danger : col.warning;
    wrap('indexCoverageChart').setOption({
      ...ARIA,
      grid: { left: labelW(290) + 12, right: 56, top: 8, bottom: 30 },
      tooltip: { ...tooltipDefaults(col), axisPointer: { type: 'shadow' }, valueFormatter: (v: number) => `${fmt(v)} URLs` },
      xAxis: { type: 'value', name: 'URLs', ...axisNum },
      yAxis: { type: 'category', data: s.map(x => x.state), ...catAxis(axis, 290) },
      series: [{ type: 'bar', barWidth: 15, data: s.map(x => ({ value: x.count, itemStyle: { color: stateColor(x.state) } })), label: { show: true, position: 'right', formatter: (p: any) => fmt(p.value), color: col.muted, fontSize: 11 } }],
    });
    $('indexCoverageSummary').textContent = `${fmt(ic.indexed)} of ${fmt(ic.total)} inspected URLs indexed${ic.canonicalMismatch ? `; ${ic.canonicalMismatch} with a Google-vs-declared canonical mismatch` : ''}.`;
  }

  // 0g) Redirect chains (V2) - multi-hop redirects captured during the crawl.
  const rc = data.redirectChains;
  const rcCard = document.getElementById('redirectsCard');
  if (rcCard) rcCard.style.display = rc && rc.chains.length ? '' : 'none';
  if (rc && rc.chains.length) {
    const hostOf = (u: string): string => { try { return new URL(u).host; } catch { return ''; } };
    const dest = (from: string, to: string): string => (hostOf(to) && hostOf(to) !== hostOf(from) ? to.replace(/^https?:\/\//, '') : shortPath(to, 46));
    const rows = rc.chains.map(c => `<tr><td class="url" title="${esc(c.from)}">${esc(shortPath(c.from, 46))}</td><td class="url" title="${esc(c.to)}">${esc(dest(c.from, c.to))}</td><td class="num">${c.status}</td><td class="num">${c.hops}</td></tr>`);
    $('redirectsTable').innerHTML = tableHtml(['From', 'To', 'Status', 'Hops'], rows);
    $('redirectsSummary').textContent = `${fmt(rc.total)} redirecting URL${rc.total === 1 ? '' : 's'} captured during the crawl.`;
  }

  // 0h) Core Web Vitals (V2) - lab CWV, worst pages first.
  const cwv = data.cwvCoverage;
  const cwvCard = document.getElementById('cwvCard');
  if (cwvCard) cwvCard.style.display = cwv && cwv.worst.length ? '' : 'none';
  if (cwv && cwv.worst.length) {
    const rows = cwv.worst.map(w => `<tr><td class="url">${esc(shortPath(w.url, 42))}</td><td class="num">${w.perf}</td><td class="num">${(w.lcpMs / 1000).toFixed(1)} s</td><td class="num">${w.cls.toFixed(3)}</td><td class="num">${fmt(w.tbtMs)} ms</td></tr>`);
    $('cwvTable').innerHTML = tableHtml(['Page', 'Perf', 'LCP', 'CLS', 'TBT'], rows);
    $('cwvSummary').textContent = `${fmt(cwv.pages)} pages measured. Passing: LCP ${sharePct(cwv.passLcp, cwv.pages)}, CLS ${sharePct(cwv.passCls, cwv.pages)}, TBT ${sharePct(cwv.passTbt, cwv.pages)}.`;
  }

  // 0i) Hreflang / international (V2) - declared languages by page count.
  const hl = data.hreflangCoverage;
  const hlCard = document.getElementById('hreflangCard');
  if (hlCard) hlCard.style.display = hl && hl.langs.length ? '' : 'none';
  if (hl && hl.langs.length) {
    const l = hl.langs.slice().reverse();
    wrap('hreflangChart').setOption({
      ...ARIA,
      grid: { left: labelW(90) + 12, right: 56, top: 8, bottom: 30 },
      tooltip: { ...tooltipDefaults(col), axisPointer: { type: 'shadow' }, valueFormatter: (v: number) => `${fmt(v)} pages` },
      xAxis: { type: 'value', name: 'pages', ...axisNum },
      yAxis: { type: 'category', data: l.map(x => x.lang), ...catAxis(axis, 90) },
      series: [{ type: 'bar', barWidth: 14, itemStyle: { color: col.categorical[7] }, data: l.map(x => x.pages), label: { show: true, position: 'right', formatter: (p: any) => fmt(p.value), color: col.muted, fontSize: 11 } }],
    });
    $('hreflangSummary').textContent = `${fmt(hl.pagesWithHreflang)} of ${fmt(hl.totalPages)} pages declare hreflang, across ${hl.langs.length} languages.`;
  }

  // 0j) AI answerability (V2) - weakest extractable-answer pages first.
  const ans = data.answerability;
  const ansCard = document.getElementById('answerabilityCard');
  if (ansCard) ansCard.style.display = ans && ans.pages.length ? '' : 'none';
  if (ans && ans.pages.length) {
    const rows = ans.pages.map(p => `<tr><td class="url">${esc(shortPath(p.url, 38))}</td><td>${esc(p.query ?? '-')}</td><td class="num" style="color:${p.score < 3 ? 'var(--intent-danger)' : 'var(--intent-success)'}">${p.score.toFixed(2)}</td><td class="num">${fmt(p.impr)}</td></tr>`);
    $('answerabilityTable').innerHTML = tableHtml(['Page', 'Top query', 'Passage score', 'Impr'], rows);
    $('answerabilitySummary').textContent = `${fmt(ans.scored)} pages scored; ${fmt(ans.weak)} weak (score under 3 - no dense extractable answer).`;
  }

  // 0k) Entity & topic graph (V2) - Wikidata entities + subclass/part-of edges (force graph).
  const eg = data.entityGraph;
  const egCard = document.getElementById('entitiesCard');
  if (egCard) egCard.style.display = eg && eg.nodes.length ? '' : 'none';
  if (eg && eg.nodes.length) {
    const maxP = Math.max(...eg.nodes.map(n => n.pages), 1);
    const gnodes = eg.nodes.map(n => ({ id: n.qid, name: n.label, symbolSize: 8 + Math.round((n.pages / maxP) * 24), value: n.pages,
      label: n.pages >= Math.max(2, maxP * 0.5) ? { show: true, formatter: n.label, color: col.muted, fontSize: 10 } : { show: false } }));
    wrap('entitiesChart').setOption({
      ...ARIA,
      tooltip: { ...tooltipDefaults(col, 'item'), formatter: (p: any) => p.dataType === 'edge' ? '' : `${esc(p.data.name)}<br/>${fmt(p.data.value)} pages` },
      series: [{
        type: 'graph', layout: 'force', roam: true,
        force: { repulsion: 120, edgeLength: [40, 140], gravity: 0.06 },
        data: gnodes,
        links: eg.edges.map(e => ({ source: e.source, target: e.target })),
        itemStyle: { color: col.accent, borderColor: col.surface, borderWidth: 1 },
        lineStyle: { color: col.border, width: 0.8, opacity: 0.6, curveness: 0.1 },
        emphasis: { focus: 'adjacency', lineStyle: { color: col.accent, width: 1.3, opacity: 0.95 }, label: { show: true } },
        label: { position: 'right' },
      }],
    });
    $('entitiesSummary').textContent = `${fmt(eg.total)} entities resolved across your pages, ${fmt(eg.edges.length)} relationships.`;
  }

  // 0a) Agent readiness panel (populated by check_agent_readiness; live probe, persisted)
  const ar = data.agentReadiness;
  if (ar) {
    const scoreColor = ar.score >= 80 ? 'var(--color-status-live)' : ar.score >= 50 ? 'var(--color-status-warning)' : 'var(--color-status-error)';
    // SVG score ring - circumference arc proportional to score, colour-graded
    const R = 46, CIRC = 2 * Math.PI * R, off = CIRC * (1 - Math.max(0, Math.min(100, ar.score)) / 100);
    const ring = `<div class="ar-ring"><svg viewBox="0 0 104 104" width="104" height="104" aria-hidden="true">
        <circle cx="52" cy="52" r="${R}" fill="none" stroke="var(--bg-input)" stroke-width="9"/>
        <circle cx="52" cy="52" r="${R}" fill="none" stroke="${scoreColor}" stroke-width="9" stroke-linecap="round" stroke-dasharray="${CIRC.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 52 52)"/>
      </svg><div class="ar-score"><div class="ar-num" style="color:${scoreColor}">${ar.score}</div><div class="ar-of">/ 100</div></div></div>`;
    const cats = ar.byCategory.map(c => `<div class="ar-cat"><div class="c-label">${esc(c.category)}</div><div class="c-val">${c.passed}<span style="color:var(--text-muted)">/${c.total}</span></div></div>`).join('');
    const items = ar.checks.map(c => `<div class="ar-check">
      <span class="${c.present ? 'ar-ok' : 'ar-no'}" style="min-width:14px;font-weight:600">${c.present ? icons.check : icons.x}</span>
      <span style="flex:1">${esc(c.label)}${c.present && c.detail ? ` <span style="color:var(--text-muted)">- ${esc(c.detail)}</span>` : ''}</span>
      ${c.present ? '' : `<span class="ar-fix" style="max-width:48%;text-align:right">${esc(c.fix)}</span>`}</div>`).join('');
    $('agentPanel').innerHTML =
      `<div class="ar-top">${ring}<div class="ar-meta"><div class="ar-level">${esc(ar.level)}</div><div class="ar-cats">${cats}</div></div></div>
      <div class="ar-checks">${items}</div>`;
  } else {
    $('agentPanel').innerHTML = '<p class="muted">Run <code>check_agent_readiness</code> for this site to populate the agent-readiness score.</p>';
  }

  // 0b) Cannibalisation braids - per contested query, competing URLs' weekly position over time
  const cann = data.cannibalisation ?? [];
  const cannSel = $('cannSelect') as HTMLSelectElement;
  if (cann.length) {
    cannSel.innerHTML = cann.map((q, i) => `<option value="${i}">${esc(q.query)} (${q.urls.length} URLs)</option>`).join('');
    // Categorical spectrum for the colliding lines (concrete hex for the canvas).
    const brand = [col.teal, col.categorical[2], col.violet];
    const drawBraid = (qi: number): void => {
      const q = cann[qi];
      const top = q.urls.slice(0, 3); // only the real contenders - not a spaghetti of every URL
      const weeks = [...new Set(top.flatMap(u => u.points.map(p => p.week)))].sort();
      const maps = top.map(u => new Map(u.points.map(p => [p.week, p.position])));
      // Crossover dots: the week the leader changed (one URL overtook another) - the whole point.
      const crossovers: [string, number][] = [];
      for (let a = 0; a < maps.length; a++) {
        for (let b = a + 1; b < maps.length; b++) {
          let prevSign = 0;
          for (const w of weeks) {
            const pa = maps[a].get(w), pb = maps[b].get(w);
            if (pa == null || pb == null) continue;
            const sign = Math.sign(pa - pb);
            if (sign !== 0 && prevSign !== 0 && sign !== prevSign) crossovers.push([w, (pa + pb) / 2]);
            if (sign !== 0) prevSign = sign;
          }
        }
      }
      const lines = top.map((u, ui) => ({
        // Lines break on missing weeks (null-vs-zero discipline) - a gap is "not seen", not rank 0.
        name: shortPath(u.url), type: 'line', smooth: true, connectNulls: false, showSymbol: false,
        lineStyle: { width: 2.5, color: brand[ui % brand.length] }, itemStyle: { color: brand[ui % brand.length] },
        data: weeks.map(w => maps[ui].get(w) ?? null),
      }));
      wrap('cannChart').setOption({
        ...ARIA,
        grid: { left: 48, right: 16, top: 60, bottom: 30 },
        legend: { top: 0, type: 'scroll', textStyle: { color: col.text, fontSize: 11 } },
        tooltip: tooltipDefaults(col),
        xAxis: { type: 'category', data: weeks, boundaryGap: false, ...axis, axisLabel: { ...axis.axisLabel, formatter: (v: string) => fmtWeek(v), hideOverlap: true } },
        yAxis: { type: 'value', name: 'rank (1 = top)', nameLocation: 'start', inverse: true, min: (v: any) => Math.max(1, Math.floor(v.min) - 1), max: (v: any) => Math.ceil(v.max) + 1, ...axis },
        series: [
          ...lines,
          { name: 'Google switched winner', type: 'scatter', data: crossovers, symbolSize: 11,
            itemStyle: { color: col.text, borderColor: col.surface, borderWidth: 2 }, z: 6,
            tooltip: { trigger: 'item', formatter: (p: any): string => `Leader changed (week ${p.value[0]})` } },
        ],
      });
    };
    drawBraid(0);
    cannSel.onchange = (): void => drawBraid(Number(cannSel.value));
    $('cannSummary').textContent = `${cann.length} contested queries; each line is a competing URL's weekly rank (top = winning). A dot marks the week Google switched which URL it favours.`;
  } else {
    cannSel.innerHTML = '';
    wrap('cannChart').setEmpty('No cannibalisation detected', col);
    $('cannSummary').textContent = 'No contested queries found.';
  }

  // 0d) Top internally-linked pages with their current status code (a non-200 high up = equity leak)
  const tlp = data.topLinkedPages ?? [];
  $('topLinkedTable').innerHTML = tlp.length
    ? tableHtml(['URL', 'Internal links in', 'Status', 'Indexable'], tlp.map(p =>
      `<tr><td class="url" title="${esc(p.url)}">${esc(shortPath(p.url))}</td><td class="num">${fmt(p.inlinks)}</td><td>${statusBadge(p.status)}</td><td>${p.indexable ? icons.check : `${icons.x} ${esc(p.reason || '')}`}</td></tr>`))
    : (crawled ? '<p class="muted">No internal page in the crawl has an internal link in.</p>' : emptyState('Run a crawl to see the internal-link hierarchy.', 'refresh_property'));
  // status null = not fetched (rate limited, #54) or robots-blocked: unknown, not a broken page.
  const tlpBroken = tlp.filter(p => p.status != null && p.status !== 200).length;
  $('topLinkedSummary').textContent = `Top ${tlp.length} internally-linked pages by inlink count; ${tlpBroken} return a non-200 status.`;

  // 0e) Site health - stat bars as EChartWrapper configs (brief: no DOM/SVG chart
  // primitives - even stat bars go through the wrapper).
  {
    const ch = data.crawlHealth;
    // Tone (bar colour) rides on each data row - assigned in dashboardData where the bucket's
    // meaning is known, never inferred from label text here.
    const toneColor: Record<string, string> = { ok: col.green, warn: col.amber, bad: col.red, muted: col.grey };
    const sfBars = (id: string, rows: { label: string; count: number; tone?: string }[] | undefined, base: number, none = 'None in this crawl.'): void => {
      const el = $(id);
      if (!rows?.length || base <= 0) {
        chartsReg.get(id)?.dispose(); chartsReg.delete(id);
        el.style.height = '';
        el.innerHTML = `<div class="sf-empty">${base > 0 ? none : 'Nothing to show - run a crawl first.'}</div>`;
        return;
      }
      if (el.querySelector('.sf-empty')) el.innerHTML = '';
      const rev = rows.slice().reverse(); // horizontal bars read top-down
      el.classList.add('sf-chart');
      // Long labels wrap onto two lines (the row grows to fit) instead of being cut off.
      const lw = labelW(190);
      const wraps = (l: string): boolean => l.length * 6.6 > lw;
      el.style.height = `${rev.reduce((h, r) => h + (wraps(r.label) ? 38 : 26), 0) + 12}px`;
      const pctOf = (n: number): string => shareText(n, base);
      wrap(id).setOption({
        ...ARIA,
        grid: { left: 8, right: 96, top: 6, bottom: 6, containLabel: true },
        tooltip: { ...tooltipDefaults(col, 'item'), formatter: (p: any) => `${esc(String(rev[p.dataIndex].label))}: ${fmt(p.value)} (${pctOf(p.value)}%)` },
        xAxis: { type: 'value', max: base, show: false },
        yAxis: {
          type: 'category', data: rev.map(r => r.label),
          axisLine: { show: false }, axisTick: { show: false },
          axisLabel: { color: col.text, fontSize: 12, width: lw, overflow: 'break', lineHeight: 14 },
        },
        series: [{
          type: 'bar', barWidth: 8,
          showBackground: true, backgroundStyle: { color: col.grid, borderRadius: 4 },
          itemStyle: { borderRadius: 4, color: (p: any) => toneColor[rev[p.dataIndex].tone ?? ''] ?? col.info },
          label: {
            show: true, position: 'right', color: col.muted, fontSize: 11,
            formatter: (p: any) => `${fmt(p.value)} · ${pctOf(p.value)}%`,
          },
          data: rev.map(r => r.count),
        }],
      });
    };
    const total = ch?.totalPages ?? 0;
    sfBars('sfCodes', ch?.responseCodes, total);
    sfBars('sfIndexability', ch?.indexability, total);
    sfBars('sfSpeed', ch?.speed, total);
    sfBars('sfSize', ch?.htmlSize, total);
    sfBars('sfDepth', ch?.depth, total);
    sfBars('sfOnPage', ch?.onPage, total, 'No on-page issue on any indexable page.');
    sfBars('sfTitles', ch?.titles, total, 'No indexable page has a missing, duplicate, long or short title.');
    sfBars('sfMetas', ch?.metas, total, 'No indexable page has a missing, duplicate, long or short meta description.');
    // The same limits the audit checks use (core/onPageLimits.ts), named so the counts can be matched.
    $('sfTitlesRule').textContent = total ? `Indexable pages. "Over ${TITLE_MAX_CHARS}" is the audit's title-too-long check.` : '';
    $('sfMetasRule').textContent = total ? `Indexable pages. "Over ${META_DESC_MAX_CHARS}" is the audit's meta-description-length check.` : '';
    const card = (id: string, show: boolean): HTMLElement => { const c = $(id); c.style.display = show ? '' : 'none'; return c; };
    card('sfServerErrorsCard', !!ch?.serverErrors?.length);
    if (ch?.serverErrors?.length) $('sfServerErrors').innerHTML = tableHtml(['URL', 'Status'],
      ch.serverErrors.map(e => `<tr><td class="url" title="${esc(e.url)}">${esc(shortPath(e.url))}</td><td class="num">${e.status}</td></tr>`));
    card('sfSlowCard', !!ch?.slowPages?.length);
    if (ch?.slowPages?.length) $('sfSlow').innerHTML = tableHtml(['URL', 'Response time'],
      ch.slowPages.map(s => `<tr><td class="url" title="${esc(s.url)}">${esc(shortPath(s.url))}</td><td class="num">${fmt(s.ms)} ms</td></tr>`));
    card('sfImagesCard', !!ch?.imageStats);
    if (ch?.imageStats) {
      $('sfImagesHint').textContent = `Sampled ${fmt(ch.imageStats.sampled)} distinct images (header-only - the bytes are never downloaded): ${fmt(ch.imageStats.over100kb)} over 100 KB, ${fmt(ch.imageStats.over300kb)} over 300 KB. Heaviest first; "pages" is how many crawled pages load it.`;
      $('sfImages').innerHTML = ch.largeImages.length
        ? tableHtml(['Image', 'Size', 'Pages'], ch.largeImages.map(i =>
          `<tr><td class="url" title="${esc(i.url)}">${esc(shortPath(i.url))}</td><td class="num">${fmt(i.kb)} KB</td><td class="num">${i.usedOn}</td></tr>`))
        : '<p class="muted">No sampled image over 100 KB. Tidy.</p>';
    }
  }

  // 1) Ranking distribution over time (stacked area) - flagship #1
  const dist = data.rankingDistribution ?? [];
  const bc = bucketColors(col);
  const buckets = [
    { key: 'b1' as const, name: 'Pos 1–3', color: bc[0] },
    { key: 'b2' as const, name: 'Pos 4–10', color: bc[1] },
    { key: 'b3' as const, name: 'Pos 11–20', color: bc[2] },
    { key: 'b4' as const, name: 'Pos 21+', color: bc[3] },
  ];
  // 'ts' group: echarts.connect() unifies crosshair/tooltip across the daily
  // time-series stack (ranking distribution + rank & clicks share the x domain).
  wrap('distChart', 'ts').setOption({
    ...ARIA,
    grid: { left: 52, right: 16, top: 36, bottom: 30 },
    legend: { top: 0, type: 'scroll', textStyle: { color: col.text, fontSize: 12 } },
    tooltip: tooltipDefaults(col),
    xAxis: { type: 'category', data: dist.map(d => d.date), ...axis, axisLabel: { ...axis.axisLabel, formatter: (v: string) => fmtDate(v, true), hideOverlap: true } },
    yAxis: { type: 'value', ...axisNum },
    series: buckets.map(b => ({
      name: b.name, type: 'line', stack: 'imp', showSymbol: false, lineStyle: { width: 0 },
      areaStyle: { opacity: 0.55 }, itemStyle: { color: b.color }, data: dist.map(d => d[b.key]),
    })),
  });
  const last = dist[dist.length - 1];
  const lastTot = last ? last.b1 + last.b2 + last.b3 + last.b4 : 0;
  $('distSummary').textContent = `Impressions by SERP position bucket across ${dist.length} days; latest day ${lastTot} impressions, ${sharePct(last?.b1 ?? 0, lastTot)} in positions 1–3.`;

  // 1b) DataForSEO search visibility over time (rank_history) - reconciled window
  const rh = data.rankHistory ?? [];
  if (rh.length) {
    const rbc = bucketColors(col);
    const rhBuckets = [
      { key: 'pos_1_3' as const, name: 'Pos 1–3', color: rbc[0] },
      { key: 'pos_4_10' as const, name: 'Pos 4–10', color: rbc[1] },
      { key: 'pos_11_20' as const, name: 'Pos 11–20', color: rbc[2] },
      { key: 'pos_21_100' as const, name: 'Pos 21–100', color: rbc[3] },
    ];
    wrap('rankHistChart').setOption({
      ...ARIA,
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      grid: [{ left: 52, right: 16, top: 54, height: '46%' }, { left: 52, right: 16, top: '76%', bottom: 26 }],
      legend: { top: 0, type: 'scroll', textStyle: { color: col.text, fontSize: 12 } },
      tooltip: tooltipDefaults(col),
      xAxis: [
        { type: 'category', gridIndex: 0, data: rh.map(p => p.period), ...axis, axisLabel: { show: false } },
        { type: 'category', gridIndex: 1, data: rh.map(p => p.period), ...axis, axisLabel: { ...axis.axisLabel, formatter: (v: string) => fmtMonth(v), hideOverlap: true } },
      ],
      yAxis: [
        { type: 'value', gridIndex: 0, name: 'ranking keywords', ...axisNum },
        { type: 'value', gridIndex: 1, name: 'est. traffic value', ...axisNum, splitNumber: 2 },
      ],
      series: [
        ...rhBuckets.map(b => ({
          name: b.name, type: 'line', stack: 'kw', showSymbol: false, lineStyle: { width: 0 },
          areaStyle: { opacity: 0.55 }, itemStyle: { color: b.color }, data: rh.map(p => p[b.key]),
        })),
        { name: 'ETV', type: 'line', xAxisIndex: 1, yAxisIndex: 1, smooth: true, showSymbol: false, data: rh.map(p => Math.round(p.etv)), lineStyle: { color: col.text, width: 1.75 }, itemStyle: { color: col.text } },
      ],
    });
    $('rankHistSummary').textContent = `DataForSEO ranking keywords by position bucket across ${rh.length} months, with estimated traffic value.`;
  } else {
    wrap('rankHistChart').setEmpty('No rank history yet - run track_ranks', col);
    $('rankHistSummary').textContent = 'No DataForSEO rank history yet.';
  }
  const al: any = data.dateAlignment;
  $('alignNote').textContent = al?.gsc && al?.dataforseo
    ? (al.overlap
      ? `Search Console holds ${fmtDate(al.gsc.start)} to ${fmtDate(al.gsc.end)} (daily) and DataForSEO ${fmtMonth(al.dataforseo.start)} to ${fmtMonth(al.dataforseo.end)} (monthly); they overlap from ${fmtMonth(al.overlap.start)} to ${fmtMonth(al.overlap.end)}.`
      : `No overlap: Search Console ends ${fmtDate(al.gsc.end)}, DataForSEO covers ${fmtMonth(al.dataforseo.start)} to ${fmtMonth(al.dataforseo.end)}.`)
    : (al?.note ?? '');

  // 2) Rank + clicks over time - two small multiples on one shared x (dataviz: never dual-axis).
  const trend = data.rankTrend ?? [];
  wrap('rankChart', 'ts').setOption({
    ...ARIA,
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    tooltip: tooltipDefaults(col),
    grid: [{ left: 52, right: 16, top: 26, height: '34%' }, { left: 52, right: 16, top: '62%', bottom: 30 }],
    xAxis: [
      { type: 'category', gridIndex: 0, data: trend.map(t => t.date), ...axis, axisLabel: { show: false } },
      { type: 'category', gridIndex: 1, data: trend.map(t => t.date), ...axis, axisLabel: { ...axis.axisLabel, formatter: (v: string) => fmtDate(v, true), hideOverlap: true } },
    ],
    yAxis: [
      { type: 'value', gridIndex: 0, name: 'daily clicks', ...axisNum, splitNumber: 3 },
      { type: 'value', gridIndex: 1, name: 'avg position (1 = top)', nameLocation: 'start', inverse: true, scale: true, ...axis, splitNumber: 3 },
    ],
    series: [
      { name: 'clicks', type: 'bar', xAxisIndex: 0, yAxisIndex: 0, data: trend.map(t => t.clicks), itemStyle: { color: col.accent, borderRadius: [2, 2, 0, 0] }, barCategoryGap: '30%' },
      // Line breaks on days with no position data (null, never a dive to zero).
      { name: 'avg position', type: 'line', xAxisIndex: 1, yAxisIndex: 1, smooth: true, showSymbol: false, connectNulls: false, data: trend.map(t => (t.position > 0 ? Math.round(t.position * 10) / 10 : null)), lineStyle: { color: col.categorical[1], width: 1.75 }, itemStyle: { color: col.categorical[1] } },
    ],
  });
  $('rankSummary').textContent = `Average Google position (higher is better) and daily clicks over ${trend.length} days.`;

  // (Striking-distance now lives in the Opportunities quick-wins matrix - no separate scatter.)

  // 3b) Quick-wins matrix - CTR vs position against the expected-CTR curve, coloured by opportunity
  const qw = data.quickWins ?? [];
  if (qw.length) {
    // Expected-CTR curve derived from the data points (server's model) - no client-side duplication.
    const curveMap = new Map<number, number>();
    for (const q of qw) { const rp = Math.round(q.position); if (rp >= 1 && rp <= 10 && !curveMap.has(rp)) curveMap.set(rp, q.expectedCtr); }
    const curve = [...curveMap.entries()].sort((a, b) => a[0] - b[0]);
    const bub = (v: any) => Math.max(5, Math.min(26, 5 + Math.sqrt(v[2]) * 1.2));
    const SER_NAME: Record<string, string> = { striking: 'Striking distance', snippet: 'Under-clicked', serp: 'Verify (SERP/cannibalisation)', ok: 'On track' };
    const ser = (type: string, color: string, opacity: number) => ({
      name: SER_NAME[type], type: 'scatter', symbolSize: bub, itemStyle: { color, opacity },
      data: qw.filter(q => q.type === type).map(q => [q.position, q.ctr, q.impressions, q.expectedCtr, q.potential, q.query, q.type]),
    });
    wrap('quickWinsChart').setOption({
      ...ARIA,
      grid: { left: 56, right: 24, top: 40, bottom: 52 },
      legend: { top: 0, type: 'scroll', textStyle: { color: col.text, fontSize: 12 }, data: [SER_NAME.striking, SER_NAME.snippet, SER_NAME.serp, SER_NAME.ok, 'Expected CTR'] },
      tooltip: { ...tooltipDefaults(col, 'item'), formatter: (p: any) => Array.isArray(p.value) ? `${esc(String(p.value[5]))}<br/>pos ${p.value[0]} · CTR ${p.value[1]}% (expected ${p.value[3]}%)<br/>${fmt(p.value[2])} impressions${p.value[6] === 'serp' ? '<br/><em>near-zero CTR - likely a SERP feature or cannibalisation; verify before rewriting</em>' : ` · ~${fmt(p.value[4])} clicks recoverable`}` : '' },
      xAxis: { type: 'value', name: 'average position', nameLocation: 'middle', nameGap: 28, min: 0, max: 21, ...axis },
      // A little headroom below 0 so bubbles sitting at 0% CTR don't cover the x-axis labels.
      yAxis: { type: 'value', name: 'CTR %', min: (v: any) => -Math.ceil(v.max * 0.08), ...axis, axisLabel: { ...axis.axisLabel, formatter: (v: number) => (v < 0 ? '' : String(v)) } },
      series: [
        ser('ok', col.grey, 0.28),
        ser('serp', col.red, 0.5),
        ser('striking', col.amber, 0.7),
        ser('snippet', col.info, 0.7),
        { name: 'Expected CTR', type: 'line', data: curve, lineStyle: { color: col.text, type: 'dashed', width: 1.5, opacity: 0.5 }, symbol: 'none', tooltip: { show: false }, z: 1 },
      ],
    });
  } else {
    wrap('quickWinsChart').setEmpty(quickWinsEmptyReason({ hasGsc: !!data.summary, plotted: 0, wins: 0 })!, col);
  }

  // Biggest quick wins table - ranked by recoverable clicks
  const qwTop = qw.filter(q => q.type !== 'ok' && q.potential > 0).slice(0, 20);
  const qwTypeLabel: Record<string, string> = { striking: 'Striking distance', snippet: 'Under-clicked' };
  const qwRows = qwTop.map(q =>
    `<tr><td>${esc(q.query)}</td>` +
    `<td><span class="impact ${q.type === 'striking' ? 'impact-l' : 'impact-m'}">${qwTypeLabel[q.type] || q.type}</span></td>` +
    `<td class="num">${q.position.toFixed(1)}</td><td class="num">${fmt(q.impressions)}</td>` +
    `<td class="num">${q.ctr.toFixed(1)}% <span class="muted">/ ${q.expectedCtr.toFixed(1)}%</span></td>` +
    `<td class="num">${fmt(q.potential)}</td></tr>`).join('');
  // With nothing plotted the matrix's empty state already gives the reason: don't repeat it here.
  $('quickWinsTableCard').style.display = qw.length ? '' : 'none';
  $('quickWinsTable').innerHTML = qwTop.length
    ? `<table><thead><tr><th>Query</th><th>Opportunity</th><th class="num">Pos</th><th class="num">Impr</th><th class="num">CTR / exp.</th><th class="num">Clicks recoverable</th></tr></thead><tbody>${qwRows}</tbody></table>`
    : `<p class="muted">${esc(quickWinsEmptyReason({ hasGsc: !!data.summary, plotted: qw.length, wins: 0 }) ?? '')}</p>`;

  // Content decay - pages to refresh, ranked by clicks lost
  const decay = data.contentDecay ?? [];
  const decayRows = decay.map(d => {
    const path = esc(shortPath(d.urlKey || ''));
    return `<tr><td class="url" title="${esc(d.urlKey || '')}">${path}</td>` +
      `<td class="num">${fmt(d.prevClicks)}</td><td class="num">${fmt(d.clicks)}</td>` +
      `<td class="num"><span class="impact ${d.dropPct >= 60 ? 'impact-xl' : d.dropPct >= 35 ? 'impact-l' : 'impact-m'}">−${d.dropPct}%</span></td>` +
      `<td class="num">${fmt(d.lost)}</td><td class="num">${fmt(d.impressions)}</td><td class="num">${d.position ? d.position.toFixed(1) : '–'}</td></tr>`;
  }).join('');
  $('contentDecayTable').innerHTML = decay.length
    ? `<table><thead><tr><th>Page</th><th class="num">Was</th><th class="num">Now</th><th class="num">Drop</th><th class="num">Clicks lost</th><th class="num">Impressions</th><th class="num">Position</th></tr></thead><tbody>${decayRows}</tbody></table>`
    : `<p class="muted">No significant content decay - no page lost 20%+ of its clicks vs the prior ${winDays} days.</p>`;

  // Market Sizing and Prioritisation (market_sizing tool) - 100% stacked SoV per topic cluster.
  const ms = data.marketSizing;
  const msCard = document.getElementById('marketSizingCard');
  if (msCard) msCard.style.display = ms?.clusters?.length ? '' : 'none';
  if (ms?.clusters?.length) {
    const own = ms.domains[0];
    const clusters = [...ms.clusters].reverse(); // biggest topic at the top of the y axis
    const palette = [col.green, col.blue, col.amber, col.red, col.muted];
    wrap('marketSizingChart').setOption({
      ...ARIA,
      grid: { left: labelW(190) + 12, right: 30, top: 30, bottom: 34 },
      legend: { top: 0, type: 'scroll', textStyle: { color: col.text, fontSize: 12 } },
      tooltip: { ...tooltipDefaults(col), valueFormatter: (v: number) => `${v}% share of voice` },
      xAxis: { type: 'value', max: 100, name: '% share of voice (ETV)', nameLocation: 'middle', nameGap: 24, ...axisNum },
      yAxis: { type: 'category', data: clusters.map(c => `${c.head} (${fmt(c.volume)}/mo)`), ...catAxis(axis, 190) },
      series: ms.domains.map((d, i) => ({
        name: d === own ? `${d} (you)` : d,
        type: 'bar', stack: 'sov',
        itemStyle: { color: palette[i % palette.length], opacity: d === own ? 1 : 0.55 },
        data: clusters.map(c => c.sov[d] ?? 0),
      })),
    });
    const lead = ms.clusters.filter(c => c.leader === own).length;
    $('marketSizingSummary').textContent =
      `${fmt(ms.universeKeywords)} keywords, ${fmt(ms.universeVolume)} searches/mo total demand. Overall share of voice: ` +
      ms.domains.map(d => `${d} ${ms.sovByDomain[d]}%`).join(', ') +
      `. You lead ${lead} of ${ms.clusters.length} topic clusters.`;
  }

  // SERP-feature footprint (serp_features tool) - volume-weighted exposure per feature,
  // split by the page-1 ownership proxy. Card hidden until the tool has run.
  const fp = data.serpFootprint;
  const fpCard = document.getElementById('serpFeaturesCard');
  if (fpCard) fpCard.style.display = fp?.features?.length ? '' : 'none';
  if (fp?.features?.length) {
    const feats = [...fp.features].slice(0, 10).reverse(); // reverse: biggest ends up top of the y axis
    const r1 = (n: number): number => Math.round(n * 10) / 10;
    const owned = feats.map(f => r1(f.volumeSharePct * f.page1SharePct / 100));
    const exposed = feats.map(f => r1(f.volumeSharePct * (100 - f.page1SharePct) / 100));
    wrap('serpFeaturesChart').setOption({
      ...ARIA,
      grid: { left: labelW(150) + 12, right: 40, top: 30, bottom: 34 },
      legend: { top: 0, type: 'scroll', textStyle: { color: col.text, fontSize: 12 } },
      tooltip: { ...tooltipDefaults(col), valueFormatter: (v: number) => `${v}% of sampled volume` },
      xAxis: { type: 'value', name: '% of sampled search volume', nameLocation: 'middle', nameGap: 24, ...axisNum },
      yAxis: { type: 'category', data: feats.map(f => f.label), ...catAxis(axis, 150) },
      series: [
        { name: 'You rank page 1', type: 'bar', stack: 'fp', itemStyle: { color: col.green }, data: owned },
        { name: 'Not page 1', type: 'bar', stack: 'fp', itemStyle: { color: col.amber, opacity: 0.55 }, data: exposed },
      ],
    });
    const aio = fp.features.find(f => f.feature === 'ai_overview');
    $('serpFeaturesSummary').textContent =
      `Sample: top ${fmt(fp.sampleKeywords)} keywords by volume (${fmt(fp.sampleVolume)} searches/mo).` +
      (aio ? ` AI Overviews appear on ${aio.volumeSharePct}% of sampled volume; you rank page 1 for ${aio.page1SharePct}% of that.` : '');
  }

  // Cannibalisation - accordion per contested query, expand to the competing URLs
  const cannT = data.cannibalisationTable ?? [];
  $('cannTable').innerHTML = cannT.length
    ? cannT.map(q => {
        const verd = q.verdict === 'split'
          ? '<span class="impact impact-l">Split</span>'
          : '<span class="impact impact-s">Dominant</span>';
        // Cross-type (different page templates competing) is the most actionable - lead with it.
        const cross = q.crossType ? '<span class="impact impact-xl">Cross-type</span>' : '';
        const rows = q.urls.map(u => {
          const path = esc(shortPath(u.url || ''));
          return `<div class="rec-ex"><a class="rec-url" href="${esc(u.url || '')}" title="${esc(u.url || '')}" target="_blank" rel="noopener">${path}</a><span class="cann-type">${esc(u.template)}</span><span class="rec-ex-detail">pos ${u.position}</span><span class="rec-ex-traf">${fmt(u.clicks)} clicks · ${fmt(u.impressions)} impr</span></div>`;
        }).join('');
        return `<details class="rec-acc"><summary>` +
          `${cross}${verd}<span class="rec-title">“${esc(q.query)}”</span>` +
          `<span class="rec-count">${q.urlCount} URLs · ${fmt(q.totalClicks)} clicks · ${fmt(q.totalImpressions)} impr</span><span class="rec-chev" aria-hidden="true">${icons.chevron}</span>` +
          `</summary><div class="rec-body"><div class="rec-examples"><div class="rec-label">Competing URLs</div>${rows}</div></div></details>`;
      }).join('')
    : '<p class="muted">No cannibalisation detected - no query has 2+ of your URLs competing with real impressions.</p>';

  // 4) Top keyword performance (green/red + signed label so colour isn't the only cue)
  const kw = (data.topKeywords ?? []).slice().reverse(); // horizontal bar reads top-down
  const kwWrap = wrap('kwChart');
  kwWrap.setOption({
    ...ARIA,
    grid: { left: 16, right: 44, top: 10, bottom: 24, containLabel: true },
    tooltip: { ...tooltipDefaults(col, 'item'), formatter: (pa: any) => `${esc(String(pa.name))}<br/>Δ clicks: ${pa.value >= 0 ? '+' : ''}${pa.value} (now ${kw[pa.dataIndex].clicks})` },
    xAxis: { type: 'value', ...axisNum, splitNumber: 4, axisLabel: { ...axisNum.axisLabel, hideOverlap: true } },
    yAxis: { type: 'category', data: kw.map(k => k.query), axisLabel: { color: col.text, width: labelW(200), overflow: 'truncate' }, axisLine: { lineStyle: { color: col.border } } },
    series: [{
      type: 'bar',
      label: { show: true, position: 'right', color: col.muted, fontSize: 11, formatter: (p: any) => (p.value > 0 ? '+' : '') + p.value },
      data: kw.map(k => ({ value: k.clicksChange, itemStyle: { color: k.clicksChange >= 0 ? col.green : col.red } })),
    }],
  });
  kwWrap.on('click', (pa: any) => { void loadRelated(kw[pa.dataIndex].query); });
  const up = kw.filter(k => k.clicksChange > 0).length, down = kw.filter(k => k.clicksChange < 0).length;
  $('kwSummary').textContent = `${kw.length} top keywords; ${up} improved and ${down} declined versus the prior period (signed click change shown on each bar).`;

  // Report tables (agency-style)
  const pp = data.pagePerformance ?? [];
  $('pagePerfTable').innerHTML = pp.length
    ? tableHtml(['Trend', 'Page', 'Clicks', 'Clicks change', 'Impressions', 'Position'], pp.map(p => `<tr><td><span class="cat ${catClass(p.category)}">${p.category}</span></td><td class="url" title="${esc(p.urlKey)}">${esc(shortPath(p.urlKey))}</td><td class="num" data-sort="${p.clicks}">${fmt(p.clicks)}</td><td class="num" data-sort="${p.clicks - p.prevClicks}">${countDelta(p.clicks, p.prevClicks)}</td><td class="num" data-sort="${p.impressions}">${fmt(p.impressions)}</td><td class="num">${Number(p.position).toFixed(1)}</td></tr>`))
    : `<div class="hint">No page appears in Search Console in the last ${winDays} days.</div>`;
  $('pagePerfSummary').textContent = `${pp.length} pages categorised by ${winDays}-day trend.`;

  const mv = data.keywordMovement ?? [];
  $('movementTable').innerHTML = mv.length
    ? tableHtml(['Movement', 'Query', 'First pos', 'Latest pos', 'Pos change'], mv.map(m => `<tr><td><span class="cat ${catClass(m.category)}">${m.category}</span></td><td>${esc(m.query)}</td><td class="num">${Number(m.firstPos).toFixed(1)}</td><td class="num">${Number(m.lastPos).toFixed(1)}</td><td class="num" data-sort="${m.delta}">${rankDelta(m.lastPos, m.firstPos, { short: true })}</td></tr>`))
    : '<div class="hint">No query moved: none with 50+ impressions in the last 90 days moved 3+ positions, or into or out of the top 3, between its first and latest day.</div>';
  $('movementSummary').textContent = `${mv.length} queries with rank movement.`;

  const dv = data.deviceBreakdown ?? [];
  $('deviceTable').innerHTML = dv.length
    ? tableHtml(['Device', 'Clicks', 'Prev clicks', 'CTR', 'Position'], dv.map(d => `<tr><td>${esc(d.device.charAt(0) + d.device.slice(1).toLowerCase())}</td><td class="num" data-sort="${d.clicks}">${fmt(d.clicks)}</td><td class="num" data-sort="${d.prevClicks}">${fmt(d.prevClicks)}</td><td class="num">${(d.ctr * 100).toFixed(1)}%</td><td class="num">${Number(d.position).toFixed(1)}</td></tr>`))
    : '<div class="hint">-</div>';

  const ct = data.countryBreakdown ?? [];
  $('countryTable').innerHTML = ct.length
    ? tableHtml(['Country', 'Clicks', 'Prev clicks', 'Impressions'], ct.map(c => `<tr><td>${esc(c.country.toUpperCase())}</td><td class="num" data-sort="${c.clicks}">${fmt(c.clicks)}</td><td class="num" data-sort="${c.prevClicks}">${fmt(c.prevClicks)}</td><td class="num" data-sort="${c.impressions}">${fmt(c.impressions)}</td></tr>`))
    : '<div class="hint">-</div>';
  // Hide breakdowns that carry only one value (e.g. a single-country property) - a one-row table is
  // noise, not insight. Show a block only with genuine variety (2+ rows); hide the card if neither has.
  // Empty because no segment rows fall in the window (0.16.2): show the card and say why, never hide it.
  const why = emptyBreakdowns({ devices: dv.length, countries: ct.length, segmentsLastDate: data.segmentsLastDate, windowStart: data.breakdownWindowStart });
  const showDev = dv.length >= 2, showCty = ct.length >= 2;
  const setVis = (id: string, on: boolean): void => { const e = document.getElementById(id); if (e) e.style.display = on ? '' : 'none'; };
  const emptyEl = document.getElementById('breakdownsEmpty');
  if (emptyEl) { emptyEl.innerHTML = why ?? ''; emptyEl.style.display = why ? '' : 'none'; }
  setVis('deviceBlock', !why && showDev); setVis('countryBlock', !why && showCty); setVis('breakdownsCard', !!why || showDev || showCty);

  // Make the data tables click-to-sort by any column (the findings list is excluded - its rows come
  // in expand/detail pairs that re-ordering would break).
  ['quickWinsTable', 'contentDecayTable', 'pagePerfTable', 'movementTable', 'deviceTable', 'countryTable'].forEach(id => attachSort($(id)));

  renderLinks(data);
  renderResearch(data);
  renderTrapped(data);
  setupTabs();
  alignTableHeads();
  openDeepLinkedTab();
}

/** Right-align each header whose column holds numbers (td.num), so headers sit over their figures. */
function alignTableHeads(): void {
  document.querySelectorAll<HTMLTableElement>('#content table').forEach(t => {
    const row = t.tBodies[0]?.rows[0];
    const heads = t.tHead?.rows[0]?.cells;
    if (!row || !heads) return;
    [...row.cells].forEach((td, i) => { if (td.classList.contains('num') && heads[i]) heads[i].classList.add('num'); });
  });
}

// Deep-link a tab (?tab=links) so a headless capture / shared link opens that panel on load.
// ?tab=overview (the retired landing tab) opens the Summary.
function openDeepLinkedTab(): void {
  const raw = new URLSearchParams(location.search).get('tab');
  const wantTab = raw === 'overview' ? 'summary' : raw;
  if (wantTab) (document.querySelector(`.tab-btn[data-panel="${wantTab}"]:not([disabled])`) as HTMLButtonElement | null)?.click();
}

function summaryCtx(col: ReturnType<typeof palette>): SummaryCtx {
  return {
    wrap, col, shortPath, safeJson, catLabel: CAT_LABEL,
    redacted: document.documentElement.classList.contains('redacted'),
    gotoIssues: (f): void => {
      (document.querySelector('.tab-btn[data-panel="issues"]') as HTMLButtonElement | null)?.click();
      const list = document.getElementById('issuesListView'), grouped = document.getElementById('issuesGroupedView');
      if (list && grouped) { list.style.display = 'block'; grouped.style.display = 'none'; }
      document.querySelectorAll('#issuesToggle .seg-btn').forEach(b => b.classList.toggle('active', (b as HTMLElement).dataset.view === 'list'));
      issuesFilter?.(f);
      document.getElementById('findingsCard')?.scrollIntoView({ block: 'start' });
    },
  };
}

/** No Search Console data, but a crawl / audit exists: the Summary and Issues, other tabs disabled. */
function renderCrawlOnly(data: DashboardData): void {
  $('empty').style.display = 'none';
  $('content').style.display = 'block';
  $('site').textContent = data.siteUrl;
  $('range').textContent = 'no Search Console data';
  const col = palette();
  renderSummary(data, summaryCtx(col));
  renderFindings(data.findings, col);
  renderRecommendations(data.findings);
  buildExportBar(data);
  const usable = new Set(['summary', 'issues', 'market', 'ai']);
  document.querySelectorAll<HTMLButtonElement>('.tab-btn').forEach(b => {
    const on = usable.has(b.dataset.panel ?? '');
    b.disabled = !on;
    if (on) b.removeAttribute('title'); else b.title = 'Needs Search Console data - run sync_gsc';
  });
  setupTabs();
  openDeepLinkedTab();
}

// Table sorting lives in the display library (lib/data-grid.ts: attachSort).

// Tabbed nav: switch panels, and resize the ECharts in the newly-shown panel - charts created in a
// display:none panel lay out at 0×0, so they must be resized once their container is visible.
/** Every window-dependent label reads the current window; the Summary keeps its fixed 28 days. */
function applyWindowLabels(): void {
  document.querySelectorAll<HTMLElement>('[data-win]').forEach(el => { el.textContent = String(winDays); });
  const sel = document.getElementById('rangeDays') as HTMLSelectElement | null;
  if (sel) sel.value = String(winDays);
  syncRangeControl();
}

/** Tabs whose data is monthly DataForSEO history, not a Search Console window. */
const MONTHLY_TABS = new Set(['market', 'ai']);

/** The window control shows on the tabs it drives; on the Summary a fixed label says what it uses;
 * the Market and AI visibility tabs (monthly DataForSEO data) show neither. */
function syncRangeControl(): void {
  const ctl = document.getElementById('rangeCtl');
  const tab = document.querySelector('.tab-btn.active')?.getAttribute('data-panel') ?? 'summary';
  const onSummary = tab === 'summary', monthly = MONTHLY_TABS.has(tab);
  const hasGsc = !!currentData?.summary;
  if (ctl) ctl.hidden = !__sacWeb || !hasGsc || onSummary || monthly;
  const r = document.getElementById('range');
  const dr = currentData?.dateRange;
  if (!r) return;
  if (monthly) r.textContent = '';
  else if (dr?.maxDate) r.textContent = onSummary || !__sacWeb ? `last ${onSummary ? 28 : winDays} days to ${fmtDate(dr.maxDate)}` : `to ${fmtDate(dr.maxDate)}`;
}

/** Change the window: refetch the payload for it and re-render, keeping the open tab. */
function setupRangeControl(): void {
  const sel = document.getElementById('rangeDays') as HTMLSelectElement | null;
  if (!sel) return;
  sel.value = String(winDays);
  sel.addEventListener('change', () => {
    const d = Number(sel.value);
    if (!WINDOWS.includes(d) || d === winDays) return;
    winDays = d;
    const u = new URL(location.href);
    if (d === 28) u.searchParams.delete('days'); else u.searchParams.set('days', String(d));
    const tab = document.querySelector('.tab-btn.active')?.getAttribute('data-panel');
    if (tab && tab !== 'summary') u.searchParams.set('tab', tab);
    history.replaceState(null, '', u);
    sel.disabled = true;
    dataLoaded = false;
    void loadDashboard(loadedSite).finally(() => { sel.disabled = false; });
  });
}

function setupTabs(): void {
  const resizeVisible = (): void => { for (const w of chartsReg.values()) w.resizeIfVisible(); };
  document.querySelectorAll<HTMLButtonElement>('.tab-btn').forEach(btn => {
    btn.onclick = (ev: MouseEvent): void => {
      const panel = btn.dataset.panel;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll<HTMLElement>('.tab-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === panel));
      const title = document.getElementById('pageTitle');
      if (title) title.textContent = btn.textContent?.trim() || 'Summary';
      syncRangeControl();
      // Scroll to the top only for a real click: programmatic .click() (deep-link restore on every
      // re-render, [data-goto] cross-links) must not lose the reader's place.
      if (ev.isTrusted) window.scrollTo({ top: 0 });
      if (panel === 'architecture' && pendingNetworkDraw) { const draw = pendingNetworkDraw; pendingNetworkDraw = null; draw(); }
      resizeVisible();
    };
  });

  // Cross-links ("Open network →", "All findings →"): any [data-goto] jumps to that panel.
  document.querySelectorAll<HTMLElement>('[data-goto]').forEach(el => {
    el.onclick = (): void => (document.querySelector(`.tab-btn[data-panel="${el.dataset.goto}"]`) as HTMLButtonElement | null)?.click();
  });

  // Issues & fixes: toggle between the prioritised list and the by-category (with fixes) view.
  const list = $('issuesListView'), grouped = $('issuesGroupedView');
  document.querySelectorAll<HTMLButtonElement>('#issuesToggle .seg-btn').forEach(btn => {
    btn.onclick = (): void => {
      const showList = btn.dataset.view === 'list';
      document.querySelectorAll('#issuesToggle .seg-btn').forEach(b => b.classList.toggle('active', b === btn));
      list.style.display = showList ? 'block' : 'none';
      grouped.style.display = showList ? 'none' : 'block';
    };
  });
}

function buildExportBar(data: DashboardData): void {
  const bar = $('exportbar');
  bar.innerHTML = '';
  const mk = (label: string, fn: () => void): void => {
    const b = document.createElement('button');
    b.className = 'btn';
    b.innerHTML = `${icons.download} ${esc(label)}`;
    b.onclick = fn;
    bar.appendChild(b);
  };
  if (data.findings?.top?.length) {
    mk('Findings CSV', () => downloadCsv('seo-findings.csv', [
      ['severity', 'check', 'url', 'clicks', 'impressions', 'position', 'priority', 'fix'],
      ...data.findings!.top.map(f => {
        const rec = safeJson(f.recommendation), t = safeJson(f.traffic_at_risk);
        return [f.severity, f.check_id, f.url_key ?? '', t.clicks ?? 0, t.impressions ?? 0, t.position ? t.position.toFixed(1) : '', f.priority.toFixed(3), rec.text ?? ''];
      }),
    ]));
  }
  if (data.topKeywords?.length) {
    mk('Keywords CSV', () => downloadCsv('keywords.csv', [
      ['query', 'clicks', 'prevClicks', 'clicksChange', 'avgPosition', 'prevPosition'],
      ...data.topKeywords!.map(k => [k.query, k.clicks, k.prevClicks, k.clicksChange, k.position, k.prevPosition]),
    ]));
  }
  if (data.strikingDistance?.length) {
    mk('Striking-distance CSV', () => downloadCsv('striking-distance.csv', [
      ['query', 'position', 'impressions', 'clicks'],
      ...data.strikingDistance!.map(s => [s.query, s.position, s.impressions, s.clicks]),
    ]));
  }
  if (data.pagePerformance?.length) {
    mk('Pages CSV', () => downloadCsv('page-performance.csv', [
      ['category', 'url', 'clicks', 'prevClicks', 'clicksChangePct', 'impressions', 'position'],
      ...data.pagePerformance!.map(p => [p.category, p.urlKey, p.clicks, p.prevClicks, p.clicksChangePct, p.impressions, p.position]),
    ]));
  }
  if (data.keywordMovement?.length) {
    mk('Movement CSV', () => downloadCsv('keyword-movement.csv', [
      ['category', 'query', 'firstPos', 'lastPos', 'delta', 'firstDate', 'lastDate'],
      ...data.keywordMovement!.map(m => [m.category, m.query, m.firstPos, m.lastPos, m.delta, m.firstDate, m.lastDate]),
    ]));
  }
}

// ── Phase 2: the Overview report hub + the two key-gated tabs (Links, Content research) ──
// Affiliate links for the upsell states (Richard's).
const AFFILIATE: Record<string, string> = {
  dataforseo: 'https://dataforseo.com/?aff=213701',
  majestic: 'https://majestic.com/plans-pricing',
};
function upsellCard(o: { title: string; lead: string; provider: keyof typeof AFFILIATE; cta: string }): string {
  return `<div class="chart-card upsell">
    <div class="upsell-badge">API key needed</div>
    <h3>${esc(o.title)}</h3>
    <div class="hint">${esc(o.lead)}</div>
    <a class="btn btn-primary" href="${AFFILIATE[o.provider]}" target="_blank" rel="noopener noreferrer">${esc(o.cta)} →</a>
  </div>`;
}

// Links tab, top half (#47): OUR backlink profile from pull_backlinks. Every number is a stored
// row; a section whose table was never filled says "not collected" rather than showing zero.
function renderBacklinkProfile(data: DashboardData): void {
  const top = document.getElementById('backlinkProfilePanel');
  const trendCard = document.getElementById('backlinkTrendCard');
  const detail = document.getElementById('backlinkDetailPanel');
  if (!top || !trendCard || !detail) return;
  const bp = data.backlinkProfile;
  const noKey = data.apiKeys && !data.apiKeys.dataforseo;
  const runHint = `Ask Claude to run <code>pull_backlinks for ${esc(data.siteUrl)}</code> (DataForSEO Backlinks subscription; cached 20 days).`;
  if (!bp) {
    top.innerHTML = `<div class="chart-card"><h3>Backlink profile</h3><div class="hint">${noKey ? 'Not collected — DataForSEO isn’t connected, so your own backlink profile hasn’t been pulled.' : `Not collected yet. ${runHint} It stores the summary, the backlinked pages with their live status, the referring domains, the anchor mix and twelve months of new/lost history.`}</div></div>`;
    trendCard.hidden = true; detail.innerHTML = '';
    return;
  }
  const s = bp.summary;
  const when = (iso: string | null | undefined): string => iso ? esc(String(iso).slice(0, 10)) : 'unknown date';
  const nc = (what: string): string => `<div class="empty-state">${what} not collected: this profile was pulled before the dashboard stored it. Re-run <code>pull_backlinks</code> to add it.</div>`;
  const kpis = s ? kpiGrid([
    { label: 'Backlinks', value: fmtNum(s.backlinks) },
    { label: 'Referring domains', value: fmtNum(s.referringDomains) },
    { label: 'Domain Rank', value: s.domainRank == null ? '–' : String(s.domainRank) },
    { label: 'Broken backlinks', value: fmtNum(s.brokenBacklinks) },
    { label: 'Nofollow share', value: s.nofollowPct == null ? '–' : `${Math.round(s.nofollowPct * 100)}%` },
  ]).replace('<div class="metrics">', '<div class="metrics metrics-5">') : nc('Summary');
  top.innerHTML = `<div class="chart-card"><h3>Backlink profile — your own links</h3>
    <div class="hint">From <code>pull_backlinks</code>${s ? `, summary pulled ${when(s.fetchedAt)}` : ''}: ${fmtNum(bp.pagesTotal)} backlinked pages stored${bp.pagesUnchecked ? `, ${fmtNum(bp.pagesUnchecked)} without a live status check` : ''}. Domain Rank is DataForSEO’s 0–1000 authority score.</div>
    ${kpis}</div>`;

  // Trend: new vs lost referring domains per month (DataForSEO daily history, summed per month).
  const months = bp.history?.months ?? [];
  if (months.length) {
    trendCard.hidden = false;
    const col = palette(), axis = axisDefaults(col);
    (document.getElementById('backlinkTrendHint') as HTMLElement).textContent = `${months.length} months of daily history (pulled ${bp.history?.fetchedAt ? String(bp.history.fetchedAt).slice(0, 10) : 'unknown date'}); a partial first or last month covers only the days DataForSEO reported.`;
    wrap('backlinkTrendChart').setOption({
      ...ARIA,
      grid: { left: 48, right: 16, top: 28, bottom: 28 },
      legend: { top: 0, textStyle: { color: col.text, fontSize: 12 } },
      tooltip: { ...tooltipDefaults(col), axisPointer: { type: 'shadow' } },
      xAxis: { type: 'category', data: months.map(m => m.month), ...axis },
      yAxis: { type: 'value', ...axis },
      series: [
        { name: 'New referring domains', type: 'bar', data: months.map(m => m.newDomains), itemStyle: { color: col.green } },
        { name: 'Lost referring domains', type: 'bar', data: months.map(m => -m.lostDomains), itemStyle: { color: col.red } },
      ],
    });
  } else {
    trendCard.hidden = true;
  }

  const tbl = (head: string, body: string): string => `<div class="findings-table"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
  const rd = bp.referringDomains;
  const rdHtml = rd
    ? `<div class="hint">${fmtNum(rd.live)} live referring domains in the latest pull (${when(rd.snapshotAt)}), ${fmtNum(rd.lost)} lost. Top by DataForSEO domain rank.</div>` +
      tbl('<tr><th>Domain</th><th class="num">Rank</th><th class="num">Backlinks</th><th class="num">Pages</th><th>Link</th><th class="num">Spam</th><th>First seen</th></tr>',
        rd.top.map(d => `<tr><td>${esc(d.domain)}</td><td class="num">${d.rank ?? '–'}</td><td class="num">${fmtNum(d.backlinks)}</td><td class="num">${fmtNum(d.referringPages)}</td><td>${d.referringPages > 0 && d.nofollowPages >= d.referringPages ? 'nofollow' : 'follow'}</td><td class="num">${d.spamScore ?? '–'}</td><td>${d.firstSeen ? esc(d.firstSeen) : '–'}</td></tr>`).join(''))
    : nc('Referring domains');
  const an = bp.anchors;
  const anTotal = an ? an.mix.reduce((a, m) => a + m.backlinks, 0) : 0;
  const KIND_LABEL: Record<string, string> = { branded: 'Branded', keyword: 'Keyword / exact', url: 'URL', generic: 'Generic', empty: 'Empty / image' };
  const anHtml = an
    ? `<div class="hint">Live anchors in the latest pull (${when(an.snapshotAt)}), classified by text: branded (contains your name), URL, generic (“click here”), empty (image or no text), everything else keyword. Share is by backlinks.</div>` +
      tbl('<tr><th>Anchor type</th><th class="num">Anchors</th><th class="num">Backlinks</th><th class="num">Share</th><th class="num">Ref. domains</th></tr>',
        an.mix.map(m => `<tr><td>${esc(KIND_LABEL[m.kind] ?? m.kind)}</td><td class="num">${fmtNum(m.anchors)}</td><td class="num">${fmtNum(m.backlinks)}</td><td class="num">${sharePct(m.backlinks, anTotal)}</td><td class="num">${fmtNum(m.referringDomains)}</td></tr>`).join('')) +
      `<details><summary class="hint">Top ${an.top.length} anchors</summary>` +
      tbl('<tr><th>Anchor</th><th>Type</th><th class="num">Backlinks</th><th class="num">Ref. domains</th></tr>',
        an.top.map(t => `<tr><td>${t.anchor ? esc(t.anchor) : '<i>(empty)</i>'}</td><td>${esc(KIND_LABEL[t.kind] ?? t.kind)}</td><td class="num">${fmtNum(t.backlinks)}</td><td class="num">${fmtNum(t.referringDomains)}</td></tr>`).join('')) + '</details>'
    : nc('Anchor mix');
  const pagesHtml = bp.topPages.length
    ? tbl('<tr><th>Page</th><th class="num">Ref. domains</th><th class="num">Backlinks</th><th class="num">Follow</th><th class="num">Live status</th>' + (bp.topPages.some(p => p.trustFlow != null) ? '<th class="num">Trust Flow</th>' : '') + '</tr>',
        bp.topPages.map(p => `<tr><td class="url">${esc(p.url)}</td><td class="num">${fmtNum(p.referringDomains)}</td><td class="num">${fmtNum(p.backlinks)}</td><td class="num">${fmtNum(p.dofollow)}</td><td class="num">${p.status == null ? 'unchecked' : statusBadge(p.status)}</td>${bp.topPages.some(q => q.trustFlow != null) ? `<td class="num">${p.trustFlow ?? '–'}</td>` : ''}</tr>`).join(''))
    : nc('Backlinked pages');
  const brokenHtml = bp.brokenPages.length
    ? `<div class="hint">${bp.brokenPages.length} backlinked page${bp.brokenPages.length === 1 ? '' : 's'} answer${bp.brokenPages.length === 1 ? 's' : ''} 4xx/5xx — equity arriving at a dead end. <code>triage_404s</code> proposes the 301 map; the audit reports <code>backlinks-to-404</code>.</div>` +
      tbl('<tr><th>Page</th><th class="num">Status</th><th class="num">Ref. domains</th><th class="num">Backlinks</th></tr>',
        bp.brokenPages.map(p => `<tr><td class="url">${esc(p.url)}</td><td class="num">${statusBadge(p.status)}</td><td class="num">${fmtNum(p.referringDomains)}</td><td class="num">${fmtNum(p.backlinks)}</td></tr>`).join(''))
    : `<div class="hint">${bp.pagesTotal ? `No backlinked page answers 4xx/5xx${bp.pagesUnchecked ? ` (${fmtNum(bp.pagesUnchecked)} unchecked)` : ''}.` : 'Not collected.'}</div>`;
  detail.innerHTML = `<div class="chart-card"><h3>Top referring domains</h3>${rdHtml}</div>
    <div class="chart-card"><h3>Anchor mix</h3>${anHtml}</div>
    <div class="chart-card"><h3>Most-linked pages</h3><div class="hint">Your pages by referring domains, with the live HTTP status pull_backlinks resolved.</div>${pagesHtml}</div>
    <div class="chart-card"><h3>Broken backlinked pages</h3>${brokenHtml}</div>`;
}

// Links tab: render the stored link_prospects, or the DataForSEO upsell / a run-it prompt.
function renderLinks(data: DashboardData): void {
  renderBacklinkProfile(data);
  const el = document.getElementById('linksPanel');
  if (!el) return;
  // Stored prospects show whatever the key state: the key gates new pulls, not data already held.
  if (data.apiKeys && !data.apiKeys.dataforseo && !(data.linkProspects ?? []).length) {
    el.innerHTML = upsellCard({ title: 'Link intersect — the links your competitors have that you don’t', lead: 'Find the domains linking to your competitors but not to you, ranked by authority — a ready-made outreach list. Needs a DataForSEO account (with the Backlinks subscription). An optional Majestic key re-sorts by Trust Flow.', provider: 'dataforseo', cta: 'Get DataForSEO' });
    return;
  }
  const rows = data.linkProspects ?? [];
  if (!rows.length) {
    el.innerHTML = `<div class="chart-card"><h3>Link intersect</h3><div class="hint">No prospects captured yet. Ask Claude to run <code>link_intersect for ${esc(data.siteUrl)} vs your competitors</code> — it finds domains linking to your rivals but not you, sorted followed-first then by domain trust (or Majestic Trust Flow when a key is set).</div></div>`;
    return;
  }
  const enriched = rows.some(r => r.trustFlow != null);
  const trustHead = enriched ? 'Trust Flow' : 'Domain trust';
  const trs = rows.map(r => `<tr><td>${esc(r.domain)}</td><td class="num">${r.intersections}</td><td class="num">${enriched ? (r.trustFlow ?? '–') : (r.domainTrust ?? '–')}</td><td>${r.dofollow ? 'follow' : 'nofollow'}</td><td class="num">${r.spamScore ?? '–'}</td>${enriched ? `<td>${esc(r.topTopic ?? '–')}</td>` : ''}</tr>`).join('');
  const comps = rows[0]?.competitors ?? [];
  el.innerHTML = `<div class="chart-card"><h3>Link intersect — competitors’ links you don’t have</h3>
    <div class="hint">Domains linking to ${comps.length ? esc(comps.join(', ')) : 'your competitor set'} but not to you. ${enriched ? 'Sorted by Majestic Trust Flow (kills directory noise).' : 'Sorted by DataForSEO domain trust — set a Majestic key to re-sort by Trust Flow.'} ${rows.length} prospects${rows[0]?.fetchedAt ? `, captured ${esc(fmtDate(String(rows[0].fetchedAt)))}` : ''}.</div>
    <div class="findings-table"><table><thead><tr><th>Prospect domain</th><th class="num">Links to</th><th class="num">${trustHead}</th><th>Link</th><th class="num">Spam</th>${enriched ? '<th>Top topic</th>' : ''}</tr></thead><tbody>${trs}</tbody></table></div></div>`;
}

// Content research tab: interactive News / Videos / Trends (on-demand), or the DataForSEO upsell.
function renderResearch(data: DashboardData): void {
  const el = document.getElementById('researchPanel');
  if (!el) return;
  if (data.apiKeys && !data.apiKeys.dataforseo) {
    el.innerHTML = upsellCard({ title: 'Content research — News, Videos & Trends', lead: 'The news articles, YouTube videos and Google-Trends interest behind any topic — the freshness and query-fan-out signals that feed AI answers. Needs a DataForSEO account.', provider: 'dataforseo', cta: 'Get DataForSEO' });
    return;
  }
  el.innerHTML = `<div class="chart-card"><h3>Content research</h3>
    <div class="hint">On-demand DataForSEO — the news, videos and trend interest for a topic. Each is a live, 20-day-cached SERP call.</div>
    <div class="research-bar"><input id="researchKw" type="text" placeholder="Enter a topic or keyword…" aria-label="Research keyword" /><button class="btn" data-research="news">News</button><button class="btn" data-research="youtube">Videos</button><button class="btn" data-research="topic_trend">Trend</button></div>
    <div id="researchOut" class="research-out"></div></div>`;
  const out = document.getElementById('researchOut') as HTMLElement;
  const kw = document.getElementById('researchKw') as HTMLInputElement;
  if ((window as any).__DASH_FIXTURE__ && !__sacWeb) out.innerHTML = `<div class="empty-state">This is a static export — open the live dashboard (<code>get_dashboard</code> or <code>serve_dashboard</code>) to run research.</div>`;
  el.querySelectorAll<HTMLButtonElement>('[data-research]').forEach(b => { b.onclick = (): void => { void runResearch(b.dataset.research!, kw.value.trim(), out); }; });
  kw.addEventListener('keydown', e => { if (e.key === 'Enter') void runResearch('news', kw.value.trim(), out); });
}

async function runResearch(kind: string, keyword: string, out: HTMLElement): Promise<void> {
  if (!keyword) { out.innerHTML = `<div class="empty-state">Enter a topic first.</div>`; return; }
  out.innerHTML = `<div class="empty-state">Looking up “${esc(keyword)}”…</div>`;
  const tbl = (head: string, body: string): string => `<div class="findings-table"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
  try {
    if (kind === 'youtube') {
      const vids: any[] = ((await callServer('youtube_discovery', { keyword })) as any)?.structuredContent?.videos ?? [];
      out.innerHTML = vids.length ? tbl('<tr><th>Video</th><th>Channel</th><th class="num">Views</th><th>Published</th></tr>', vids.slice(0, 20).map(v => `<tr><td><a class="rec-url" href="${esc(v.url ?? '#')}" target="_blank" rel="noopener">${esc(v.title ?? '(untitled)')}</a></td><td>${esc(v.channel ?? '–')}</td><td class="num">${v.views != null ? Number(v.views).toLocaleString() : '–'}</td><td>${esc(v.published ?? '–')}</td></tr>`).join('')) : `<div class="empty-state">No videos for “${esc(keyword)}”.</div>`;
    } else if (kind === 'topic_trend') {
      const series: any[] = ((await callServer('topic_trend', { keywords: [keyword] })) as any)?.structuredContent?.series ?? [];
      const vals = series.map(s => s.values?.[keyword]).filter((v: any): v is number => typeof v === 'number');
      if (!vals.length) { out.innerHTML = `<div class="empty-state">No trend data for “${esc(keyword)}”.</div>`; return; }
      const w = Math.max(1, Math.floor(vals.length / 4)), avg = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
      const first = avg(vals.slice(0, w)), last = avg(vals.slice(-w));
      const dir = last > first * 1.1 ? 'rising' : last < first * 0.9 ? 'falling' : 'flat';
      out.innerHTML = `<div class="metric-card" style="max-width:340px"><div class="label">Google Trends — “${esc(keyword)}”</div><div class="value">${dir}</div><div class="hint">${series.length} points · ${Math.round(first)}→${Math.round(last)}, peak ${Math.max(...vals)}</div></div>`;
    } else {
      const arts: any[] = ((await callServer('news_discovery', { keyword })) as any)?.structuredContent?.articles ?? [];
      out.innerHTML = arts.length ? tbl('<tr><th>Article</th><th>Source</th><th>When</th></tr>', arts.slice(0, 20).map(a => `<tr><td><a class="rec-url" href="${esc(a.url ?? '#')}" target="_blank" rel="noopener">${esc(a.title ?? '(untitled)')}</a></td><td>${esc(a.source ?? '–')}</td><td>${esc(a.timestamp ?? '–')}</td></tr>`).join('')) : `<div class="empty-state">No news for “${esc(keyword)}”.</div>`;
    }
  } catch (e) {
    out.innerHTML = `<div class="empty-state">Lookup failed: ${esc(e instanceof Error ? e.message : String(e))}</div>`;
  }
}

// Trapped authority (Architecture tab): external authority (referring domains) buried deep
// internally — the fix is to link to these pages from higher up. Needs pull_backlinks.
function renderTrapped(data: DashboardData): void {
  const el = document.getElementById('trappedTable');
  if (!el) return;
  const rows = data.trappedAuthority ?? [];
  if (!rows.length) {
    // From the STORED backlink rows (the Links tab and the Summary coverage read the same), not the key.
    const stored = Math.max(data.backlinkProfile?.pagesTotal ?? 0, (data as any).coverage?.backlinkPages ?? 0);
    el.innerHTML = `<div class="empty-state">${esc(trappedEmptyReason({ backlinkPages: stored, hasKey: data.apiKeys ? data.apiKeys.dataforseo : null }))}</div>`;
    return;
  }
  // Majestic-enriched view shows Trust Flow + the page's top topic; otherwise the DataForSEO view.
  const enriched = rows.some(r => r.trustFlow != null);
  const head = `<tr><th>Page</th><th class="num">Ref domains</th>${enriched ? '<th class="num">Trust Flow</th><th>Top topic</th>' : '<th class="num">Backlinks</th>'}<th class="num">Click depth</th><th class="num">iPR</th></tr>`;
  const body = rows.map(r => `<tr><td class="url" title="${esc(r.url)}">${esc(shortPath(r.url))}</td><td class="num">${fmt(r.referringDomains)}</td>${enriched ? `<td class="num">${r.trustFlow ?? '–'}</td><td>${esc(r.topTopic ?? '–')}</td>` : `<td class="num">${fmt(r.backlinks)}</td>`}<td class="num" title="${r.clickDepth == null ? 'Not reachable through in-content links from the homepage' : ''}">${r.clickDepth == null ? 'unreachable' : r.clickDepth}</td><td class="num">${r.ipr}</td></tr>`).join('');
  el.innerHTML = `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

// On-demand only: fetch DataForSEO data for the ONE clicked keyword (never bulk -
// a site can have a million keywords; we enrich what's on screen / clicked).
async function loadRelated(keyword: string): Promise<void> {
  const el = $('related');
  el.innerHTML = `<div class="group-label">Looking up “${esc(keyword)}”…</div>`;
  try {
    const [relRes, volRes] = await Promise.all([
      callServer('related_terms', { keyword }),
      callServer('keyword_volume', { keywords: [keyword] }).catch(() => null),
    ]);
    const sc = relRes?.structuredContent ?? {};
    const paa: string[] = sc.peopleAlsoAsk ?? [];
    const rel: string[] = sc.relatedSearches ?? [];
    const vol = volRes?.structuredContent?.keywords?.[0];
    const tags = (xs: string[]): string => xs.map(x => `<span class="tag">${esc(String(x))}</span>`).join('');
    el.innerHTML =
      (vol ? `<div class="group-label">“${esc(keyword)}” - search volume</div><span class="tag">${esc(String(vol.searchVolume ?? 'n/a'))}/mo</span><span class="tag">CPC ${esc(String(vol.cpc ?? 'n/a'))}</span>` : '') +
      (paa.length ? `<div class="group-label">People also ask</div>${tags(paa)}` : '') +
      (rel.length ? `<div class="group-label">Related searches</div>${tags(rel)}` : '') +
      (!paa.length && !rel.length && !vol ? `<div class="group-label">No DataForSEO data for “${esc(keyword)}”.</div>` : '');
  } catch (e) {
    el.innerHTML = `<div class="group-label">Lookup failed: ${esc(e instanceof Error ? e.message : String(e))}</div>`;
  }
}

// Light/dark toggle (pricemonitor ◐). Reuses the existing theme path: applyHostContext
// stamps data-theme + the .dark class, then render(currentData) re-tints the ECharts
// (they read CSS custom properties at build time). Persisted per-origin in localStorage.
const THEME_KEY = 'sac-theme';
const ICON_SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const ICON_MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
const themeName = (): 'light' | 'dark' => document.documentElement.classList.contains('dark') ? 'dark' : 'light';
const savedTheme = (): 'light' | 'dark' | null => {
  try { const t = localStorage.getItem(THEME_KEY); return t === 'dark' || t === 'light' ? t : null; } catch { return null; }
};
function paintThemeToggle(): void {
  const btn = document.getElementById('themeToggle');
  if (!btn) return;
  const dark = themeName() === 'dark';
  btn.innerHTML = dark ? ICON_SUN : ICON_MOON; // shows the mode you'll switch TO
  btn.setAttribute('aria-pressed', String(dark));
}
function setupThemeToggle(): void {
  const btn = document.getElementById('themeToggle');
  if (!btn) return;
  paintThemeToggle();
  btn.onclick = (): void => {
    const next = themeName() === 'dark' ? 'light' : 'dark';
    applyHostContext({ theme: next });
    try { localStorage.setItem(THEME_KEY, next); } catch { /* private mode */ }
    paintThemeToggle();
    if (currentData) render(currentData); // re-tint charts for the new theme
    repaintDomainViews();
  };
}

// Boot: connect to the host. Production-inert preview hook - a screenshot harness can
// set window.__DASH_FIXTURE__ to render real data with no host. Placed last so every
// definition (incl. SEV_ORDER/renderFindings) is initialised before render() runs.
const __fixture = (window as any).__DASH_FIXTURE__;
if (__fixture) {
  applyHostContext({ theme: (window as any).__DASH_THEME__ ?? 'light' });
  currentData = __fixture; render(__fixture);
} else if (__sacWeb) {
  // Web mode: a ?theme= deep-link wins (headless capture / shared link), else a saved choice, else the browser's colour scheme.
  const urlTheme = new URLSearchParams(location.search).get('theme');
  const bootTheme: 'light' | 'dark' = (urlTheme === 'dark' || urlTheme === 'light')
    ? urlTheme
    : (savedTheme() ?? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  applyHostContext({ theme: bootTheme });
  // One dashboard for every domain: the dropdown moves between All domains, a property and a
  // watched domain; a property also gets the sidebar actions (free jobs).
  void buildDomainPicker(__sacWeb, callServer);
  if (__sacWeb.view === 'domains') showDomainsView(__sacWeb, callServer);
  else if (__sacWeb.domain) void showWatchedDomain(__sacWeb.domain, callServer);
  else {
    setupActions(__sacWeb.siteUrl, callServer);
    setupRangeControl();
    loadDashboard(__sacWeb.siteUrl);
  }
} else {
  app.connect().then(() => applyHostContext(app.getHostContext() as any));
}

// Wire the light/dark toggle in every mode (the button is static in dashboard.html).
setupThemeToggle();

// Redact mode for public screenshots: ?redact=1 (or __DASH_REDACT__) blurs traffic figures and
// link/page domains so real numbers + inbound links don't leak into repo images.
if ((window as any).__DASH_REDACT__ || new URLSearchParams(location.search).get('redact') === '1') {
  document.documentElement.classList.add('redacted');
}
