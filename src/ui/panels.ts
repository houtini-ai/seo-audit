// Shared panel renderers for the dashboard: the sidebar
// freshness block, the crawl-health header and status mix, the Search performance trend and top
// keyword / page tables, and the network graph. Several of these were the Overview tab's panels;
// the Summary tab (summary.ts) replaced the Overview as the landing view and they moved to the tabs
// they belong to. Pure HTML-string + ECharts builders; dashboard.ts owns the data load, the chart
// registry and the tab shell, and passes them in.
import { esc, fmtNum, fmtCompact, fmtDate, countDelta, axisDefaults, tooltipDefaults, monoFont, type ChartPalette, type EChartWrapper } from './lib/index.js';
import { shareText, sharePct, sourceFreshness, freshnessDot } from '../core/displayRules.js';

const fmt = fmtNum;
import type { DashboardData } from './dashboard.js';
// The payload type lives in dashboard.ts (local view types, so core's node-only deps stay out of
// the bundle). Fields this module reads that the view type doesn't declare are accessed via `x`.
type Dash = DashboardData;
const x = (d: unknown): any => d;

export interface OverviewCtx {
  wrap: (id: string, group?: string) => EChartWrapper;
  col: ChartPalette & { green: string; red: string; amber: string; grey: string; blue: string };
  shortPath: (u: string, max?: number) => string;
  safeJson: (s: string) => any;
  redacted: boolean;
}

// One severity vocabulary for the whole UI (dashboard.ts imports these too).
export const SEV_ORDER = ['crit', 'high', 'med', 'low', 'info'] as const;
export const SEV_LABEL: Record<string, string> = { crit: 'Critical', high: 'High', med: 'Medium', low: 'Low', info: 'Info' };
const SEV = [
  { key: 'crit', label: SEV_LABEL.crit, dot: 'dot-crit', bar: 'var(--intent-danger)' },
  { key: 'high', label: SEV_LABEL.high, dot: 'dot-high', bar: 'var(--intent-warning)' },
  { key: 'med', label: SEV_LABEL.med, dot: 'dot-med', bar: 'var(--intent-info)' },
  { key: 'low', label: SEV_LABEL.low, dot: 'dot-low', bar: 'var(--text-faint)' },
] as const;

/** Percentage change from baseline b to a (0 when there is no baseline). Shared with dashboard.ts. */
export const pctChg = (a: number, b: number): number => (b ? ((a - b) / b) * 100 : 0);

/** "3h ago" / "2d ago" from a SQLite datetime ('YYYY-MM-DD HH:MM:SS', UTC) or ISO string. */
export function ago(at: string | null | undefined, now = Date.now()): string {
  if (!at) return '-';
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(at) ? at : `${at.replace(' ', 'T')}Z`);
  if (!Number.isFinite(t)) return at.slice(0, 10);
  const s = Math.max(0, (now - t) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 60) return `${Math.round(s / 86400)}d ago`;
  return fmtDate(at);
}

/**
 * One freshness verdict per data source, shared by the Summary strip and the sidebar so the two
 * never disagree: the staleness rule (core/displayRules.ts sourceFreshness), the audit-predates-
 * crawl flag, and the dot that follows from them.
 */
export function freshVerdict(d: Dash, kind: string, s: { state: string; at: string | null }): { dot: string; flag: string; rule: string } {
  const gscEnd = x(d).dateRange?.rawMaxDate ?? x(d).coverage?.gsc?.maxDate ?? null;
  const f = sourceFreshness(kind, s, { gscEnd });
  let flag = f.stale ? 'stale' : '', rule = f.rule;
  if (kind === 'sync' && s.state !== 'never' && x(d).dateRange?.trimmedDays) {
    const n = x(d).dateRange.trimmedDays;
    rule += ` The last ${n} unfinalised day${n > 1 ? 's are' : ' is'} left out of every figure.`;
  }
  if (kind === 'audit' && x(d).freshness?.auditVsCrawl?.predatesCrawl) {
    flag = 'older than crawl';
    rule += ' The latest audit ran before the latest completed crawl, so its findings describe the previous crawl: run run_audit.';
  }
  return { dot: freshnessDot(s.state, !!flag), flag, rule };
}
const KIND_LABEL: Record<string, string> = { sync: 'Sync', crawl: 'Crawl', audit: 'Audit', inspect: 'Inspect', ranks: 'Ranks', sitemap: 'Sitemap' };

