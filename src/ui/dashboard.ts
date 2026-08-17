import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';
import {
  esc, fmtNum, icons, sevBadge, statusBadge, badge, kpiGrid, filterGroup,
  attachSort, formatTrend, accordionItem, accordionSection, accordionControls,
  EChartWrapper, chartPalette, axisDefaults, tooltipDefaults, emptyState,
} from './lib/index.js';

// Local view types (avoid importing core, which pulls node-only deps into the bundle).
interface Totals { clicks: number; impressions: number; ctr: number; position: number }
interface DashboardData {
  siteUrl: string;
  empty?: boolean;
  linkProspects?: { domain: string; intersections: number; linkedTargets: string[]; domainTrust: number | null; spamScore: number | null; dofollow: boolean; trustFlow: number | null; citationFlow: number | null; topTopic: string | null; competitors: string[]; fetchedAt: string | null }[];
  apiKeys?: { dataforseo: boolean; majestic: boolean; firecrawl: boolean; supadata: boolean };
  trappedAuthority?: { url: string; referringDomains: number; backlinks: number; clickDepth: number | null; ipr: number; trustFlow: number | null; topTopic: string | null }[];
  dateRange?: { current: string; prior?: string; maxDate: string; rawMaxDate?: string; trimmedDays?: number };
  summary?: { current: Totals; prior: Totals };
  rankTrend?: { date: string; clicks: number; impressions: number; position: number }[];
  rankingDistribution?: { date: string; b1: number; b2: number; b3: number; b4: number }[];
  strikingDistance?: { query: string; position: number; impressions: number; clicks: number }[];
  quickWins?: { query: string; position: number; impressions: number; clicks: number; ctr: number; expectedCtr: number; type: 'striking' | 'snippet' | 'serp' | 'ok'; potential: number }[];
  contentDecay?: { urlKey: string; prevClicks: number; clicks: number; lost: number; dropPct: number; impressions: number; position: number }[];
  cannibalisationTable?: { query: string; urlCount: number; totalImpressions: number; totalClicks: number; verdict: 'split' | 'dominant'; crossType: boolean; urls: { url: string; impressions: number; clicks: number; position: number; template: string }[] }[];
  brandedSplit?: { brand: string; branded: { clicks: number; impressions: number }; nonBranded: { clicks: number; impressions: number }; priorBrandedClicks: number; priorNonBrandedClicks: number };
  topKeywords?: { query: string; clicks: number; prevClicks: number; clicksChange: number; position: number; prevPosition: number }[];
  rankHistory?: { period: string; pos_1_3: number; pos_4_10: number; pos_11_20: number; pos_21_100: number; etv: number; keyword_count: number }[];
  dateAlignment?: { note: string };
  deviceBreakdown?: { device: string; clicks: number; prevClicks: number; impressions: number; ctr: number; position: number }[];
  countryBreakdown?: { country: string; clicks: number; prevClicks: number; impressions: number }[];
  pagePerformance?: { urlKey: string; clicks: number; prevClicks: number; clicksChangePct: number; impressions: number; position: number; category: string }[];
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
const ARIA = { aria: { enabled: true } }; // ECharts-generated screen-reader description

const app = new App({ name: 'SEO Audit Console', version: '0.1.0' });

// Web mode: served by the local serve_dashboard webserver - data comes over plain HTTP
// from the same origin instead of the MCP-App host bridge. No host, no sandbox, no cache.
const __sacWeb = (window as any).__SAC_WEB__ as { siteUrl: string; properties?: string[] } | undefined;

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
};

