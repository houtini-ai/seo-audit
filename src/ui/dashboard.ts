import * as echarts from 'echarts';
import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';

// Local view types (avoid importing core, which pulls node-only deps into the bundle).
interface Totals { clicks: number; impressions: number; ctr: number; position: number }
interface DashboardData {
  siteUrl: string;
  empty?: boolean;
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
}

const $ = (id: string): HTMLElement => document.getElementById(id)!;
const cssVar = (n: string, fb = ''): string => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || fb;
const fmt = (n: number): string => new Intl.NumberFormat('en', { notation: n >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(n);
const esc = (s: string): string => s.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch] as string));
const safeJson = (s: string): any => { try { return JSON.parse(s || '{}'); } catch { return {}; } };
const catClass = (c: string): string => /(top performer|gained|entered)/.test(c) ? 'cat-up' : /(low performer|lost|dropped)/.test(c) ? 'cat-down' : /declining/.test(c) ? 'cat-warn' : /improve/.test(c) ? 'cat-info' : 'cat-neutral';
const tableHtml = (headers: string[], rows: string[]): string => `<table><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
const shortPath = (u: string): string => (u || '').replace(/^https?:\/\/[^/]+/, '') || '/';

function palette() {
  const root = document.documentElement;
  const isDark = root.getAttribute('data-theme') === 'dark'
    || root.classList.contains('dark')
    || (!root.getAttribute('data-theme') && !root.classList.contains('light') && matchMedia('(prefers-color-scheme: dark)').matches);
  return {
    text: cssVar('--color-text-primary', '#0a0b0d'),
    axisText: isDark ? '#ffffff' : '#000000', // chart axis labels: pure white (dark) / black (light)
    muted: cssVar('--color-text-tertiary', '#62666d'),
    accent: cssVar('--color-accent', '#5b5fff'),
    violet: cssVar('--color-brand-violet', '#8b5cf6'),
    grid: cssVar('--chart-grid', 'rgba(10,11,13,0.06)'),
    green: cssVar('--color-status-live', '#16a34a'),
    red: cssVar('--color-status-error', '#ef4444'),
    amber: cssVar('--color-status-warning', '#f59e0b'),
    surface: cssVar('--color-surface-elevated', '#ffffff'),
    border: cssVar('--color-border-standard', 'rgba(10,11,13,0.1)'),
  };
}


const csvCell = (v: unknown): string => `"${String(v ?? '').replace(/"/g, '""')}"`;
const toCsv = (rows: unknown[][]): string => rows.map(r => r.map(csvCell).join(',')).join('\r\n');

/** Brief visible notice (top-centre) — so download success/failure is never silent. */
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

// Direct <a download> blob clicks are blocked inside MCP-App sandboxed iframes — that's why the
// host exposes ui/download-file. We use it only when the host advertises the capability; otherwise
// we fall back to copying the CSV to the clipboard, and we always surface the outcome via a toast.
async function downloadCsv(filename: string, rows: unknown[][]): Promise<void> {
  const csv = toCsv(rows);

  // Standalone export (opened directly in a browser, not an MCP host): a normal blob download works.
  if ((window as any).__DASH_FIXTURE__) {
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
      ? `This host can't save files — ${filename} copied to clipboard (paste into a .csv)`
      : `This host can't save files and clipboard is blocked — use “Export report” for a downloadable file`,
    'warn',
  );
}

let currentData: DashboardData | null = null;
let distChart: echarts.ECharts | null = null;
let rankHistChart: echarts.ECharts | null = null;
let rankChart: echarts.ECharts | null = null;
let kwChart: echarts.ECharts | null = null;
let mismatchChart: echarts.ECharts | null = null;
let scatterChart: echarts.ECharts | null = null;
let cannChart: echarts.ECharts | null = null;
let quickWinsChart: echarts.ECharts | null = null;
const ARIA = { aria: { enabled: true } }; // ECharts-generated screen-reader description