// ── KPI tile (the crawl-health strip) ──
interface Tile { label: string; value: string; sub?: string; color?: string }
const tile = (t: Tile): string =>
  `<div class="metric-card"><div class="label">${esc(t.label)}</div>` +
  `<div class="value"${t.color ? ` style="color:${t.color}"` : ''}>${t.value}</div>` +
  (t.sub ? `<div class="metric-sub">${t.sub}</div>` : '') + `</div>`;

// ── Small multiples: clicks / impressions / position on one shared x (never dual-axis) ──
function trendMultiples(d: Dash, ctx: OverviewCtx): void {
  const { col } = ctx;
  const t = d.rankTrend ?? [];
  if (!document.getElementById('spTrendChart')) return;
  if (!t.length) { ctx.wrap('spTrendChart').setEmpty('No Search Console data yet - run sync_gsc', col); return; }
  const dates = t.map((x: any) => x.date);
  const series = [
    { name: 'Clicks', data: t.map((x: any) => x.clicks), color: col.accent, inverse: false, fmtV: (v: number) => fmtCompact(v) },
    { name: 'Impressions', data: t.map((x: any) => x.impressions), color: col.categorical[0], inverse: false, fmtV: (v: number) => fmtCompact(v) },
    { name: 'Avg position', data: t.map((x: any) => (x.position > 0 ? Math.round(x.position * 10) / 10 : null)), color: col.categorical[1], inverse: true, fmtV: (v: number) => v.toFixed(1) },
  ];
  const H = 23, GAP = 9, TOP = 7;
  const ax = axisDefaults(col, { numeric: true });
  ctx.wrap('spTrendChart').setOption({
    aria: { enabled: true },
    animation: false,
    axisPointer: { link: [{ xAxisIndex: 'all' }], lineStyle: { color: col.border } },
    tooltip: { ...tooltipDefaults(col), trigger: 'axis' },
    grid: series.map((_, i) => ({ left: 52, right: 64, top: `${TOP + i * (H + GAP)}%`, height: `${H}%` })),
    // Each multiple is titled above its own plot (axis names collide on an inverted axis).
    title: series.map((x, i) => ({ text: x.name + (x.inverse ? '  (1 = top)' : ''), left: 52, top: `${TOP + i * (H + GAP) - 5.5}%`, textStyle: { color: col.text, fontSize: 11.5, fontWeight: 600 } })),
    xAxis: series.map((_, i) => ({
      type: 'category', gridIndex: i, data: dates, boundaryGap: false,
      axisLine: { lineStyle: { color: col.border } }, axisTick: { show: false },
      axisLabel: i === series.length - 1 ? { color: col.axisText, fontSize: 10.5, fontFamily: monoFont(), formatter: (v: string) => fmtDate(v, true), hideOverlap: true } : { show: false },
    })),
    yAxis: series.map((s, i) => ({
      type: 'value', gridIndex: i, inverse: s.inverse, scale: s.inverse, splitNumber: 2,
      ...ax, axisLine: { show: false },
    })),
    series: series.map((s, i) => ({
      name: s.name, type: 'line', xAxisIndex: i, yAxisIndex: i, showSymbol: false, smooth: 0.25, connectNulls: false,
      lineStyle: { width: 1.75, color: s.color }, itemStyle: { color: s.color },
      areaStyle: s.inverse ? undefined : { color: s.color, opacity: 0.08 },
      endLabel: { show: !ctx.redacted, color: col.text, fontFamily: monoFont(), fontSize: 11, formatter: (p: any) => (p.value == null ? '' : s.fmtV(Number(p.value))) },
      data: s.data,
    })),
  });
  const last = t[t.length - 1];
  const sum = document.getElementById('spTrendSummary');
  if (sum) sum.textContent = `${t.length} days of Search Console data; latest day ${fmt(last.clicks)} clicks, ${fmt(last.impressions)} impressions, average position ${last.position ? last.position.toFixed(1) : 'n/a'}.`;
  const src = document.getElementById('spTrendSrc');
  if (src) src.textContent = `GSC · ${t.length}d`;
}