// get_dashboard returns only { siteUrl } (keeps the big payload out of the model context).
// The widget fetches the full dataset itself via the app-only get_dashboard_data tool -
// results route to the iframe, bypassing the model token cap.
let dataLoaded = false;
async function loadDashboard(siteUrl: string): Promise<void> {
  if (dataLoaded || !siteUrl) return;
  dataLoaded = true;
  try {
    const res = await callServer('get_dashboard_data', { siteUrl });
    const data = res?.structuredContent as DashboardData | undefined;
    if (!data) throw new Error('no data');
    currentData = data;
    render(data);
  } catch (e) {
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

const SEV_ORDER = ['crit', 'high', 'med', 'low', 'info'] as const;
const SEV_LABEL: Record<string, string> = { crit: 'Critical', high: 'High', med: 'Medium', low: 'Low', info: 'Info' };
const CAT_LABEL: Record<string, string> = {
  integrity: 'Integrity', crawlability: 'Crawlability', indexation: 'Indexation', onpage: 'On-page',
  content: 'Content', schema: 'Structured data', security: 'Security', performance: 'Performance',
  'war-stories': 'Edge cases', merged: 'Search performance', agentic: 'AI / agent readiness',
};

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

// Executive summary - synthesises the dashboard data into a plain-language read: a traffic verdict,
// where the biggest opportunities are, what's urgent, and a prioritised "start here" action list.
function renderExecSummary(data: DashboardData): void {
  const el = $('execSummary'); if (!el) return;
  const c = data.summary?.current, p = data.summary?.prior;
  if (!c) { el.innerHTML = '<p class="muted">Run a sync to populate the summary.</p>'; return; }

  const pct = (a: number, b: number): number => b ? Math.round((a - b) / b * 100) : (a > 0 ? 100 : 0);
  const clkPct = pct(c.clicks, p?.clicks ?? 0);
  const arrow = (n: number): string => n > 0 ? `${icons.triangleUp} ${n}%` : n < 0 ? `${icons.triangleDown} ${Math.abs(n)}%` : 'flat';
  const dir = clkPct > 3 ? 'growing' : clkPct < -3 ? 'declining' : 'holding steady';
  const posShift = p ? Math.round((p.position - c.position) * 10) / 10 : 0; // positive = improved (lower rank number)
  const lead = `Organic search is <strong>${dir}</strong>: <strong>${fmt(c.clicks)}</strong> clicks and <strong>${fmt(c.impressions)}</strong> impressions in the last 28 days (clicks ${arrow(clkPct)} vs the prior 28), at an average position of <strong>${c.position.toFixed(1)}</strong>${posShift ? ` (${posShift > 0 ? 'improved' : 'slipped'} ${Math.abs(posShift)} spot${Math.abs(posShift) === 1 ? '' : 's'})` : ''}.`;

  const fc = data.findings;
  const critCount = fc?.byCheck?.filter((b: any) => b.severity === 'crit').reduce((s: number, b: any) => s + b.count, 0) ?? 0;
  const recoverable = (data.quickWins ?? []).reduce((s, q) => s + (q.type === 'snippet' || q.type === 'striking' ? q.potential : 0), 0);
  const clkCls = clkPct > 0 ? 'up' : clkPct < 0 ? 'down' : 'flat';

  // LEFT (60%): the narrative + the prioritised action list.
  const main: string[] = [`<p class="exec-lead">${lead}</p>`];
  if (fc && fc.byCheck?.length) {
    const bySev: Record<string, number> = {};
    for (const b of fc.byCheck) bySev[b.severity] = (bySev[b.severity] ?? 0) + b.count;
    const cnt = (id: string): number => fc.byCheck.filter((b: any) => b.check_id === id).reduce((s: number, b: any) => s + b.count, 0);

    const ctr = cnt('ctr-below-expected');
    const strike = data.strikingDistance?.length ?? cnt('striking-distance');
    const cann = data.cannibalisation?.length ?? cnt('keyword-cannibalisation');
    const opp: string[] = [];
    if (ctr) opp.push(`<strong>${ctr}</strong> page${ctr > 1 ? 's' : ''} rank well but are under-clicked - a title/meta rewrite is the fastest lever`);
    if (strike) opp.push(`<strong>${strike}</strong> quer${strike > 1 ? 'ies' : 'y'} sit in striking distance (page 2) and could reach page 1 with a small push`);
    if (cann) opp.push(`<strong>${cann}</strong> quer${cann > 1 ? 'ies are' : 'y is'} cannibalised across multiple URLs`);
    if (opp.length) main.push(`<p><span class="exec-tag">Opportunities</span> ${opp.join('; ')}.</p>`);

    const crit = bySev['crit'] ?? 0, high = bySev['high'] ?? 0;
    if (crit || high) {
      const worst = fc.top?.find((f: any) => f.severity === 'crit') ?? fc.top?.[0];
      const worstTitle = worst ? safeJson(worst.recommendation).title : '';
      main.push(`<p><span class="exec-tag urgent">Fix first</span> ${crit ? `<strong>${crit}</strong> critical` : ''}${crit && high ? ' and ' : ''}${high ? `<strong>${high}</strong> high-severity` : ''} issue${(crit + high) > 1 ? 's' : ''} need attention${worstTitle ? ` - starting with “${esc(worstTitle)}”` : ''}.</p>`);
    }

    const seen = new Set<string>(); const actions: any[] = [];
    for (const f of fc.top ?? []) { if (actions.length >= 4) break; if (seen.has(f.check_id)) continue; seen.add(f.check_id); actions.push(f); }
    if (actions.length) {
      const lis = actions.map(f => {
        const rec = safeJson(f.recommendation), ev = safeJson(f.evidence);
        const where = f.url_key ? esc(shortPath(f.url_key)) : (ev.query ? `“${esc(String(ev.query))}”` : 'site-wide');
        const sz = (f.size ?? '').toString();
        return `<li><span class="impact impact-${sz.toLowerCase() || 's'}">${esc(sz || '–')}</span> ${esc(rec.title || f.check_id)} <span class="exec-where">- ${where}</span></li>`;
      }).join('');
      main.push(`<div class="exec-actions"><div class="exec-actions-title">Start here - your highest-impact fixes</div><ol>${lis}</ol></div>`);
    }
  } else {
    main.push('<p class="muted">Run <code>run_audit</code> to populate findings and the prioritised action list.</p>');
  }

  // RIGHT (40%): the scorecard - the three numbers an SEO weighs first, in one shaded box.
  const stat = (num: string, label: string, color = ''): string =>
    `<div class="es-stat"><div class="es-num"${color ? ` style="color:${color}"` : ''}>${num}</div><div class="es-lbl">${label}</div></div>`;
  const score =
    stat(`${fmt(c.clicks)} <span class="chg ${clkCls}">${arrow(clkPct)}</span>`, 'clicks · last 28d') +
    stat(String(critCount), `critical issue${critCount === 1 ? '' : 's'}`, critCount ? 'var(--red)' : 'var(--green)') +
    stat(fmt(recoverable), 'clicks recoverable');

  el.innerHTML = `<div class="exec-grid"><div class="exec-main">${main.join('')}</div><aside class="exec-score">${score}</aside></div>`;
}

// Branded vs non-branded split - transparent brand match, surfaced so the user can verify it.
function renderBrandedSplit(data: DashboardData): void {
  const el = $('brandedSplit'); if (!el) return;
  const b = data.brandedSplit;
  if (!b) { el.innerHTML = '<p class="muted">Brand could not be auto-detected from this property.</p>'; return; }
  const hint = $('brandedHint');
  if (hint) hint.innerHTML = `Branded = queries containing <strong>“${esc(b.brand)}”</strong> (auto-detected from the domain). How much of your demand is people looking for you vs discovering you - last 28 days.`;
  const bc = b.branded.clicks, nc = b.nonBranded.clicks, tc = bc + nc;
  const bpct = tc ? Math.round(bc / tc * 100) : 0, npct = 100 - bpct;
  const dpc = (cur: number, prev: number): number => prev ? Math.round((cur - prev) / prev * 100) : (cur > 0 ? 100 : 0);
  const arrow = (n: number): string => n > 0 ? `<span class="chg up">${icons.triangleUp} ${n}%</span>` : n < 0 ? `<span class="chg down">${icons.triangleDown} ${Math.abs(n)}%</span>` : '<span class="chg flat">flat</span>';
  el.innerHTML =
    `<div class="split-bar"><span class="split-branded" style="width:${bpct}%"></span><span class="split-nonbranded" style="width:${npct}%"></span></div>` +
    `<div class="split-legend">` +
    `<div class="split-item"><span class="split-dot dot-branded"></span><div><div class="split-k">Branded · ${bpct}%</div><div class="split-v">${fmt(bc)} clicks ${arrow(dpc(bc, b.priorBrandedClicks))} · ${fmt(b.branded.impressions)} impr</div></div></div>` +
    `<div class="split-item"><span class="split-dot dot-nonbranded"></span><div><div class="split-k">Non-branded · ${npct}%</div><div class="split-v">${fmt(nc)} clicks ${arrow(dpc(nc, b.priorNonBrandedClicks))} · ${fmt(b.nonBranded.impressions)} impr</div></div></div>` +
    `</div>`;
}

// Audit-deliverable view: issues grouped by category, each sub-headed with a real example + fix.
function renderRecommendations(fc: DashboardData['findings']): void {
  const el = $('recs');
  if (!fc || !fc.recommendations?.length) { el.innerHTML = '<p class="muted">No audit yet - run run_audit.</p>'; return; }
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
        summaryHtml: `${sevBadge(c.severity)}<span class="rec-title">${esc(c.title)}</span><span class="rec-count">${c.count}</span>`,
        bodyHtml: `<div class="rec-fix"><span class="rec-label">Fix</span> ${esc(c.fix)}</div>${examplesHtml}`,
      });
    }).join('');
    return accordionSection(CAT_LABEL[cat.category] || cat.category, cat.checks.length, items);
  }).join('');

  const ctrl = $('recsControls');
  if (ctrl) accordionControls(ctrl, el);
}