const app = new App({ name: 'SEO Audit Console', version: '0.1.0' });

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
// The widget fetches the full dataset itself via the app-only get_dashboard_data tool —
// results route to the iframe, bypassing the model token cap.
let dataLoaded = false;
async function loadDashboard(siteUrl: string): Promise<void> {
  if (dataLoaded || !siteUrl) return;
  dataLoaded = true;
  try {
    const res = await app.callServerTool({ name: 'get_dashboard_data', arguments: { siteUrl } });
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

window.addEventListener('resize', () => { distChart?.resize(); rankHistChart?.resize(); rankChart?.resize(); kwChart?.resize(); });

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

// Executive summary — synthesises the dashboard data into a plain-language read: a traffic verdict,
// where the biggest opportunities are, what's urgent, and a prioritised "start here" action list.
function renderExecSummary(data: DashboardData): void {
  const el = $('execSummary'); if (!el) return;
  const c = data.summary?.current, p = data.summary?.prior;
  if (!c) { el.innerHTML = '<p class="muted">Run a sync to populate the summary.</p>'; return; }

  const pct = (a: number, b: number): number => b ? Math.round((a - b) / b * 100) : (a > 0 ? 100 : 0);
  const clkPct = pct(c.clicks, p?.clicks ?? 0);
  const arrow = (n: number): string => n > 0 ? `▲ ${n}%` : n < 0 ? `▼ ${Math.abs(n)}%` : 'flat';
  const dir = clkPct > 3 ? 'growing' : clkPct < -3 ? 'declining' : 'holding steady';
  const posShift = p ? Math.round((p.position - c.position) * 10) / 10 : 0; // positive = improved (lower rank number)
  const lead = `Organic search is <strong>${dir}</strong>: <strong>${fmt(c.clicks)}</strong> clicks and <strong>${fmt(c.impressions)}</strong> impressions in the last 28 days (clicks ${arrow(clkPct)} vs the prior 28), at an average position of <strong>${c.position.toFixed(1)}</strong>${posShift ? ` (${posShift > 0 ? 'improved' : 'slipped'} ${Math.abs(posShift)} spot${Math.abs(posShift) === 1 ? '' : 's'})` : ''}.`;

  const fc = data.findings;
  // Headline scorecard — the three numbers an SEO reads first: clicks (+delta), critical issues, upside.
  const critCount = fc?.byCheck?.filter((b: any) => b.severity === 'crit').reduce((s: number, b: any) => s + b.count, 0) ?? 0;
  const recoverable = (data.quickWins ?? []).reduce((s, q) => s + (q.type === 'snippet' || q.type === 'striking' ? q.potential : 0), 0);
  const clkCls = clkPct > 0 ? 'up' : clkPct < 0 ? 'down' : 'flat';
  const headline = `<div class="exec-headline">` +
    `<div class="eh-stat"><div class="eh-num">${fmt(c.clicks)}</div><div class="eh-lbl">clicks · 28d <span class="chg ${clkCls}">${arrow(clkPct)}</span></div></div>` +
    `<div class="eh-stat"><div class="eh-num" style="color:${critCount ? 'var(--red)' : 'var(--green)'}">${critCount}</div><div class="eh-lbl">critical issue${critCount === 1 ? '' : 's'}</div></div>` +
    `<div class="eh-stat"><div class="eh-num">${fmt(recoverable)}</div><div class="eh-lbl">clicks recoverable</div></div>` +
    `</div>`;
  const parts: string[] = [headline, `<p class="exec-lead">${lead}</p>`];

  if (fc && fc.byCheck?.length) {
    const bySev: Record<string, number> = {};
    for (const b of fc.byCheck) bySev[b.severity] = (bySev[b.severity] ?? 0) + b.count;
    const cnt = (id: string): number => fc.byCheck.filter((b: any) => b.check_id === id).reduce((s: number, b: any) => s + b.count, 0);

    const ctr = cnt('ctr-below-expected');
    const strike = data.strikingDistance?.length ?? cnt('striking-distance');
    const cann = data.cannibalisation?.length ?? cnt('keyword-cannibalisation');
    const opp: string[] = [];
    if (ctr) opp.push(`<strong>${ctr}</strong> page${ctr > 1 ? 's' : ''} rank well but are under-clicked — a title/meta rewrite is the fastest lever`);
    if (strike) opp.push(`<strong>${strike}</strong> quer${strike > 1 ? 'ies' : 'y'} sit in striking distance (page 2) and could reach page 1 with a small push`);
    if (cann) opp.push(`<strong>${cann}</strong> quer${cann > 1 ? 'ies are' : 'y is'} cannibalised across multiple URLs`);
    if (opp.length) parts.push(`<p><span class="exec-tag">Opportunities</span> ${opp.join('; ')}.</p>`);

    const crit = bySev['crit'] ?? 0, high = bySev['high'] ?? 0;
    if (crit || high) {
      const worst = fc.top?.find((f: any) => f.severity === 'crit') ?? fc.top?.[0];
      const worstTitle = worst ? safeJson(worst.recommendation).title : '';
      parts.push(`<p><span class="exec-tag urgent">Fix first</span> ${crit ? `<strong>${crit}</strong> critical` : ''}${crit && high ? ' and ' : ''}${high ? `<strong>${high}</strong> high-severity` : ''} issue${(crit + high) > 1 ? 's' : ''} need attention${worstTitle ? ` — starting with “${esc(worstTitle)}”` : ''}.</p>`);
    }

    const seen = new Set<string>(); const actions: any[] = [];
    for (const f of fc.top ?? []) { if (actions.length >= 4) break; if (seen.has(f.check_id)) continue; seen.add(f.check_id); actions.push(f); }
    if (actions.length) {
      const lis = actions.map(f => {
        const rec = safeJson(f.recommendation), ev = safeJson(f.evidence);
        const where = f.url_key ? esc((f.url_key.replace(/^https?:\/\/[^/]+/, '') || '/')) : (ev.query ? `“${esc(String(ev.query))}”` : 'site-wide');
        const sz = (f.size ?? '').toString();
        return `<li><span class="impact impact-${sz.toLowerCase() || 's'}">${esc(sz || '–')}</span> ${esc(rec.title || f.check_id)} <span class="exec-where">— ${where}</span></li>`;
      }).join('');
      parts.push(`<div class="exec-actions"><div class="exec-actions-title">Start here — your highest-impact fixes</div><ol>${lis}</ol></div>`);
    }
  } else {
    parts.push('<p class="muted">Run <code>run_audit</code> to populate findings and the prioritised action list.</p>');
  }
  el.innerHTML = parts.join('');
}

// Branded vs non-branded split — transparent brand match, surfaced so the user can verify it.
function renderBrandedSplit(data: DashboardData): void {
  const el = $('brandedSplit'); if (!el) return;
  const b = data.brandedSplit;
  if (!b) { el.innerHTML = '<p class="muted">Brand could not be auto-detected from this property.</p>'; return; }
  const hint = $('brandedHint');
  if (hint) hint.innerHTML = `Branded = queries containing <strong>“${esc(b.brand)}”</strong> (auto-detected from the domain). How much of your demand is people looking for you vs discovering you — last 28 days.`;
  const bc = b.branded.clicks, nc = b.nonBranded.clicks, tc = bc + nc;
  const bpct = tc ? Math.round(bc / tc * 100) : 0, npct = 100 - bpct;
  const dpc = (cur: number, prev: number): number => prev ? Math.round((cur - prev) / prev * 100) : (cur > 0 ? 100 : 0);
  const arrow = (n: number): string => n > 0 ? `<span style="color:var(--green)">▲ ${n}%</span>` : n < 0 ? `<span style="color:var(--red)">▼ ${Math.abs(n)}%</span>` : '<span class="muted">flat</span>';
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
  if (!fc || !fc.recommendations?.length) { el.innerHTML = '<p class="muted">No audit yet — run run_audit.</p>'; return; }
  const exampleRow = (ex: { urlKey: string | null; evidence: Record<string, unknown>; clicks: number; impressions: number }): string => {
    const fullPath = ex?.urlKey ? (ex.urlKey.replace(/^https?:\/\/[^/]+/, '') || '/') : '';
    const path = esc(fullPath.length > 72 ? fullPath.slice(0, 72) + '…' : fullPath);
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
      return `<details class="rec-acc">` +
        `<summary><span class="sev ${c.severity}">${c.severity}</span><span class="rec-title">${esc(c.title)}</span><span class="rec-count">${c.count}</span><span class="rec-chev" aria-hidden="true">›</span></summary>` +
        `<div class="rec-body"><div class="rec-fix"><span class="rec-label">Fix</span> ${esc(c.fix)}</div>${examplesHtml}</div>` +
        `</details>`;
    }).join('');
    return `<div class="rec-cat"><h4 class="rec-cat-title">${esc(CAT_LABEL[cat.category] || cat.category)} <span class="rec-cat-count">${cat.checks.length}</span></h4>${items}</div>`;
  }).join('');

  const ctrl = $('recsControls');
  if (ctrl) {
    ctrl.innerHTML = `<button class="recs-btn" data-act="expand">Expand all</button><button class="recs-btn" data-act="collapse">Collapse all</button>`;
    ctrl.querySelectorAll<HTMLButtonElement>('.recs-btn').forEach(b => b.addEventListener('click', () => {
      const open = b.dataset.act === 'expand';
      el.querySelectorAll('details').forEach(d => { (d as HTMLDetailsElement).open = open; });
    }));
  }
}