// ── Crawl health summary: 100% status mix + leak rows ──
function crawlCard(d: Dash): string {
  const ch = d.crawlHealth;
  if (!ch?.totalPages) return '<div class="empty-state">No crawl yet - run <code>start_crawl</code> or <code>refresh_property</code>.</div>';
  const rc: { label: string; count: number }[] = ch.responseCodes ?? [];
  const byCls = (re: RegExp) => rc.filter(r => re.test(r.label)).reduce((s, r) => s + r.count, 0);
  const mix = [
    { k: '2xx', n: byCls(/^200/), c: 'var(--intent-success)' },
    { k: '3xx', n: byCls(/^3xx/), c: 'var(--chart-context)' },
    { k: '4xx', n: byCls(/^4xx/), c: 'var(--intent-warning)' },
    { k: '5xx / failed', n: byCls(/^5xx|Fetch failed/), c: 'var(--intent-danger)' },
  ].filter(m => m.n > 0);
  const tot = mix.reduce((s, m) => s + m.n, 0) || 1;
  const p = (n: number): string => shareText(n, tot);
  const bar = `<div class="mix" role="img" aria-label="Response status mix">${mix.map(m => `<span style="flex:${m.n};background:${m.c}" title="${m.k}: ${m.n}"></span>`).join('')}</div>`;
  const legend = `<div class="mix-legend">${mix.map(m => `<span><span class="dot" style="background:${m.c}"></span>${m.k} <b>${p(m.n)}%</b></span>`).join('')}</div>`;
  const total = ch.totalPages as number;
  const idx = (ch.indexability ?? []).find((r: any) => r.label === 'Indexable')?.count ?? 0;
  const flow: { label: string; count: number }[] = ch.urlFlow ?? [];
  const f = (re: RegExp): number => flow.filter(r => re.test(r.label)).reduce((s, r) => s + r.count, 0);
  const rows = [
    { label: 'Indexable', n: idx, c: 'var(--intent-success)' },
    { label: 'Canonicalised elsewhere', n: f(/Canonicalised/), c: 'var(--chart-categorical-1)' },
    { label: 'Redirected (3xx)', n: f(/redirect/i), c: 'var(--chart-context)' },
    { label: 'Not found (404 / 410)', n: f(/404|410/), c: 'var(--intent-danger)' },
  ];
  const statRows = rows.map(r => {
    const w = total ? Math.max(r.n ? 1 : 0, (r.n / total) * 100) : 0;
    return `<div class="stat-row"><div class="sr-top"><span>${r.label}</span><span><b>${fmt(r.n)}</b><em>${sharePct(r.n, total)}</em></span></div><div class="stat-track"><span style="width:${w.toFixed(1)}%;background:${r.c}"></span></div></div>`;
  }).join('');
  return bar + legend + `<div class="stat-rows">${statRows}</div>`;
}

/** Why a mapped page has no in-content link: an orphan, or linked only from navigation / footer. */
export const isolatedText = (n: { inlinks: number; bodyInlinks: number }): string =>
  n.inlinks === 0 ? 'Orphan: no internal link points to it.'
    : n.bodyInlinks === 0 ? `Linked only from navigation or the footer (${fmt(n.inlinks)} internal links in, none in content), so it has no in-content link in this map.`
      : `${fmt(n.bodyInlinks)} in-content links in, none from the other mapped pages.`;