// Findings: severity count-chips (click to filter) + a prioritised table with a
// priority mini-bar and single-line fix text. Replaces the old non-actionable treemap.
function renderFindings(fc: DashboardData['findings'], _col: ReturnType<typeof palette>): void {
  const chipsEl = $('sevChips'), tableEl = $('findingsTable');
  if (!fc || !fc.byCheck.length) {
    chipsEl.innerHTML = '<span class="muted">No audit yet - run run_audit.</span>';
    tableEl.innerHTML = '';
    $('findingsSummary').textContent = 'No audit findings yet.';
    return;
  }
  const sevCounts: Record<string, number> = {};
  for (const c of fc.byCheck) sevCounts[c.severity] = (sevCounts[c.severity] ?? 0) + c.count;
  const maxPrio = Math.max(...fc.top.map(f => f.priority), 0.0001);
  let active = 'all';

  // Severity health bar - proportion of all findings by severity, at a glance
  const HB_CLASS: Record<string, string> = { crit: 'hb-crit', high: 'hb-high', med: 'hb-med', low: 'hb-low', info: 'hb-low' };
  const hbTotal = SEV_ORDER.reduce((s, x) => s + (sevCounts[x] ?? 0), 0) || 1;
  const healthBar = `<div class="health-bar" role="img" aria-label="Findings by severity">` +
    SEV_ORDER.filter(s => sevCounts[s]).map(s =>
      `<span class="${HB_CLASS[s]}" style="width:${((sevCounts[s] / hbTotal) * 100).toFixed(1)}%" title="${SEV_LABEL[s]}: ${sevCounts[s]}"></span>`).join('') +
    `</div>`;

  const drawTable = (): void => {
    // Full list, no pagination - the .grid-virtual class (content-visibility:auto)
    // keeps long lists cheap to render.
    const list = fc.top.filter(f => active === 'all' || f.severity === active);
    const rows = list.map((f, i) => {
      const rec = safeJson(f.recommendation), traf = safeJson(f.traffic_at_risk), ev = safeJson(f.evidence);
      const path = f.url_key ? shortPath(f.url_key) : '-';
      const pct = Math.max(3, Math.round((f.priority / maxPrio) * 100));
      const sz = (f.size ?? '').toString();
      const szClass = 'impact-' + (sz.toLowerCase() || 's');
      const qLabel = ev.query ? ` <span style="color:var(--text-muted);font-size:12px">“${esc(String(ev.query))}”</span>` : '';
      return `<tr class="fi-row" data-fi="${i}" tabindex="0" role="button" aria-expanded="false">` +
        `<td>${sevBadge(f.severity)}</td>` +
        `<td><span class="fi-chev" aria-hidden="true">${icons.chevron}</span>${esc(rec.title || f.check_id)}${qLabel}</td>` +
        `<td class="url" title="${esc(f.url_key || '')}">${esc(path)}</td><td class="num">${traf.clicks || 0}</td>` +
        `<td class="num">${traf.impressions || 0}</td>` +
        `<td class="prio"><span class="impact ${szClass}">${esc(sz || '–')} ${f.impact ?? pct}</span></td>` +
        `<td class="fix" title="${esc(rec.text || '')}">${esc(rec.text || '')}</td></tr>` +
        `<tr class="fi-detail-row" hidden><td colspan="7">${findingDetailHtml(f)}</td></tr>`;
    });
    tableEl.innerHTML = rows.length
      ? healthBar + `<table class="grid-virtual"><thead><tr><th>Sev</th><th>Issue</th><th>URL</th><th class="num">Clicks</th><th class="num">Impr</th><th>Impact</th><th>Fix</th></tr></thead><tbody>${rows.join('')}</tbody></table>`
      : healthBar + '<p class="muted">No findings at this severity in the top results.</p>';
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
  filterGroup(
    chipsEl,
    [
      { key: 'all', label: 'All', count: fc.total },
      ...SEV_ORDER.filter(s => sevCounts[s]).map(s => ({ key: s, label: SEV_LABEL[s], count: sevCounts[s], variant: s })),
    ],
    key => { active = key; drawTable(); },
    'all',
  );
  drawTable();
  $('findingsSummary').textContent = `${fc.total} findings across ${fc.byCheck.length} checks, ranked by impact ÷ effort.`;
}

// KPI tiles come from the display library (lib/kpi.ts: statBlock + kpiGrid).

function render(data: DashboardData): void {
  $('loading').style.display = 'none';
  if (data.empty || !data.summary) { $('empty').style.display = 'flex'; return; }
  $('content').style.display = 'block';
  $('site').textContent = data.siteUrl;
  const dr = data.dateRange;
  $('range').textContent = dr?.current ?? '';
  // Trailing unfinalised GSC days are excluded upstream (gscFreshness); the range already
  // states the end date - no visible caveat (hover-only explanation for the curious).
  if (dr && dr.trimmedDays && dr.trimmedDays > 0 && dr.rawMaxDate) {
    $('range').title = `Data to ${dr.maxDate}; the last ${dr.trimmedDays} day${dr.trimmedDays > 1 ? 's' : ''} of Search Console data aren’t final yet and are excluded.`;
  }

  const c = data.summary.current, p = data.summary.prior;
  const pctChg = (a: number, b: number): number => (b ? ((a - b) / b) * 100 : 0);
  // 28-day daily series for the KPI sparklines (tail of the 90-day rankTrend).
  const spark = (data.rankTrend ?? []).slice(-28);
  const sClicks = spark.map(d => d.clicks);
  const sImpr = spark.map(d => d.impressions);
  const sCtr = spark.map(d => d.impressions ? d.clicks / d.impressions : 0);
  const sPos = spark.map(d => d.position).filter(v => v > 0);
  $('metrics').outerHTML = kpiGrid([
    { label: 'Clicks', value: fmt(c.clicks), change: pctChg(c.clicks, p.clicks), spark: sClicks },
    { label: 'Impressions', value: fmt(c.impressions), change: pctChg(c.impressions, p.impressions), spark: sImpr },
    { label: 'CTR', value: `${(c.ctr * 100).toFixed(1)}%`, change: pctChg(c.ctr, p.ctr), spark: sCtr },
    { label: 'Avg position', value: c.position.toFixed(1), change: pctChg(c.position, p.position), lowerIsBetter: true, spark: sPos },
  ]).replace('<div class="metrics">', '<div class="metrics" id="metrics">');

  const col = palette();
  // Axis discipline (brief #4): whisper dashed gridlines; numeric axes get M/k labels.
  const axis = axisDefaults(col);
  const axisNum = axisDefaults(col, { numeric: true });

  // Executive summary - plain-language read of performance + the prioritised "start here" list
  renderExecSummary(data);
  renderBrandedSplit(data);
  // Audit findings - severity filter chips + prioritised table, then the categorised report
  renderFindings(data.findings, col);
  renderRecommendations(data.findings);
  buildExportBar(data);

  // 0) Equity vs reality - template mismatch (bars) + per-URL scatter (the architecture flagship)
  const mm = data.templateMismatch ?? [];
  if (mm.length) {
    const labels = mm.map(m => m.template).reverse();
    wrap('mismatchChart').setOption({
      ...ARIA,
      grid: { left: 96, right: 24, top: 28, bottom: 30 },
      legend: { top: 0, textStyle: { color: col.text, fontSize: 12 } },
      tooltip: { ...tooltipDefaults(col), axisPointer: { type: 'shadow' }, valueFormatter: (v: number) => v + '%' },
      xAxis: { type: 'value', name: '% share', max: 100, ...axis },
      yAxis: { type: 'category', data: labels, ...axis },
      series: [
        { name: 'Internal equity', type: 'bar', data: mm.map(m => m.iprPct).reverse(), itemStyle: { color: col.blue } },
        { name: 'Organic traffic', type: 'bar', data: mm.map(m => m.trafficPct).reverse(), itemStyle: { color: col.green } },
      ],
    });
    const sink = mm.find(m => m.iprPct >= 10 && m.trafficPct < m.iprPct * 0.3);
    $('mismatchSummary').textContent = sink
      ? `/${sink.template}/ absorbs ${sink.iprPct}% of internal equity but drives ${sink.trafficPct}% of traffic - equity flowing into a dead end.`
      : 'Internal equity share vs organic traffic share, by template.';
  } else {
    wrap('mismatchChart').setEmpty('Run a crawl to map equity flow', col);
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
      ...lf.targets.map(t => ({ name: `→ ${t}`, itemStyle: { color: col.green } })),
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
  const bucketColor: Record<string, string> = { content: col.blue, category: col.red, homepage: col.amber, other: col.muted };
  const scGroups: Record<string, number[][]> = {};
  for (const pt of sc) (scGroups[pt.t] ??= []).push([pt.x, Math.max(1, pt.y)]); // max(1) keeps the log axis valid
  if (sc.length) {
    wrap('scatterChart').setOption({
      ...ARIA,
      grid: { left: 60, right: 24, top: 24, bottom: 40 },
      legend: { top: 0, textStyle: { color: col.text, fontSize: 12 } },
      tooltip: { ...tooltipDefaults(col, 'item'), formatter: (p: any) => `iPR ${p.value[0]} · ${fmt(p.value[1])} impressions` },
      xAxis: { type: 'value', name: 'internal PageRank', min: 0, max: 100, ...axis },
      yAxis: { type: 'log', name: 'impressions', ...axisNum },
      series: Object.entries(scGroups).map(([t, pts]) => ({ name: t, type: 'scatter', symbolSize: t === 'category' ? 9 : 7, itemStyle: { color: bucketColor[t] ?? col.muted, opacity: 0.6 }, data: pts })),
    });
    $('scatterSummary').textContent = `${sc.length} URLs by internal PageRank and impressions; bottom-right = high-authority pages earning no traffic.`;
  } else {
    wrap('scatterChart').setEmpty('Run a crawl to map equity vs traffic', col);
    $('scatterSummary').textContent = 'Run a crawl (refresh_property) to see the equity map.';
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
        grid: { left: 48, right: 16, top: 28, bottom: 40 },
        legend: { top: 0, type: 'scroll', textStyle: { color: col.text, fontSize: 11 } },
        tooltip: tooltipDefaults(col),
        xAxis: { type: 'category', data: weeks, boundaryGap: false, ...axis },
        yAxis: { type: 'value', name: 'rank (1 = top)', inverse: true, min: 1, ...axis },
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
      `<tr><td class="url" title="${esc(p.url)}">${esc(shortPath(p.url))}</td><td class="num">${p.inlinks}</td><td>${statusBadge(p.status)}</td><td>${p.indexable ? icons.check : `${icons.x} ${esc(p.reason || '')}`}</td></tr>`))
    : emptyState('Run a crawl to see the internal-link hierarchy.', 'refresh_property');
  const tlpBroken = tlp.filter(p => p.status !== 200).length;
  $('topLinkedSummary').textContent = `Top ${tlp.length} internally-linked pages by inlink count; ${tlpBroken} return a non-200 status.`;

  // 0e) Site health - stat bars as EChartWrapper configs (brief: no DOM/SVG chart
  // primitives - even stat bars go through the wrapper).
  {
    const ch = data.crawlHealth;
    // Tone (bar colour) rides on each data row - assigned in dashboardData where the bucket's
    // meaning is known, never inferred from label text here.
    const toneColor: Record<string, string> = { ok: col.green, warn: col.amber, bad: col.red, muted: col.grey };
    const sfBars = (id: string, rows: { label: string; count: number; tone?: string }[] | undefined, base: number): void => {
      const el = $(id);
      if (!rows?.length || base <= 0) {
        chartsReg.get(id)?.dispose(); chartsReg.delete(id);
        el.innerHTML = '<div class="sf-empty">Nothing to show - run a crawl first.</div>';
        return;
      }
      if (el.querySelector('.sf-empty')) el.innerHTML = '';
      const rev = rows.slice().reverse(); // horizontal bars read top-down
      el.classList.add('sf-chart');
      el.style.height = `${rev.length * 26 + 12}px`;
      const pctOf = (n: number): string => { const p = (n / base) * 100; return p < 1 && n > 0 ? '<1' : String(Math.round(p)); };
      // Truncate long axis labels in JS (predictable) - the full label stays in the tooltip.
      const shortLabel = (s: string): string => (s.length > 24 ? `${s.slice(0, 23)}…` : s);
      wrap(id).setOption({
        ...ARIA,
        grid: { left: 8, right: 96, top: 6, bottom: 6, containLabel: true },
        tooltip: { ...tooltipDefaults(col, 'item'), formatter: (p: any) => `${esc(String(rev[p.dataIndex].label))}: ${fmt(p.value)} (${pctOf(p.value)}%)` },
        xAxis: { type: 'value', max: base, show: false },
        yAxis: {
          type: 'category', data: rev.map(r => shortLabel(r.label)),
          axisLine: { show: false }, axisTick: { show: false },
          axisLabel: { color: col.text, fontSize: 12 },
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
    sfBars('sfOnPage', ch?.onPage, total);
    sfBars('sfTitles', ch?.titles, total);
    sfBars('sfMetas', ch?.metas, total);
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
  const buckets = [
    { key: 'b1' as const, name: 'Pos 1–3', color: col.green },
    { key: 'b2' as const, name: 'Pos 4–10', color: col.blue },
    { key: 'b3' as const, name: 'Pos 11–20', color: col.amber },
    { key: 'b4' as const, name: 'Pos 21+', color: col.grey },
  ];
  // 'ts' group: echarts.connect() unifies crosshair/tooltip across the daily
  // time-series stack (ranking distribution + rank & clicks share the x domain).
  wrap('distChart', 'ts').setOption({
    ...ARIA,
    grid: { left: 52, right: 16, top: 32, bottom: 30 },
    legend: { top: 0, textStyle: { color: col.text, fontSize: 12 } },
    tooltip: tooltipDefaults(col),
    xAxis: { type: 'category', data: dist.map(d => d.date), ...axis },
    yAxis: { type: 'value', name: 'impressions', ...axisNum },
    series: buckets.map(b => ({
      name: b.name, type: 'line', stack: 'imp', showSymbol: false, lineStyle: { width: 0 },
      areaStyle: { opacity: 0.55 }, itemStyle: { color: b.color }, data: dist.map(d => d[b.key]),
    })),
  });
  const last = dist[dist.length - 1];
  const lastTot = last ? last.b1 + last.b2 + last.b3 + last.b4 : 0;
  $('distSummary').textContent = `Impressions by SERP position bucket across ${dist.length} days; latest day ${lastTot} impressions, ${lastTot ? Math.round((last.b1 / lastTot) * 100) : 0}% in positions 1–3.`;

  // 1b) DataForSEO search visibility over time (rank_history) - reconciled window
  const rh = data.rankHistory ?? [];
  if (rh.length) {
    const rhBuckets = [
      { key: 'pos_1_3' as const, name: 'Pos 1–3', color: col.green },
      { key: 'pos_4_10' as const, name: 'Pos 4–10', color: col.blue },
      { key: 'pos_11_20' as const, name: 'Pos 11–20', color: col.amber },
      { key: 'pos_21_100' as const, name: 'Pos 21–100', color: col.grey },
    ];
    wrap('rankHistChart').setOption({
      ...ARIA,
      grid: { left: 48, right: 56, top: 32, bottom: 30 },
      legend: { top: 0, textStyle: { color: col.text, fontSize: 12 } },
      tooltip: tooltipDefaults(col),
      xAxis: { type: 'category', data: rh.map(p => p.period), ...axis },
      yAxis: [
        { type: 'value', name: 'keywords', ...axisNum },
        { type: 'value', name: 'ETV', ...axisNum, splitLine: { show: false } },
      ],
      series: [
        ...rhBuckets.map(b => ({
          name: b.name, type: 'line', stack: 'kw', showSymbol: false, lineStyle: { width: 0 },
          areaStyle: { opacity: 0.55 }, itemStyle: { color: b.color }, data: rh.map(p => p[b.key]),
        })),
        { name: 'ETV', type: 'line', yAxisIndex: 1, smooth: true, showSymbol: false, data: rh.map(p => Math.round(p.etv)), lineStyle: { color: col.accent, width: 2 }, itemStyle: { color: col.accent } },
      ],
    });
    $('rankHistSummary').textContent = `DataForSEO ranking keywords by position bucket across ${rh.length} months, with estimated traffic value.`;
  } else {
    wrap('rankHistChart').setEmpty('No rank history yet - run track_ranks', col);
    $('rankHistSummary').textContent = 'No DataForSEO rank history yet.';
  }
  $('alignNote').textContent = data.dateAlignment?.note ?? '';

  // 2) Rank + clicks over time (dual-axis) - flagship #6
  const trend = data.rankTrend ?? [];
  wrap('rankChart', 'ts').setOption({
    ...ARIA,
    grid: { left: 48, right: 48, top: 20, bottom: 30 },
    tooltip: tooltipDefaults(col),
    xAxis: { type: 'category', data: trend.map(t => t.date), ...axis },
    yAxis: [
      { type: 'value', name: 'position', inverse: true, min: 1, ...axis },
      { type: 'value', name: 'clicks', ...axisNum, splitLine: { show: false } },
    ],
    series: [
      { name: 'clicks', type: 'bar', yAxisIndex: 1, data: trend.map(t => t.clicks), itemStyle: { color: col.blue, opacity: 0.35 } },
      // Line breaks on days with no position data (null, never a dive to zero).
      { name: 'avg position', type: 'line', yAxisIndex: 0, smooth: true, showSymbol: false, connectNulls: false, data: trend.map(t => (t.position > 0 ? Math.round(t.position * 10) / 10 : null)), lineStyle: { color: col.teal, width: 2 }, itemStyle: { color: col.teal } },
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
    const bub = (v: any) => Math.max(6, Math.min(46, 6 + Math.sqrt(v[2]) * 2.2));
    const SER_NAME: Record<string, string> = { striking: 'Striking distance', snippet: 'Under-clicked', serp: 'Verify (SERP/cannibalisation)', ok: 'On track' };
    const ser = (type: string, color: string, opacity: number) => ({
      name: SER_NAME[type], type: 'scatter', symbolSize: bub, itemStyle: { color, opacity },
      data: qw.filter(q => q.type === type).map(q => [q.position, q.ctr, q.impressions, q.expectedCtr, q.potential, q.query, q.type]),
    });
    wrap('quickWinsChart').setOption({
      ...ARIA,
      grid: { left: 56, right: 24, top: 34, bottom: 42 },
      legend: { top: 0, textStyle: { color: col.text, fontSize: 12 }, data: [SER_NAME.striking, SER_NAME.snippet, SER_NAME.serp, SER_NAME.ok, 'Expected CTR'] },
      tooltip: { ...tooltipDefaults(col, 'item'), formatter: (p: any) => Array.isArray(p.value) ? `${esc(String(p.value[5]))}<br/>pos ${p.value[0]} · CTR ${p.value[1]}% (expected ${p.value[3]}%)<br/>${fmt(p.value[2])} impressions${p.value[6] === 'serp' ? '<br/><em>near-zero CTR - likely a SERP feature or cannibalisation; verify before rewriting</em>' : ` · ~${fmt(p.value[4])} clicks recoverable`}` : '' },
      xAxis: { type: 'value', name: 'avg position', min: 1, max: 20, ...axis },
      yAxis: { type: 'value', name: 'CTR %', min: 0, ...axis },
      series: [
        ser('ok', col.grey, 0.28),
        ser('serp', col.red, 0.5),
        ser('striking', col.amber, 0.7),
        ser('snippet', col.info, 0.7),
        { name: 'Expected CTR', type: 'line', data: curve, lineStyle: { color: col.text, type: 'dashed', width: 1.5, opacity: 0.5 }, symbol: 'none', tooltip: { show: false }, z: 1 },
      ],
    });
  } else {
    wrap('quickWinsChart').setEmpty('No query data yet - sync Search Console.', col);
  }

  // Biggest quick wins table - ranked by recoverable clicks
  const qwTop = qw.filter(q => q.type !== 'ok' && q.potential > 0).slice(0, 20);
  const qwTypeLabel: Record<string, string> = { striking: 'Striking distance', snippet: 'Under-clicked' };
  const qwRows = qwTop.map(q =>
    `<tr><td>${esc(q.query)}</td>` +
    `<td><span class="impact ${q.type === 'striking' ? 'impact-l' : 'impact-m'}">${qwTypeLabel[q.type] || q.type}</span></td>` +
    `<td class="num">${q.position}</td><td class="num">${fmt(q.impressions)}</td>` +
    `<td class="num">${q.ctr}% <span class="muted">/ ${q.expectedCtr}%</span></td>` +
    `<td class="num">${fmt(q.potential)}</td></tr>`).join('');
  $('quickWinsTable').innerHTML = qwTop.length
    ? `<table><thead><tr><th>Query</th><th>Opportunity</th><th class="num">Pos</th><th class="num">Impr</th><th class="num">CTR / exp.</th><th class="num">Clicks recoverable</th></tr></thead><tbody>${qwRows}</tbody></table>`
    : '<p class="muted">No quick wins surfaced - run a sync + audit, or this property is already clicking to potential.</p>';

  // Content decay - pages to refresh, ranked by clicks lost
  const decay = data.contentDecay ?? [];
  const decayRows = decay.map(d => {
    const path = esc(shortPath(d.urlKey || ''));
    return `<tr><td class="url" title="${esc(d.urlKey || '')}">${path}</td>` +
      `<td class="num">${fmt(d.prevClicks)}</td><td class="num">${fmt(d.clicks)}</td>` +
      `<td class="num"><span class="impact ${d.dropPct >= 60 ? 'impact-xl' : d.dropPct >= 35 ? 'impact-l' : 'impact-m'}">−${d.dropPct}%</span></td>` +
      `<td class="num">${fmt(d.lost)}</td><td class="num">${fmt(d.impressions)}</td><td class="num">${d.position || '-'}</td></tr>`;
  }).join('');
  $('contentDecayTable').innerHTML = decay.length
    ? `<table><thead><tr><th>Page</th><th class="num">Was</th><th class="num">Now</th><th class="num">Drop</th><th class="num">Clicks lost</th><th class="num">Impressions</th><th class="num">Position</th></tr></thead><tbody>${decayRows}</tbody></table>`
    : '<p class="muted">No significant content decay - no page lost 20%+ of its clicks vs the prior 28 days.</p>';

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
      grid: { left: 150, right: 30, top: 30, bottom: 34 },
      legend: { top: 0, textStyle: { color: col.text, fontSize: 12 } },
      tooltip: { ...tooltipDefaults(col), valueFormatter: (v: number) => `${v}% share of voice` },
      xAxis: { type: 'value', max: 100, name: '% share of voice (ETV)', nameLocation: 'middle', nameGap: 24, ...axisNum },
      yAxis: { type: 'category', data: clusters.map(c => `${c.head} (${fmt(c.volume)}/mo)`), ...axis },
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
      grid: { left: 132, right: 40, top: 30, bottom: 34 },
      legend: { top: 0, textStyle: { color: col.text, fontSize: 12 } },
      tooltip: { ...tooltipDefaults(col), valueFormatter: (v: number) => `${v}% of sampled volume` },
      xAxis: { type: 'value', name: '% of sampled search volume', nameLocation: 'middle', nameGap: 24, ...axisNum },
      yAxis: { type: 'category', data: feats.map(f => f.label), ...axis },
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
    grid: { left: 8, right: 44, top: 10, bottom: 24, containLabel: true },
    tooltip: { ...tooltipDefaults(col, 'item'), formatter: (pa: any) => `${esc(String(pa.name))}<br/>Δ clicks: ${pa.value >= 0 ? '+' : ''}${pa.value} (now ${kw[pa.dataIndex].clicks})` },
    xAxis: { type: 'value', ...axisNum },
    yAxis: { type: 'category', data: kw.map(k => k.query), axisLabel: { color: col.text, width: 180, overflow: 'truncate' }, axisLine: { lineStyle: { color: col.border } } },
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
    ? tableHtml(['Trend', 'Page', 'Clicks', 'Clicks change', 'Impressions', 'Position'], pp.map(p => `<tr><td><span class="cat ${catClass(p.category)}">${p.category}</span></td><td class="url" title="${esc(p.urlKey)}">${esc(shortPath(p.urlKey))}</td><td class="num">${p.clicks}</td><td class="num" data-sort="${p.clicksChangePct}">${formatTrend(p.clicksChangePct, { suffix: '%' })}</td><td class="num">${p.impressions}</td><td class="num">${p.position}</td></tr>`))
    : '<div class="hint">No GSC data.</div>';
  $('pagePerfSummary').textContent = `${pp.length} pages categorised by 28-day trend.`;

  const mv = data.keywordMovement ?? [];
  $('movementTable').innerHTML = mv.length
    ? tableHtml(['Movement', 'Query', 'First pos', 'Latest pos', 'Pos change'], mv.map(m => `<tr><td><span class="cat ${catClass(m.category)}">${m.category}</span></td><td>${esc(m.query)}</td><td class="num">${m.firstPos}</td><td class="num">${m.lastPos}</td><td class="num">${m.delta > 0 ? '+' : ''}${m.delta}</td></tr>`))
    : '<div class="hint">No movement data.</div>';
  $('movementSummary').textContent = `${mv.length} queries with rank movement.`;

  const dv = data.deviceBreakdown ?? [];
  $('deviceTable').innerHTML = dv.length
    ? tableHtml(['Device', 'Clicks', 'Prev clicks', 'CTR', 'Position'], dv.map(d => `<tr><td>${d.device}</td><td class="num">${d.clicks}</td><td class="num">${d.prevClicks}</td><td class="num">${(d.ctr * 100).toFixed(1)}%</td><td class="num">${d.position}</td></tr>`))
    : '<div class="hint">-</div>';

  const ct = data.countryBreakdown ?? [];
  $('countryTable').innerHTML = ct.length
    ? tableHtml(['Country', 'Clicks', 'Prev clicks', 'Impressions'], ct.map(c => `<tr><td>${esc(c.country.toUpperCase())}</td><td class="num">${c.clicks}</td><td class="num">${c.prevClicks}</td><td class="num">${c.impressions}</td></tr>`))
    : '<div class="hint">-</div>';
  // Hide breakdowns that carry only one value (e.g. a single-country property) - a one-row table is
  // noise, not insight. Show a block only with genuine variety (2+ rows); hide the card if neither has.
  const showDev = dv.length >= 2, showCty = ct.length >= 2;
  const setVis = (id: string, on: boolean): void => { const e = document.getElementById(id); if (e) e.style.display = on ? '' : 'none'; };
  setVis('deviceBlock', showDev); setVis('countryBlock', showCty); setVis('breakdownsCard', showDev || showCty);

  // Make the data tables click-to-sort by any column (the findings list is excluded - its rows come
  // in expand/detail pairs that re-ordering would break).
  ['quickWinsTable', 'contentDecayTable', 'pagePerfTable', 'movementTable', 'deviceTable', 'countryTable'].forEach(id => attachSort($(id)));

  renderHub(data);
  renderLinks(data);
  renderResearch(data);
  renderTrapped(data);
  setupTabs();
}

// Table sorting lives in the display library (lib/data-grid.ts: attachSort).

// Tabbed nav: switch panels, and resize the ECharts in the newly-shown panel - charts created in a
// display:none panel lay out at 0×0, so they must be resized once their container is visible.
function setupTabs(): void {
  const resizeVisible = (): void => { for (const w of chartsReg.values()) w.resizeIfVisible(); };
  document.querySelectorAll<HTMLButtonElement>('.tab-btn').forEach(btn => {
    btn.onclick = (): void => {
      const panel = btn.dataset.panel;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll<HTMLElement>('.tab-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === panel));
      resizeVisible();
    };
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
  firecrawl: 'https://firecrawl.link/2d1PLD8',
  supadata: 'https://supadata.ai',
};
function upsellCard(o: { title: string; lead: string; provider: keyof typeof AFFILIATE; cta: string }): string {
  return `<div class="chart-card upsell">
    <div class="upsell-badge">API key needed</div>
    <h3>${esc(o.title)}</h3>
    <div class="hint">${esc(o.lead)}</div>
    <a class="btn btn-primary" href="${AFFILIATE[o.provider]}" target="_blank" rel="noopener noreferrer">${esc(o.cta)} →</a>
  </div>`;
}

// Overview hub: a card per report, each with a live stat preview, click to jump to that tab.
function renderHub(data: DashboardData): void {
  const el = document.getElementById('reportNav');
  if (!el) return;
  const nf = (n: number | undefined): string => (n ?? 0).toLocaleString();
  const noKey = !!(data.apiKeys && !data.apiKeys.dataforseo);
  const cards = [
    { panel: 'issues', title: 'Issues & fixes', sub: data.findings?.total ? `${nf(data.findings.total)} findings, ranked` : 'Run run_audit' },
    { panel: 'health', title: 'Site health', sub: data.crawlHealth?.totalPages ? `${nf(data.crawlHealth.totalPages)} pages crawled` : 'Run a crawl' },
    { panel: 'opportunities', title: 'Opportunities', sub: data.quickWins?.length ? `${data.quickWins.length} quick wins` : 'Striking distance + decay' },
    { panel: 'search', title: 'Search performance', sub: data.summary ? `${nf(data.summary.current.clicks)} clicks · 28d` : 'GSC trends' },
    { panel: 'architecture', title: 'Architecture', sub: 'Internal equity + agent readiness' },
    { panel: 'links', title: 'Links', sub: data.linkProspects?.length ? `${data.linkProspects.length} prospects` : (noKey ? 'Needs DataForSEO' : 'Run link_intersect') },
    { panel: 'research', title: 'Content research', sub: noKey ? 'Needs DataForSEO' : 'News · Videos · Trends' },
  ];
  el.innerHTML = `<div class="hub-grid">${cards.map(c =>
    `<button class="hub-card" data-goto="${c.panel}"><span class="hub-title">${esc(c.title)}</span><span class="hub-sub">${esc(c.sub)}</span></button>`).join('')}</div>`;
  el.querySelectorAll<HTMLButtonElement>('[data-goto]').forEach(b => {
    b.onclick = (): void => (document.querySelector(`.tab-btn[data-panel="${b.dataset.goto}"]`) as HTMLButtonElement | null)?.click();
  });
}

// Links tab: render the stored link_prospects, or the DataForSEO upsell / a run-it prompt.
function renderLinks(data: DashboardData): void {
  const el = document.getElementById('linksPanel');
  if (!el) return;
  if (data.apiKeys && !data.apiKeys.dataforseo) {
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
    <div class="hint">Domains linking to ${comps.length ? esc(comps.join(', ')) : 'your competitor set'} but not to you. ${enriched ? 'Sorted by Majestic Trust Flow (kills directory noise).' : 'Sorted by DataForSEO domain trust — set a Majestic key to re-sort by Trust Flow.'} ${rows.length} prospects${rows[0]?.fetchedAt ? `, captured ${esc(String(rows[0].fetchedAt).slice(0, 10))}` : ''}.</div>
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
  } catch {
    out.innerHTML = `<div class="empty-state">Lookup failed — a DataForSEO key is required for live research.</div>`;
  }
}

// Trapped authority (Architecture tab): external authority (referring domains) buried deep
// internally — the fix is to link to these pages from higher up. Needs pull_backlinks.
function renderTrapped(data: DashboardData): void {
  const el = document.getElementById('trappedTable');
  if (!el) return;
  const rows = data.trappedAuthority ?? [];
  if (!rows.length) {
    el.innerHTML = `<div class="empty-state">No trapped-authority pages found${data.apiKeys && !data.apiKeys.dataforseo ? ' — DataForSEO backlink data isn’t connected.' : ' — run pull_backlinks to bring in referring-domain counts (with a Majestic key set, pages are also scored by on-topic Trust Flow), then re-open the dashboard.'}</div>`;
    return;
  }
  // Majestic-enriched view shows Trust Flow + the page's top topic; otherwise the DataForSEO view.
  const enriched = rows.some(r => r.trustFlow != null);
  const head = `<tr><th>Page</th><th class="num">Ref domains</th>${enriched ? '<th class="num">Trust Flow</th><th>Top topic</th>' : '<th class="num">Backlinks</th>'}<th class="num">Click depth</th><th class="num">iPR</th></tr>`;
  const body = rows.map(r => `<tr><td class="url">${esc(r.url)}</td><td class="num">${r.referringDomains}</td>${enriched ? `<td class="num">${r.trustFlow ?? '–'}</td><td>${esc(r.topTopic ?? '–')}</td>` : `<td class="num">${r.backlinks.toLocaleString()}</td>`}<td class="num">${r.clickDepth == null ? '∞' : r.clickDepth}</td><td class="num">${r.ipr}</td></tr>`).join('');
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
  } catch {
    el.innerHTML = `<div class="group-label">DataForSEO credentials needed for keyword lookups.</div>`;
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
  // Web mode: honour a saved choice, else the browser's colour scheme; load over HTTP, offer a property switcher.
  applyHostContext({ theme: savedTheme() ?? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') });
  if ((__sacWeb.properties?.length ?? 0) > 1) {
    const header = document.querySelector('.header');
    if (header) {
      const sel = document.createElement('select');
      sel.setAttribute('aria-label', 'Switch property');
      sel.className = 'property-switcher';
      for (const p of __sacWeb.properties!) {
        const o = document.createElement('option');
        o.value = p; o.textContent = p; o.selected = p === __sacWeb.siteUrl;
        sel.appendChild(o);
      }
      sel.addEventListener('change', () => { location.href = `/dashboard?siteUrl=${encodeURIComponent(sel.value)}`; });
      header.appendChild(sel);
    }
  }
  loadDashboard(__sacWeb.siteUrl);
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