// Findings: severity count-chips (click to filter) + a prioritised table with a
// priority mini-bar and single-line fix text. Replaces the old non-actionable treemap.
function renderFindings(fc: DashboardData['findings'], _col: ReturnType<typeof palette>): void {
  const chipsEl = $('sevChips'), tableEl = $('findingsTable');
  if (!fc || !fc.byCheck.length) {
    chipsEl.innerHTML = '<span class="muted">No audit yet — run run_audit.</span>';
    tableEl.innerHTML = '';
    $('findingsSummary').textContent = 'No audit findings yet.';
    return;
  }
  const sevCounts: Record<string, number> = {};
  for (const c of fc.byCheck) sevCounts[c.severity] = (sevCounts[c.severity] ?? 0) + c.count;
  const maxPrio = Math.max(...fc.top.map(f => f.priority), 0.0001);
  let active = 'all';

  // Severity health bar — proportion of all findings by severity, at a glance
  const HB_CLASS: Record<string, string> = { crit: 'hb-crit', high: 'hb-high', med: 'hb-med', low: 'hb-low', info: 'hb-low' };
  const hbTotal = SEV_ORDER.reduce((s, x) => s + (sevCounts[x] ?? 0), 0) || 1;
  const healthBar = `<div class="health-bar" role="img" aria-label="Findings by severity">` +
    SEV_ORDER.filter(s => sevCounts[s]).map(s =>
      `<span class="${HB_CLASS[s]}" style="width:${((sevCounts[s] / hbTotal) * 100).toFixed(1)}%" title="${SEV_LABEL[s]}: ${sevCounts[s]}"></span>`).join('') +
    `</div>`;

  const drawTable = (): void => {
    const rows = fc.top.filter(f => active === 'all' || f.severity === active).slice(0, 25).map(f => {
      const rec = safeJson(f.recommendation), traf = safeJson(f.traffic_at_risk), ev = safeJson(f.evidence);
      const path = (f.url_key || '—').replace(/^https?:\/\/[^/]+/, '') || '/';
      const pct = Math.max(3, Math.round((f.priority / maxPrio) * 100));
      const sz = (f.size ?? '').toString();
      const szClass = 'impact-' + (sz.toLowerCase() || 's');
      const qLabel = ev.query ? ` <span style="color:var(--text-muted);font-size:12px">“${esc(String(ev.query))}”</span>` : '';
      return `<tr><td><span class="sev ${f.severity}">${f.severity}</span></td><td>${esc(rec.title || f.check_id)}${qLabel}</td>` +
        `<td class="url" title="${esc(f.url_key || '')}">${esc(path)}</td><td class="num">${traf.clicks || 0}</td>` +
        `<td class="num">${traf.impressions || 0}</td>` +
        `<td class="prio"><span class="impact ${szClass}">${esc(sz || '–')} ${f.impact ?? pct}</span></td>` +
        `<td class="fix" title="${esc(rec.text || '')}">${esc(rec.text || '')}</td></tr>`;
    });
    tableEl.innerHTML = rows.length
      ? healthBar + `<table><thead><tr><th>Sev</th><th>Issue</th><th>URL</th><th class="num">Clicks</th><th class="num">Impr</th><th>Impact</th><th>Fix</th></tr></thead><tbody>${rows.join('')}</tbody></table>`
      : healthBar + '<p class="muted">No findings at this severity in the top results.</p>';
  };
  const drawChips = (): void => {
    const chip = (sev: string, label: string, n: number): string =>
      `<button class="sev-chip ${sev === 'all' ? 'c-all' : 's-' + sev} ${active === sev ? 'active' : ''}" data-sev="${sev}">${label} <b>${n}</b></button>`;
    const parts = [chip('all', 'All', fc.total)];
    for (const s of SEV_ORDER) if (sevCounts[s]) parts.push(chip(s, SEV_LABEL[s], sevCounts[s]));
    chipsEl.innerHTML = parts.join('');
    chipsEl.querySelectorAll('.sev-chip').forEach(b => b.addEventListener('click', () => {
      active = (b as HTMLElement).dataset.sev!; drawChips(); drawTable();
    }));
  };
  drawChips(); drawTable();
  $('findingsSummary').textContent = `${fc.total} findings across ${fc.byCheck.length} checks, ranked by impact ÷ effort.`;
}

// Tiny inline-SVG sparkline (no axes, single muted line) — the 28-day shape behind a KPI.
function sparkline(series: number[], lowerIsBetter = false): string {
  const pts = series.filter(v => Number.isFinite(v));
  if (pts.length < 2) return '';
  const w = 96, h = 26, min = Math.min(...pts), max = Math.max(...pts), span = max - min || 1;
  // For position (lower=better) invert Y so an improving trend still rises visually.
  const norm = (v: number): number => lowerIsBetter ? (v - min) / span : 1 - (v - min) / span;
  const step = w / (pts.length - 1);
  const d = pts.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(norm(v) * (h - 4) + 2).toFixed(1)}`).join(' ');
  return `<svg class="metric-spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

function metricCard(label: string, value: string, change: number, lowerIsBetter = false, spark: number[] = []): string {
  const better = lowerIsBetter ? change < 0 : change > 0;
  const cls = change === 0 ? 'flat' : better ? 'up' : 'down';
  const arrow = change === 0 ? '' : change > 0 ? '▲' : '▼';
  const pct = `${arrow} ${Math.abs(Math.round(change))}%`;
  return `<div class="metric-card"><div class="label">${label}</div><div class="value">${value}</div>` +
    `<div class="metric-foot"><span class="chg ${cls}">${pct}</span>${sparkline(spark, lowerIsBetter)}</div></div>`;
}