/** The network force graph - shared by the Overview preview (compact) and the Network tab (full). */
export function drawNetwork(d: Dash, ctx: OverviewCtx, id: string, opts: { compact: boolean }): boolean {
  const sg = d.structureGraph;
  const { col } = ctx;
  if (!sg?.nodes?.length) { ctx.wrap(id).setEmpty('Run a crawl to map the internal link network', col); return false; }
  const nodes = opts.compact ? [...sg.nodes].sort((a: any, b: any) => b.ipr - a.ipr).slice(0, 90) : sg.nodes;
  const keep = new Set(nodes.map((n: any) => n.id));
  const catOf = (n: any): number => ((n.status == null || n.status >= 300) ? 2 : (n.indexable ? 0 : 1));
  const maxIpr = Math.max(...nodes.map((n: any) => n.ipr), 1);
  // Label only the highest-PageRank hubs (the rest are in the tooltip): more labels overlap.
  const narrow = (document.getElementById(id)?.clientWidth ?? 800) < 500;
  const labelled = new Set([...nodes].sort((a: any, b: any) => b.ipr - a.ipr).slice(0, opts.compact || narrow ? 6 : 10).map((n: any) => n.id));
  // Pages with no in-content link inside the map float free in a force layout: always label them
  // and draw them hollow, so a detached dot reads as a finding, not a rendering glitch.
  const isolated = new Map<string, any>((sg.isolated ?? []).map((n: any) => [n.id, n]));
  const isoIndex = new Map<string, number>([...isolated.keys()].map((id, i) => [id, i]));
  const H = document.getElementById(id)?.clientHeight || 560;
  const gnodes = nodes.map((n: any) => ({
    id: n.id, name: n.id, value: n.ipr, category: catOf(n),
    symbolSize: (opts.compact ? 4 : 5) + Math.round((n.ipr / maxIpr) * (opts.compact ? 18 : 26)),
    label: ((labelled.has(n.id) || isolated.has(n.id)) && !ctx.redacted)
      ? { show: true, formatter: isolated.has(n.id) ? `${ctx.shortPath(n.id, 22)} (no in-content link)` : ctx.shortPath(n.id, 22), color: col.muted, fontSize: 10, fontFamily: monoFont() } : { show: false },
    // Pinned in a column at the bottom left, so they never drift to (and clip at) the canvas edge.
    ...(isolated.has(n.id) ? { itemStyle: { color: col.surface, borderColor: catOf(n) === 0 ? col.green : catOf(n) === 1 ? col.amber : col.red, borderWidth: 2, borderType: 'dashed' }, fixed: true, x: 28, y: H - 26 - isoIndex.get(n.id)! * 28 } : {}),
    _s: n.status, _d: n.depth, _iso: isolated.get(n.id),
  }));
  const edgeColor = getComputedStyle(document.documentElement).getPropertyValue('--chart-edge').trim() || col.border;
  ctx.wrap(id).setOption({
    aria: { enabled: true },
    tooltip: { ...tooltipDefaults(col, 'item'), formatter: (p: any) => p.dataType === 'edge' ? '' : `${esc(ctx.shortPath(p.data.id, 48))}<br/>iPR ${p.data.value} · status ${p.data._s ?? '-'} · depth ${p.data._d ?? '-'}${p.data._iso ? `<br/>${isolatedText(p.data._iso)}` : ''}` },
    // No in-canvas legend: force-placed nodes ignore the layout box and ran under it. The card's
    // hint names the three colours.
    legend: undefined,
    series: [{
      type: 'graph', layout: 'force', roam: !opts.compact, draggable: !opts.compact,
      categories: [
        { name: 'Healthy', itemStyle: { color: col.green } },
        { name: 'Non-indexable', itemStyle: { color: col.amber } },
        { name: 'Broken / redirected', itemStyle: { color: col.red } },
      ],
      force: opts.compact ? { repulsion: 60, edgeLength: [18, 60], gravity: 0.14 } : { repulsion: 90, edgeLength: [30, 100], gravity: 0.16 },
      data: gnodes,
      links: sg.edges.filter((e: any) => keep.has(e.source) && keep.has(e.target)).map((e: any) => ({ source: e.source, target: e.target })),
      lineStyle: { color: edgeColor, width: 0.7, opacity: 1, curveness: 0.06 },
      itemStyle: { borderColor: col.surface, borderWidth: 1.5 },
      emphasis: { focus: 'adjacency', lineStyle: { color: col.accent, width: 1.4, opacity: 1 }, label: { show: !ctx.redacted } },
      label: { position: 'right' },
      labelLayout: { hideOverlap: true },
      top: 12, bottom: 12, left: 12, right: 12,
    }],
  });
  return true;
}

