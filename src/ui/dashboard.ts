import * as echarts from 'echarts';
import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';

// Local view types (avoid importing core, which pulls node-only deps into the bundle).
interface Totals { clicks: number; impressions: number; ctr: number; position: number }
interface DashboardData {
  siteUrl: string;
  empty?: boolean;
  dateRange?: { current: string; prior?: string; maxDate: string };
  summary?: { current: Totals; prior: Totals };
  rankTrend?: { date: string; clicks: number; position: number }[];
  rankingDistribution?: { date: string; b1: number; b2: number; b3: number; b4: number }[];
  strikingDistance?: { query: string; position: number; impressions: number; clicks: number }[];
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
let strikeChart: echarts.ECharts | null = null;
let kwChart: echarts.ECharts | null = null;
let mismatchChart: echarts.ECharts | null = null;
let scatterChart: echarts.ECharts | null = null;
let cannChart: echarts.ECharts | null = null;
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

window.addEventListener('resize', () => { distChart?.resize(); rankHistChart?.resize(); rankChart?.resize(); strikeChart?.resize(); kwChart?.resize(); });

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

// Audit-deliverable view: issues grouped by category, each sub-headed with a real example + fix.
function renderRecommendations(fc: DashboardData['findings']): void {
  const el = $('recs');
  if (!fc || !fc.recommendations?.length) { el.innerHTML = '<p class="muted">No audit yet — run run_audit.</p>'; return; }
  el.innerHTML = fc.recommendations.map(cat => {
    const items = cat.checks.map(c => {
      const ex = c.example;
      const fullPath = ex?.urlKey ? (ex.urlKey.replace(/^https?:\/\/[^/]+/, '') || '/') : '';
      const path = esc(fullPath.length > 72 ? fullPath.slice(0, 72) + '…' : fullPath); // keep long/query URLs to one line
      const detail = ex ? esc(evidenceSummary(ex.evidence)) : '';
      const traffic = ex && (ex.clicks || ex.impressions) ? ` · ${ex.clicks} clicks / ${ex.impressions} impr` : '';
      const example = ex && (fullPath || detail)
        ? `<div class="rec-example"><span class="rec-label">Example</span> ${fullPath ? `<a class="rec-url" href="${esc(ex!.urlKey || '')}" title="${esc(fullPath)}" target="_blank" rel="noopener">${path}</a>` : '(site-wide)'}${detail ? ` — ${detail}` : ''}${traffic}</div>`
        : '';
      return `<div class="rec-item"><div class="rec-head"><span class="sev ${c.severity}">${c.severity}</span>` +
        `<span class="rec-title">${esc(c.title)}</span><span class="rec-count">${c.count} affected</span></div>` +
        `${example}<div class="rec-fix"><span class="rec-label">Fix</span> ${esc(c.fix)}</div></div>`;
    }).join('');
    return `<div class="rec-cat"><h4 class="rec-cat-title">${esc(CAT_LABEL[cat.category] || cat.category)} <span class="rec-cat-count">${cat.checks.length}</span></h4>${items}</div>`;
  }).join('');
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

  const drawTable = (): void => {
    const rows = fc.top.filter(f => active === 'all' || f.severity === active).slice(0, 25).map(f => {
      const rec = safeJson(f.recommendation), traf = safeJson(f.traffic_at_risk);
      const path = (f.url_key || '—').replace(/^https?:\/\/[^/]+/, '') || '/';
      const pct = Math.max(3, Math.round((f.priority / maxPrio) * 100));
      return `<tr><td><span class="sev ${f.severity}">${f.severity}</span></td><td>${esc(rec.title || f.check_id)}</td>` +
        `<td class="url" title="${esc(f.url_key || '')}">${esc(path)}</td><td class="num">${traf.clicks || 0}</td>` +
        `<td class="num">${traf.impressions || 0}</td>` +
        `<td class="prio"><span class="prio-wrap"><span class="prio-bar s-${f.severity}" style="width:${pct}%"></span><span class="prio-val">${esc((f.size ?? '') + ' ' + (f.impact ?? pct))}</span></span></td>` +
        `<td class="fix" title="${esc(rec.text || '')}">${esc(rec.text || '')}</td></tr>`;
    });
    tableEl.innerHTML = rows.length
      ? `<table><thead><tr><th>Sev</th><th>Issue</th><th>URL</th><th class="num">Clicks</th><th class="num">Impr</th><th>Impact</th><th>Fix</th></tr></thead><tbody>${rows.join('')}</tbody></table>`
      : '<p class="muted">No findings at this severity in the top results.</p>';
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

function metricCard(label: string, value: string, change: number, lowerIsBetter = false): string {
  const better = lowerIsBetter ? change < 0 : change > 0;
  const cls = change === 0 ? 'flat' : better ? 'up' : 'down';
  const arrow = change === 0 ? '' : change > 0 ? '▲' : '▼';
  const pct = `${arrow} ${Math.abs(Math.round(change))}%`;
  return `<div class="metric-card"><div class="label">${label}</div><div class="value">${value}</div><div class="chg ${cls}">${pct}</div></div>`;
}

function render(data: DashboardData): void {
  $('loading').style.display = 'none';
  if (data.empty || !data.summary) { $('empty').style.display = 'flex'; return; }
  $('content').style.display = 'block';
  $('site').textContent = data.siteUrl;
  $('range').textContent = data.dateRange?.current ?? '';

  const c = data.summary.current, p = data.summary.prior;
  const pctChg = (a: number, b: number): number => (b ? ((a - b) / b) * 100 : 0);
  $('metrics').innerHTML =
    metricCard('Clicks', fmt(c.clicks), pctChg(c.clicks, p.clicks)) +
    metricCard('Impressions', fmt(c.impressions), pctChg(c.impressions, p.impressions)) +
    metricCard('CTR', `${(c.ctr * 100).toFixed(1)}%`, pctChg(c.ctr, p.ctr)) +
    metricCard('Avg position', c.position.toFixed(1), pctChg(c.position, p.position), true);

  const col = palette();
  // axis tick labels + axis names use primary text (high contrast: white on dark, near-black on light)
  const axis = { axisLine: { lineStyle: { color: col.border } }, axisLabel: { color: col.axisText, fontSize: 12 }, nameTextStyle: { color: col.axisText, fontSize: 12 }, splitLine: { lineStyle: { color: col.grid } } };

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

  // 3) Striking-distance keywords (bubble) — flagship #2
  const strike = data.strikingDistance ?? [];
  strikeChart?.dispose();
  strikeChart = echarts.init($('strikeChart'));
  strikeChart.setOption({
    ...ARIA,
    grid: { left: 60, right: 24, top: 20, bottom: 40 },
    tooltip: { trigger: 'item', formatter: (p: any) => `${strike[p.dataIndex].query}<br/>pos ${p.value[0]}, ${p.value[1]} impressions, ${strike[p.dataIndex].clicks} clicks` },
    xAxis: { type: 'value', name: 'avg position', min: 10, max: 20, inverse: true, ...axis },
    yAxis: { type: 'value', name: 'impressions', ...axis },
    series: [{
      type: 'scatter',
      symbolSize: (v: number[]) => Math.max(6, Math.min(42, 6 + Math.sqrt(v[2]) * 3)),
      itemStyle: { color: col.accent, opacity: 0.6 },
      data: strike.map(s => [s.position, s.impressions, s.clicks]),
    }],
  });
  $('strikeSummary').textContent = `${strike.length} queries ranking on page two (positions 11–20) with impressions — page-1 opportunities; bubble size is clicks.`;

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