function render(data: DashboardData): void {
  $('loading').style.display = 'none';
  if (data.empty || !data.summary) { $('empty').style.display = 'flex'; return; }
  $('content').style.display = 'block';
  $('site').textContent = data.siteUrl;
  const dr = data.dateRange;
  $('range').textContent = dr?.current ?? '';
  if (dr && dr.trimmedDays && dr.trimmedDays > 0 && dr.rawMaxDate) {
    const rangeEl = $('range');
    rangeEl.title = `Search Console data runs to ${dr.rawMaxDate}, but the last ${dr.trimmedDays} day${dr.trimmedDays > 1 ? 's' : ''} are still being finalised by Google and are excluded so the charts don’t show a false drop.`;
    const note = document.createElement('span');
    note.className = 'range-note';
    note.textContent = ` · excl. last ${dr.trimmedDays}d (GSC not finalised)`;
    rangeEl.appendChild(note);
  }

  const c = data.summary.current, p = data.summary.prior;
  const pctChg = (a: number, b: number): number => (b ? ((a - b) / b) * 100 : 0);
  // 28-day daily series for the KPI sparklines (tail of the 90-day rankTrend).
  const spark = (data.rankTrend ?? []).slice(-28);
  const sClicks = spark.map(d => d.clicks);
  const sImpr = spark.map(d => d.impressions);
  const sCtr = spark.map(d => d.impressions ? d.clicks / d.impressions : 0);
  const sPos = spark.map(d => d.position).filter(v => v > 0);
  $('metrics').innerHTML =
    metricCard('Clicks', fmt(c.clicks), pctChg(c.clicks, p.clicks), false, sClicks) +
    metricCard('Impressions', fmt(c.impressions), pctChg(c.impressions, p.impressions), false, sImpr) +
    metricCard('CTR', `${(c.ctr * 100).toFixed(1)}%`, pctChg(c.ctr, p.ctr), false, sCtr) +
    metricCard('Avg position', c.position.toFixed(1), pctChg(c.position, p.position), true, sPos);

  const col = palette();
  // axis tick labels + axis names use primary text (high contrast: white on dark, near-black on light)
  const axis = { axisLine: { lineStyle: { color: col.border } }, axisLabel: { color: col.axisText, fontSize: 12 }, nameTextStyle: { color: col.axisText, fontSize: 12 }, splitLine: { lineStyle: { color: col.grid } } };

  // Executive summary — plain-language read of performance + the prioritised "start here" list
  renderExecSummary(data);
  renderBrandedSplit(data);
  // Audit findings — severity filter chips + prioritised table, then the categorised report
  renderFindings(data.findings, col);
  renderRecommendations(data.findings);
  buildExportBar(data);

  // 0) Equity vs reality — template mismatch (bars) + per-URL scatter (the architecture flagship)
  const mm = data.templateMismatch ?? [];
  mismatchChart?.dispose();
  mismatchChart = echarts.init($('mismatchChart'));
  if (mm.length) {
    const labels = mm.map(m => m.template).reverse();
    mismatchChart.setOption({
      ...ARIA,
      grid: { left: 96, right: 24, top: 28, bottom: 30 },
      legend: { top: 0, textStyle: { color: col.text, fontSize: 12 } },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: (v: number) => v + '%' },
      xAxis: { type: 'value', name: '% share', max: 100, ...axis },
      yAxis: { type: 'category', data: labels, ...axis },
      series: [
        { name: 'Internal equity', type: 'bar', data: mm.map(m => m.iprPct).reverse(), itemStyle: { color: col.accent } },
        { name: 'Organic traffic', type: 'bar', data: mm.map(m => m.trafficPct).reverse(), itemStyle: { color: col.green } },
      ],
    });
    const sink = mm.find(m => m.iprPct >= 10 && m.trafficPct < m.iprPct * 0.3);
    $('mismatchSummary').textContent = sink
      ? `/${sink.template}/ absorbs ${sink.iprPct}% of internal equity but drives ${sink.trafficPct}% of traffic — equity flowing into a dead end.`
      : 'Internal equity share vs organic traffic share, by template.';
  } else {
    mismatchChart.setOption({ ...ARIA, title: { text: 'Run a crawl to map equity flow', left: 'center', top: 'center', textStyle: { color: col.muted, fontSize: 13, fontWeight: 'normal' } } });
    $('mismatchSummary').textContent = 'Run a crawl (refresh_property) to see equity flow by template.';
  }

  const sc = data.equityScatter ?? [];
  const bucketColor: Record<string, string> = { content: col.accent, category: col.red, homepage: col.amber, other: col.muted };
  const scGroups: Record<string, number[][]> = {};
  for (const pt of sc) (scGroups[pt.t] ??= []).push([pt.x, Math.max(1, pt.y)]); // max(1) keeps the log axis valid
  scatterChart?.dispose();
  scatterChart = echarts.init($('scatterChart'));
  if (sc.length) {
    scatterChart.setOption({
      ...ARIA,
      grid: { left: 60, right: 24, top: 24, bottom: 40 },
      legend: { top: 0, textStyle: { color: col.text, fontSize: 12 } },
      tooltip: { trigger: 'item', formatter: (p: any) => `iPR ${p.value[0]} · ${fmt(p.value[1])} impressions` },
      xAxis: { type: 'value', name: 'internal PageRank', min: 0, max: 100, ...axis },
      yAxis: { type: 'log', name: 'impressions', ...axis },
      series: Object.entries(scGroups).map(([t, pts]) => ({ name: t, type: 'scatter', symbolSize: t === 'category' ? 9 : 7, itemStyle: { color: bucketColor[t] ?? col.muted, opacity: 0.6 }, data: pts })),
    });
    $('scatterSummary').textContent = `${sc.length} URLs by internal PageRank and impressions; bottom-right = high-authority pages earning no traffic.`;
  } else {
    scatterChart.setOption({ ...ARIA, title: { text: 'Run a crawl to map equity vs traffic', left: 'center', top: 'center', textStyle: { color: col.muted, fontSize: 13, fontWeight: 'normal' } } });
    $('scatterSummary').textContent = 'Run a crawl (refresh_property) to see the equity map.';
  }

  // 0a) Agent readiness panel (populated by check_agent_readiness; live probe, persisted)
  const ar = data.agentReadiness;
  if (ar) {
    const scoreColor = ar.score >= 80 ? 'var(--color-status-live)' : ar.score >= 50 ? 'var(--color-status-warning)' : 'var(--color-status-error)';
    // SVG score ring — circumference arc proportional to score, colour-graded
    const R = 46, CIRC = 2 * Math.PI * R, off = CIRC * (1 - Math.max(0, Math.min(100, ar.score)) / 100);
    const ring = `<div class="ar-ring"><svg viewBox="0 0 104 104" width="104" height="104" aria-hidden="true">
        <circle cx="52" cy="52" r="${R}" fill="none" stroke="var(--bg-input)" stroke-width="9"/>
        <circle cx="52" cy="52" r="${R}" fill="none" stroke="${scoreColor}" stroke-width="9" stroke-linecap="round" stroke-dasharray="${CIRC.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 52 52)"/>
      </svg><div class="ar-score"><div class="ar-num" style="color:${scoreColor}">${ar.score}</div><div class="ar-of">/ 100</div></div></div>`;
    const cats = ar.byCategory.map(c => `<div class="ar-cat"><div class="c-label">${esc(c.category)}</div><div class="c-val">${c.passed}<span style="color:var(--text-muted)">/${c.total}</span></div></div>`).join('');
    const items = ar.checks.map(c => `<div class="ar-check">
      <span class="${c.present ? 'ar-ok' : 'ar-no'}" style="min-width:14px;font-weight:600">${c.present ? '✓' : '○'}</span>
      <span style="flex:1">${esc(c.label)}${c.present && c.detail ? ` <span style="color:var(--text-muted)">— ${esc(c.detail)}</span>` : ''}</span>
      ${c.present ? '' : `<span class="ar-fix" style="max-width:48%;text-align:right">${esc(c.fix)}</span>`}</div>`).join('');
    $('agentPanel').innerHTML =
      `<div class="ar-top">${ring}<div class="ar-meta"><div class="ar-level">${esc(ar.level)}</div><div class="ar-cats">${cats}</div></div></div>
      <div class="ar-checks">${items}</div>`;
  } else {
    $('agentPanel').innerHTML = '<p class="muted">Run <code>check_agent_readiness</code> for this site to populate the agent-readiness score.</p>';
  }

  // 0b) Cannibalisation braids — per contested query, competing URLs' weekly position over time
  const cann = data.cannibalisation ?? [];
  const cannSel = $('cannSelect') as HTMLSelectElement;
  cannChart?.dispose();
  cannChart = echarts.init($('cannChart'));
  if (cann.length) {
    cannSel.innerHTML = cann.map((q, i) => `<option value="${i}">${esc(q.query)} (${q.urls.length} URLs)</option>`).join('');
    const palette4 = [col.accent, col.red, col.amber, col.green];
    const drawBraid = (qi: number): void => {
      const q = cann[qi];
      const weeks = [...new Set(q.urls.flatMap(u => u.points.map(p => p.week)))].sort();
      cannChart!.setOption({
        ...ARIA,
        grid: { left: 48, right: 16, top: 28, bottom: 40 },
        legend: { top: 0, type: 'scroll', textStyle: { color: col.text, fontSize: 11 } },
        tooltip: { trigger: 'axis' },
        xAxis: { type: 'category', data: weeks, ...axis },
        yAxis: { type: 'value', name: 'position', inverse: true, min: 1, ...axis },
        series: q.urls.map((u, ui) => { const m = new Map(u.points.map(p => [p.week, p.position])); return { name: shortPath(u.url), type: 'line', smooth: true, connectNulls: true, showSymbol: false, lineStyle: { width: 2, color: palette4[ui % 4] }, itemStyle: { color: palette4[ui % 4] }, data: weeks.map(w => m.get(w) ?? null) }; }),
      }, true);
    };
    drawBraid(0);
    cannSel.onchange = (): void => drawBraid(Number(cannSel.value));
    $('cannSummary').textContent = `${cann.length} contested queries; each line is a competing URL's weekly average position (higher = better rank).`;
  } else {
    cannSel.innerHTML = '';
    cannChart.setOption({ ...ARIA, title: { text: 'No cannibalisation detected', left: 'center', top: 'center', textStyle: { color: col.muted, fontSize: 13, fontWeight: 'normal' } } });
    $('cannSummary').textContent = 'No contested queries found.';
  }

  // 0d) Top internally-linked pages with their current status code (a non-200 high up = equity leak)
  const tlp = data.topLinkedPages ?? [];
  const statusBadge = (s: number | null): string => {
    if (s == null) return '<span class="cat cat-neutral">?</span>';
    const cls = s === 200 ? 'cat-up' : s >= 400 ? 'cat-down' : s >= 300 ? 'cat-warn' : 'cat-neutral';
    return `<span class="cat ${cls}">${s}</span>`;
  };
  $('topLinkedTable').innerHTML = tlp.length
    ? tableHtml(['URL', 'Inlinks', 'Status', 'Indexable'], tlp.map(p =>
      `<tr><td class="url" title="${esc(p.url)}">${esc(shortPath(p.url))}</td><td class="num">${p.inlinks}</td><td>${statusBadge(p.status)}</td><td>${p.indexable ? '✓' : '✗ ' + esc(p.reason || '')}</td></tr>`))
    : '<p class="muted">Run a crawl (refresh_property) to see the internal-link hierarchy.</p>';
  const tlpBroken = tlp.filter(p => p.status !== 200).length;
  $('topLinkedSummary').textContent = `Top ${tlp.length} internally-linked pages by inlink count; ${tlpBroken} return a non-200 status.`;

  // 1) Ranking distribution over time (stacked area) — flagship #1
  const dist = data.rankingDistribution ?? [];
  const buckets = [
    { key: 'b1' as const, name: 'Pos 1–3', color: col.green },
    { key: 'b2' as const, name: 'Pos 4–10', color: col.accent },
    { key: 'b3' as const, name: 'Pos 11–20', color: col.amber },
    { key: 'b4' as const, name: 'Pos 21+', color: col.muted },
  ];
  distChart?.dispose();
  distChart = echarts.init($('distChart'));
  distChart.setOption({
    ...ARIA,
    grid: { left: 52, right: 16, top: 32, bottom: 30 },
    legend: { top: 0, textStyle: { color: col.text, fontSize: 12 } },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: dist.map(d => d.date), ...axis },
    yAxis: { type: 'value', name: 'impressions', ...axis },
    series: buckets.map(b => ({
      name: b.name, type: 'line', stack: 'imp', showSymbol: false, lineStyle: { width: 0 },
      areaStyle: { opacity: 0.55 }, itemStyle: { color: b.color }, data: dist.map(d => d[b.key]),
    })),
  });
  const last = dist[dist.length - 1];
  const lastTot = last ? last.b1 + last.b2 + last.b3 + last.b4 : 0;
  $('distSummary').textContent = `Impressions by SERP position bucket across ${dist.length} days; latest day ${lastTot} impressions, ${lastTot ? Math.round((last.b1 / lastTot) * 100) : 0}% in positions 1–3.`;

  // 1b) DataForSEO search visibility over time (rank_history) — reconciled window
  const rh = data.rankHistory ?? [];
  rankHistChart?.dispose();
  rankHistChart = echarts.init($('rankHistChart'));
  if (rh.length) {
    const rhBuckets = [
      { key: 'pos_1_3' as const, name: 'Pos 1–3', color: col.green },
      { key: 'pos_4_10' as const, name: 'Pos 4–10', color: col.accent },
      { key: 'pos_11_20' as const, name: 'Pos 11–20', color: col.amber },
      { key: 'pos_21_100' as const, name: 'Pos 21–100', color: col.muted },
    ];
    rankHistChart.setOption({
      ...ARIA,
      grid: { left: 48, right: 56, top: 32, bottom: 30 },
      legend: { top: 0, textStyle: { color: col.text, fontSize: 12 } },
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: rh.map(p => p.period), ...axis },
      yAxis: [
        { type: 'value', name: 'keywords', ...axis },
        { type: 'value', name: 'ETV', ...axis, splitLine: { show: false } },
      ],
      series: [
        ...rhBuckets.map(b => ({
          name: b.name, type: 'line', stack: 'kw', showSymbol: false, lineStyle: { width: 0 },
          areaStyle: { opacity: 0.55 }, itemStyle: { color: b.color }, data: rh.map(p => p[b.key]),
        })),
        { name: 'ETV', type: 'line', yAxisIndex: 1, smooth: true, showSymbol: false, data: rh.map(p => Math.round(p.etv)), lineStyle: { color: col.red, width: 2 }, itemStyle: { color: col.red } },
      ],
    });
    $('rankHistSummary').textContent = `DataForSEO ranking keywords by position bucket across ${rh.length} months, with estimated traffic value.`;
  } else {
    rankHistChart.setOption({ ...ARIA, title: { text: 'No rank history yet — run track_ranks', left: 'center', top: 'center', textStyle: { color: col.muted, fontSize: 13, fontWeight: 'normal' } } });
    $('rankHistSummary').textContent = 'No DataForSEO rank history yet.';
  }
  $('alignNote').textContent = data.dateAlignment?.note ?? '';

  // 2) Rank + clicks over time (dual-axis) — flagship #6
  const trend = data.rankTrend ?? [];
  rankChart?.dispose();
  rankChart = echarts.init($('rankChart'));
  rankChart.setOption({
    ...ARIA,
    grid: { left: 48, right: 48, top: 20, bottom: 30 },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: trend.map(t => t.date), ...axis },
    yAxis: [
      { type: 'value', name: 'position', inverse: true, min: 1, ...axis },
      { type: 'value', name: 'clicks', ...axis, splitLine: { show: false } },
    ],
    series: [
      { name: 'clicks', type: 'bar', yAxisIndex: 1, data: trend.map(t => t.clicks), itemStyle: { color: col.violet, opacity: 0.35 } },
      { name: 'avg position', type: 'line', yAxisIndex: 0, smooth: true, showSymbol: false, data: trend.map(t => Math.round(t.position * 10) / 10), lineStyle: { color: col.accent, width: 2 }, itemStyle: { color: col.accent } },
    ],
  });
  $('rankSummary').textContent = `Average Google position (higher is better) and daily clicks over ${trend.length} days.`;

  // (Striking-distance now lives in the Opportunities quick-wins matrix — no separate scatter.)

  // 3b) Quick-wins matrix — CTR vs position against the expected-CTR curve, coloured by opportunity
  const qw = data.quickWins ?? [];
  quickWinsChart?.dispose();
  quickWinsChart = echarts.init($('quickWinsChart'));
  if (qw.length) {
    // Expected-CTR curve derived from the data points (server's model) — no client-side duplication.
    const curveMap = new Map<number, number>();
    for (const q of qw) { const rp = Math.round(q.position); if (rp >= 1 && rp <= 10 && !curveMap.has(rp)) curveMap.set(rp, q.expectedCtr); }
    const curve = [...curveMap.entries()].sort((a, b) => a[0] - b[0]);
    const bub = (v: any) => Math.max(6, Math.min(46, 6 + Math.sqrt(v[2]) * 2.2));
    const SER_NAME: Record<string, string> = { striking: 'Striking distance', snippet: 'Under-clicked', serp: 'Verify (SERP/cannibalisation)', ok: 'On track' };
    const ser = (type: string, color: string, opacity: number) => ({
      name: SER_NAME[type], type: 'scatter', symbolSize: bub, itemStyle: { color, opacity },
      data: qw.filter(q => q.type === type).map(q => [q.position, q.ctr, q.impressions, q.expectedCtr, q.potential, q.query, q.type]),
    });
    quickWinsChart.setOption({
      ...ARIA,
      grid: { left: 56, right: 24, top: 34, bottom: 42 },
      legend: { top: 0, textStyle: { color: col.text, fontSize: 12 }, data: [SER_NAME.striking, SER_NAME.snippet, SER_NAME.serp, SER_NAME.ok, 'Expected CTR'] },
      tooltip: { trigger: 'item', formatter: (p: any) => Array.isArray(p.value) ? `${esc(String(p.value[5]))}<br/>pos ${p.value[0]} · CTR ${p.value[1]}% (expected ${p.value[3]}%)<br/>${fmt(p.value[2])} impressions${p.value[6] === 'serp' ? '<br/><em>near-zero CTR — likely a SERP feature or cannibalisation; verify before rewriting</em>' : ` · ~${fmt(p.value[4])} clicks recoverable`}` : '' },
      xAxis: { type: 'value', name: 'avg position', min: 1, max: 20, ...axis },
      yAxis: { type: 'value', name: 'CTR %', min: 0, ...axis },
      series: [
        ser('ok', col.muted, 0.28),
        ser('serp', col.red, 0.5),
        ser('striking', col.amber, 0.7),
        ser('snippet', col.accent, 0.7),
        { name: 'Expected CTR', type: 'line', data: curve, lineStyle: { color: col.text, type: 'dashed', width: 1.5, opacity: 0.5 }, symbol: 'none', tooltip: { show: false }, z: 1 },
      ],
    });
  } else {
    quickWinsChart.setOption({ ...ARIA, graphic: { type: 'text', left: 'center', top: 'middle', style: { text: 'No query data yet — sync Search Console.', fill: col.muted, fontSize: 13 } } });
  }

  // Biggest quick wins table — ranked by recoverable clicks
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
    : '<p class="muted">No quick wins surfaced — run a sync + audit, or this property is already clicking to potential.</p>';

  // Content decay — pages to refresh, ranked by clicks lost
  const decay = data.contentDecay ?? [];
  const decayRows = decay.map(d => {
    const path = esc((d.urlKey || '').replace(/^https?:\/\/[^/]+/, '') || '/');
    return `<tr><td class="url" title="${esc(d.urlKey || '')}">${path}</td>` +
      `<td class="num">${fmt(d.prevClicks)}</td><td class="num">${fmt(d.clicks)}</td>` +
      `<td class="num"><span class="impact ${d.dropPct >= 60 ? 'impact-xl' : d.dropPct >= 35 ? 'impact-l' : 'impact-m'}">−${d.dropPct}%</span></td>` +
      `<td class="num">${fmt(d.lost)}</td><td class="num">${fmt(d.impressions)}</td><td class="num">${d.position || '—'}</td></tr>`;
  }).join('');
  $('contentDecayTable').innerHTML = decay.length
    ? `<table><thead><tr><th>Page</th><th class="num">Was</th><th class="num">Now</th><th class="num">Drop</th><th class="num">Clicks lost</th><th class="num">Impr</th><th class="num">Pos</th></tr></thead><tbody>${decayRows}</tbody></table>`
    : '<p class="muted">No significant content decay — no page lost 20%+ of its clicks vs the prior 28 days.</p>';

  // Cannibalisation — accordion per contested query, expand to the competing URLs
  const cannT = data.cannibalisationTable ?? [];
  $('cannTable').innerHTML = cannT.length
    ? cannT.map(q => {
        const verd = q.verdict === 'split'
          ? '<span class="impact impact-l">Split</span>'
          : '<span class="impact impact-s">Dominant</span>';
        // Cross-type (different page templates competing) is the most actionable — lead with it.
        const cross = q.crossType ? '<span class="impact impact-xl">Cross-type</span>' : '';
        const rows = q.urls.map(u => {
          const path = esc((u.url || '').replace(/^https?:\/\/[^/]+/, '') || '/');
          return `<div class="rec-ex"><a class="rec-url" href="${esc(u.url || '')}" title="${esc(u.url || '')}" target="_blank" rel="noopener">${path}</a><span class="cann-type">${esc(u.template)}</span><span class="rec-ex-detail">pos ${u.position}</span><span class="rec-ex-traf">${fmt(u.clicks)} clicks · ${fmt(u.impressions)} impr</span></div>`;
        }).join('');
        return `<details class="rec-acc"><summary>` +
          `${cross}${verd}<span class="rec-title">“${esc(q.query)}”</span>` +
          `<span class="rec-count">${q.urlCount} URLs · ${fmt(q.totalClicks)} clicks · ${fmt(q.totalImpressions)} impr</span><span class="rec-chev" aria-hidden="true">›</span>` +
          `</summary><div class="rec-body"><div class="rec-examples"><div class="rec-label">Competing URLs</div>${rows}</div></div></details>`;
      }).join('')
    : '<p class="muted">No cannibalisation detected — no query has 2+ of your URLs competing with real impressions.</p>';

  // 4) Top keyword performance (green/red + signed label so colour isn't the only cue)
  const kw = (data.topKeywords ?? []).slice().reverse(); // horizontal bar reads top-down
  kwChart?.dispose();
  kwChart = echarts.init($('kwChart'));
  kwChart.setOption({
    ...ARIA,
    grid: { left: 8, right: 44, top: 10, bottom: 24, containLabel: true },
    tooltip: { trigger: 'item', formatter: (pa: any) => `${pa.name}<br/>Δ clicks: ${pa.value >= 0 ? '+' : ''}${pa.value} (now ${kw[pa.dataIndex].clicks})` },
    xAxis: { type: 'value', ...axis },
    yAxis: { type: 'category', data: kw.map(k => k.query), axisLabel: { color: col.axisText, width: 180, overflow: 'truncate' }, axisLine: { lineStyle: { color: col.border } } },
    series: [{
      type: 'bar',
      label: { show: true, position: 'right', color: col.muted, fontSize: 11, formatter: (p: any) => (p.value > 0 ? '+' : '') + p.value },
      data: kw.map(k => ({ value: k.clicksChange, itemStyle: { color: k.clicksChange >= 0 ? col.green : col.red } })),
    }],
  });
  kwChart.off('click');
  kwChart.on('click', (pa: any) => { void loadRelated(kw[pa.dataIndex].query); });
  const up = kw.filter(k => k.clicksChange > 0).length, down = kw.filter(k => k.clicksChange < 0).length;
  $('kwSummary').textContent = `${kw.length} top keywords; ${up} improved and ${down} declined versus the prior period (signed click change shown on each bar).`;

  // Report tables (agency-style)
  const pp = data.pagePerformance ?? [];
  $('pagePerfTable').innerHTML = pp.length
    ? tableHtml(['Trend', 'Page', 'Clicks', 'Δ%', 'Impr', 'Pos'], pp.map(p => `<tr><td><span class="cat ${catClass(p.category)}">${p.category}</span></td><td class="url" title="${esc(p.urlKey)}">${esc(shortPath(p.urlKey))}</td><td class="num">${p.clicks}</td><td class="num">${p.clicksChangePct > 0 ? '+' : ''}${p.clicksChangePct}%</td><td class="num">${p.impressions}</td><td class="num">${p.position}</td></tr>`))
    : '<div class="hint">No GSC data.</div>';
  $('pagePerfSummary').textContent = `${pp.length} pages categorised by 28-day trend.`;

  const mv = data.keywordMovement ?? [];
  $('movementTable').innerHTML = mv.length
    ? tableHtml(['Movement', 'Query', 'First', 'Last', 'Δ pos'], mv.map(m => `<tr><td><span class="cat ${catClass(m.category)}">${m.category}</span></td><td>${esc(m.query)}</td><td class="num">${m.firstPos}</td><td class="num">${m.lastPos}</td><td class="num">${m.delta > 0 ? '+' : ''}${m.delta}</td></tr>`))
    : '<div class="hint">No movement data.</div>';
  $('movementSummary').textContent = `${mv.length} queries with rank movement.`;

  const dv = data.deviceBreakdown ?? [];
  $('deviceTable').innerHTML = dv.length
    ? tableHtml(['Device', 'Clicks', 'Prev', 'CTR', 'Pos'], dv.map(d => `<tr><td>${d.device}</td><td class="num">${d.clicks}</td><td class="num">${d.prevClicks}</td><td class="num">${(d.ctr * 100).toFixed(1)}%</td><td class="num">${d.position}</td></tr>`))
    : '<div class="hint">—</div>';

  const ct = data.countryBreakdown ?? [];
  $('countryTable').innerHTML = ct.length
    ? tableHtml(['Country', 'Clicks', 'Prev', 'Impr'], ct.map(c => `<tr><td>${esc(c.country.toUpperCase())}</td><td class="num">${c.clicks}</td><td class="num">${c.prevClicks}</td><td class="num">${c.impressions}</td></tr>`))
    : '<div class="hint">—</div>';
  // Hide breakdowns that carry only one value (e.g. a single-country property) — a one-row table is
  // noise, not insight. Show a block only with genuine variety (2+ rows); hide the card if neither has.
  const showDev = dv.length >= 2, showCty = ct.length >= 2;
  const setVis = (id: string, on: boolean): void => { const e = document.getElementById(id); if (e) e.style.display = on ? '' : 'none'; };
  setVis('deviceBlock', showDev); setVis('countryBlock', showCty); setVis('breakdownsCard', showDev || showCty);

  setupTabs();
}

