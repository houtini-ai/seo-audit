import * as echarts from 'echarts';
import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';

// Local view types (avoid importing core, which pulls node-only deps into the bundle).
interface Totals { clicks: number; impressions: number; ctr: number; position: number }
interface DashboardData {
  siteUrl: string;
  empty?: boolean;
  dateRange?: { current: string; maxDate: string };
  summary?: { current: Totals; prior: Totals };
  rankTrend?: { date: string; clicks: number; position: number }[];
  topKeywords?: { query: string; clicks: number; prevClicks: number; clicksChange: number; position: number; prevPosition: number }[];
}

const $ = (id: string): HTMLElement => document.getElementById(id)!;
const cssVar = (n: string, fb = ''): string => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || fb;
const fmt = (n: number): string => new Intl.NumberFormat('en', { notation: n >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(n);

function palette() {
  return {
    text: cssVar('--color-text-primary', '#0a0b0d'),
    muted: cssVar('--color-text-tertiary', '#62666d'),
    accent: cssVar('--color-accent', '#5b5fff'),
    violet: cssVar('--color-brand-violet', '#8b5cf6'),
    grid: cssVar('--chart-grid', 'rgba(10,11,13,0.06)'),
    green: cssVar('--color-status-live', '#16a34a'),
    red: cssVar('--color-status-error', '#ef4444'),
    surface: cssVar('--color-surface-elevated', '#ffffff'),
    border: cssVar('--color-border-standard', 'rgba(10,11,13,0.1)'),
  };
}

let currentData: DashboardData | null = null;
let rankChart: echarts.ECharts | null = null;
let kwChart: echarts.ECharts | null = null;

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

app.ontoolresult = (result) => {
  const data = result.structuredContent as DashboardData | undefined;
  if (data) { currentData = data; render(data); }
};

app.connect().then(() => applyHostContext(app.getHostContext() as any));
window.addEventListener('resize', () => { rankChart?.resize(); kwChart?.resize(); });

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
  const axis = { axisLine: { lineStyle: { color: col.border } }, axisLabel: { color: col.muted }, splitLine: { lineStyle: { color: col.grid } } };

  // Rank + clicks over time
  const trend = data.rankTrend ?? [];
  rankChart?.dispose();
  rankChart = echarts.init($('rankChart'));
  rankChart.setOption({
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

  // Top keyword performance (clicks change), green/red
  const kw = (data.topKeywords ?? []).slice().reverse(); // horizontal bar reads top-down
  kwChart?.dispose();
  kwChart = echarts.init($('kwChart'));
  kwChart.setOption({
    grid: { left: 8, right: 24, top: 10, bottom: 24, containLabel: true },
    tooltip: { trigger: 'item', formatter: (pa: any) => `${pa.name}<br/>Δ clicks: ${pa.value >= 0 ? '+' : ''}${pa.value} (now ${kw[pa.dataIndex].clicks})` },
    xAxis: { type: 'value', ...axis },
    yAxis: { type: 'category', data: kw.map(k => k.query), axisLabel: { color: col.muted, width: 180, overflow: 'truncate' }, axisLine: { lineStyle: { color: col.border } } },
    series: [{
      type: 'bar',
      data: kw.map(k => ({ value: k.clicksChange, itemStyle: { color: k.clicksChange >= 0 ? col.green : col.red } })),
    }],
  });
  kwChart.off('click');
  kwChart.on('click', (pa: any) => { void loadRelated(kw[pa.dataIndex].query); });
}

async function loadRelated(keyword: string): Promise<void> {
  const el = $('related');
  el.innerHTML = `<div class="group-label">Related to “${keyword}”…</div>`;
  try {
    const res: any = await app.callServerTool({ name: 'related_terms', arguments: { keyword } });
    const sc = res?.structuredContent ?? {};
    const paa: string[] = sc.peopleAlsoAsk ?? [];
    const rel: string[] = sc.relatedSearches ?? [];
    const tags = (xs: string[]): string => xs.map(x => `<span class="tag">${x}</span>`).join('');
    el.innerHTML =
      (paa.length ? `<div class="group-label">People also ask</div>${tags(paa)}` : '') +
      (rel.length ? `<div class="group-label">Related searches</div>${tags(rel)}` : '') +
      (!paa.length && !rel.length ? `<div class="group-label">No related terms found for “${keyword}”.</div>` : '');
  } catch {
    el.innerHTML = `<div class="group-label">Related terms need DataForSEO credentials.</div>`;
  }
}