// ── Top keywords / pages ──
function kwTable(d: Dash): string {
  const kw = (d.topKeywords ?? []).slice().sort((a: any, b: any) => b.clicks - a.clicks).slice(0, 8);
  if (!kw.length) return `<div class="empty-state">${d.summary ? `No query appears in Search Console in the last ${d.dateRange?.days ?? 28} days.` : 'No keyword data yet - run <code>sync_gsc</code>.'}</div>`;
  const rows = kw.map((k: any) => {
    return `<tr><td class="q" title="${esc(k.query)}">${esc(k.query)}</td><td class="num">${fmt(k.clicks)}</td><td class="num">${countDelta(k.clicks, k.prevClicks)}</td><td class="num">${Number(k.position).toFixed(1)}</td></tr>`;
  }).join('');
  return `<table><thead><tr><th>Query</th><th class="num">Clicks</th><th class="num">Change</th><th class="num">Pos</th></tr></thead><tbody>${rows}</tbody></table>`;
}
function pageTable(d: Dash, ctx: OverviewCtx): string {
  const pp = (d.pagePerformance ?? []).slice().sort((a: any, b: any) => b.clicks - a.clicks).slice(0, 8);
  if (!pp.length) return `<div class="empty-state">${d.summary ? `No page appears in Search Console in the last ${d.dateRange?.days ?? 28} days.` : 'No page data yet - run <code>sync_gsc</code>.'}</div>`;
  const rows = pp.map((p: any) =>
    `<tr><td class="url" title="${esc(p.urlKey)}">${esc(ctx.shortPath(p.urlKey, 40))}</td><td class="num">${fmt(p.clicks)}</td><td class="num">${countDelta(p.clicks, p.prevClicks)}</td><td class="num">${Number(p.position).toFixed(1)}</td></tr>`).join('');
  return `<table><thead><tr><th>Page</th><th class="num">Clicks</th><th class="num">Change</th><th class="num">Pos</th></tr></thead><tbody>${rows}</tbody></table>`;
}

export function renderSideFreshness(d: Dash): void {
  const el = document.getElementById('sideFresh');
  if (!el) return;
  const src: any[] = (d.freshness?.sources ?? []).filter((s: any) => ['sync', 'crawl', 'audit'].includes(s.kind));
  el.innerHTML = src.length
    ? `<div class="side-fresh-title">Data freshness</div>` + src.map(s =>
{
        const v = freshVerdict(d, s.kind, s);
        return `<div class="fresh-row${v.flag ? ' fr-flag' : ''}" title="${esc([s.detail, v.flag ? `${v.flag}.` : '', v.rule].filter(Boolean).join(' '))}"><span class="dot ${v.dot}"></span><span class="fr-k">${esc(KIND_LABEL[s.kind])}</span><span class="fr-v">${s.state === 'never' ? 'never' : esc(ago(s.at))}</span></div>`;
      }).join('')
    : '';
}