// Tabbed nav: switch panels, and resize the ECharts in the newly-shown panel — charts created in a
// display:none panel lay out at 0×0, so they must be resized once their container is visible.
function setupTabs(): void {
  const live = (): (echarts.ECharts | null)[] => [distChart, rankHistChart, rankChart, kwChart, mismatchChart, scatterChart, cannChart, quickWinsChart];
  const resizeVisible = (): void => { for (const c of live()) { try { if (c && (c.getDom() as HTMLElement).offsetParent !== null) c.resize(); } catch { /* disposed */ } } };
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
    b.textContent = label;
    b.onclick = fn;
    bar.appendChild(b);
  };
  if (data.findings?.top?.length) {
    mk('↓ Findings CSV', () => downloadCsv('seo-findings.csv', [
      ['severity', 'check', 'url', 'clicks', 'impressions', 'position', 'priority', 'fix'],
      ...data.findings!.top.map(f => {
        const rec = safeJson(f.recommendation), t = safeJson(f.traffic_at_risk);
        return [f.severity, f.check_id, f.url_key ?? '', t.clicks ?? 0, t.impressions ?? 0, t.position ? t.position.toFixed(1) : '', f.priority.toFixed(3), rec.text ?? ''];
      }),
    ]));
  }
  if (data.topKeywords?.length) {
    mk('↓ Keywords CSV', () => downloadCsv('keywords.csv', [
      ['query', 'clicks', 'prevClicks', 'clicksChange', 'avgPosition', 'prevPosition'],
      ...data.topKeywords!.map(k => [k.query, k.clicks, k.prevClicks, k.clicksChange, k.position, k.prevPosition]),
    ]));
  }
  if (data.strikingDistance?.length) {
    mk('↓ Striking-distance CSV', () => downloadCsv('striking-distance.csv', [
      ['query', 'position', 'impressions', 'clicks'],
      ...data.strikingDistance!.map(s => [s.query, s.position, s.impressions, s.clicks]),
    ]));
  }
  if (data.pagePerformance?.length) {
    mk('↓ Pages CSV', () => downloadCsv('page-performance.csv', [
      ['category', 'url', 'clicks', 'prevClicks', 'clicksChangePct', 'impressions', 'position'],
      ...data.pagePerformance!.map(p => [p.category, p.urlKey, p.clicks, p.prevClicks, p.clicksChangePct, p.impressions, p.position]),
    ]));
  }
  if (data.keywordMovement?.length) {
    mk('↓ Movement CSV', () => downloadCsv('keyword-movement.csv', [
      ['category', 'query', 'firstPos', 'lastPos', 'delta', 'firstDate', 'lastDate'],
      ...data.keywordMovement!.map(m => [m.category, m.query, m.firstPos, m.lastPos, m.delta, m.firstDate, m.lastDate]),
    ]));
  }
}

// On-demand only: fetch DataForSEO data for the ONE clicked keyword (never bulk —
// a site can have a million keywords; we enrich what's on screen / clicked).
async function loadRelated(keyword: string): Promise<void> {
  const el = $('related');
  el.innerHTML = `<div class="group-label">Looking up “${keyword}”…</div>`;
  try {
    const [relRes, volRes] = await Promise.all([
      app.callServerTool({ name: 'related_terms', arguments: { keyword } }) as Promise<any>,
      (app.callServerTool({ name: 'keyword_volume', arguments: { keywords: [keyword] } }) as Promise<any>).catch(() => null),
    ]);
    const sc = relRes?.structuredContent ?? {};
    const paa: string[] = sc.peopleAlsoAsk ?? [];
    const rel: string[] = sc.relatedSearches ?? [];
    const vol = volRes?.structuredContent?.keywords?.[0];
    const tags = (xs: string[]): string => xs.map(x => `<span class="tag">${x}</span>`).join('');
    el.innerHTML =
      (vol ? `<div class="group-label">“${keyword}” — search volume</div><span class="tag">${vol.searchVolume ?? 'n/a'}/mo</span><span class="tag">CPC ${vol.cpc ?? 'n/a'}</span>` : '') +
      (paa.length ? `<div class="group-label">People also ask</div>${tags(paa)}` : '') +
      (rel.length ? `<div class="group-label">Related searches</div>${tags(rel)}` : '') +
      (!paa.length && !rel.length && !vol ? `<div class="group-label">No DataForSEO data for “${keyword}”.</div>` : '');
  } catch {
    el.innerHTML = `<div class="group-label">DataForSEO credentials needed for keyword lookups.</div>`;
  }
}

// Boot: connect to the host. Production-inert preview hook — a screenshot harness can
// set window.__DASH_FIXTURE__ to render real data with no host. Placed last so every
// definition (incl. SEV_ORDER/renderFindings) is initialised before render() runs.
const __fixture = (window as any).__DASH_FIXTURE__;
if (__fixture) {
  applyHostContext({ theme: (window as any).__DASH_THEME__ ?? 'light' });
  currentData = __fixture; render(__fixture);
} else {
  app.connect().then(() => applyHostContext(app.getHostContext() as any));
}