// ── Crawl-health tab: KPI strip + canonical/redirect/404 table ──
export function renderHealthTop(d: Dash, ctx: OverviewCtx): void {
  const ch = d.crawlHealth;
  const k = document.getElementById('healthKpis');
  const flowEl = document.getElementById('urlFlow');
  const flowCard = document.getElementById('urlFlowCard');
  if (!ch?.totalPages) {
    if (k) k.innerHTML = '';
    if (flowCard) flowCard.style.display = 'none';
    const mixCard = document.getElementById('healthMixCard');
    if (mixCard) mixCard.style.display = 'none';
    return;
  }
  // The status mix + leak rows (formerly the Overview's crawl-health card).
  const mixCard = document.getElementById('healthMixCard');
  if (mixCard) mixCard.style.display = '';
  const mix = document.getElementById('healthMix');
  if (mix) mix.innerHTML = crawlCard(d);
  const cs = document.getElementById('healthMixSrc');
  const shown = x(d).freshness?.shownCrawl;
  if (cs) cs.textContent = shown?.at ? `Crawl · ${ago(shown.at)}${shown.partial ? ' (partial)' : ''}` : 'Crawl';
  const rc: any[] = ch.responseCodes ?? [];
  // HTTP statuses only: 'Blocked by robots' is an indexability reason and 'Fetch failed' comes from
  // the errors table, neither is a crawled page's status (they'd inflate the share past 100%).
  const non200 = rc.filter(r => /^[345]xx/.test(r.label)).reduce((s, r) => s + r.count, 0);
  const notFetched = rc.filter(r => /^(Blocked by robots|Fetch failed)/.test(r.label)).reduce((s, r) => s + r.count, 0);
  const redirects = rc.filter(r => /^3xx/.test(r.label)).reduce((s, r) => s + r.count, 0);
  const idx = (ch.indexability ?? []).find((r: any) => r.label === 'Indexable')?.count ?? 0;
  const depthRows: any[] = ch.depth ?? [];
  const depthN = depthRows.reduce((s, r) => s + r.count, 0);
  const depthAvg = depthN ? depthRows.reduce((s, r) => s + (parseInt(String(r.label).replace(/\D/g, ''), 10) || 0) * r.count, 0) / depthN : 0;
  const share = (n: number): string => `${sharePct(n, ch.totalPages)} of crawled`;
  if (k) k.innerHTML = ([
    { label: 'Pages crawled', value: fmt(ch.totalPages), sub: 'internal URLs, latest crawl' },
    { label: 'Indexable', value: fmt(idx), sub: share(idx), color: 'var(--intent-success)' },
    { label: 'Non-200', value: fmt(non200), sub: `${share(non200)}${notFetched ? ` · ${fmt(notFetched)} not fetched` : ''}`, color: non200 ? 'var(--intent-danger)' : '' },
    { label: 'Redirects', value: fmt(redirects), sub: share(redirects) },
    { label: 'Avg crawl depth', value: depthAvg ? depthAvg.toFixed(1) : '–', sub: 'from the start URL (6+ as 6)' },
  ] as Tile[]).map(tile).join('');
  const flow: any[] = ch.urlFlow ?? [];
  if (flowCard) flowCard.style.display = flow.length ? '' : 'none';
  if (flowEl && flow.length) {
    const tone: Record<string, string> = { bad: 'dot-bad', warn: 'dot-high', muted: 'dot-never' };
    flowEl.innerHTML = `<table><thead><tr><th>Type</th><th class="num">URLs</th><th class="num">Share</th><th>Most-linked example</th></tr></thead><tbody>${flow.map(r =>
      `<tr><td><span class="lbl-dot"><span class="dot ${tone[r.tone] ?? 'dot-never'}"></span>${esc(r.label)}</span></td><td class="num">${fmt(r.count)}</td><td class="num">${sharePct(r.count, ch.totalPages)}</td><td class="url" title="${esc(r.example ?? '')}">${esc(r.example ? ctx.shortPath(r.example, 60) : '-')}</td></tr>`).join('')}</tbody></table>`;
  }
}

/** Search performance tab, top: the daily small multiples and the top keyword / page tables. */
export function renderSearchTop(d: Dash, ctx: OverviewCtx): void {
  const set = (id: string, html: string): void => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
  trendMultiples(d, ctx);
  set('spKeywords', kwTable(d));
  set('spPages', pageTable(d, ctx));
}
