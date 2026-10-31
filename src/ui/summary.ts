// The Summary tab: the landing view that answers, top
// to bottom, how fresh is this · how is the site doing · better or worse · what's broken · what
// to do first · what changed · AI search · what we don't measure.
//
// Rules this file keeps (the spec's honesty constraints):
//   - every number comes from the payload; nothing is estimated or written by a model;
//   - missing renders as words (an empty state naming the action that fills it), never as 0;
//   - samples say "n of M"; thresholds are stated product rules, shown where they apply;
//   - every number carries class "n" so redact mode (?redact=1) blurs it, and charts drop their
//     numeric axes and tooltips when redacted.
import { esc, fmtNum, fmtCompact, sparkline, countDelta, axisDefaults, tooltipDefaults, monoFont, type ChartPalette, type EChartWrapper } from './lib/index.js';
import { shareText, capHealth, runLabels, categoryLabel, shortDay } from '../core/displayRules.js';
import { buildVerdict, direction } from '../core/summaryVerdict.js';
import { ago, SEV_LABEL, freshVerdict } from './panels.js';
import { cwvTile, cwvCoverage } from './cwv.js';

const fmt = fmtNum;

export interface SummaryCtx {
  wrap: (id: string, group?: string) => EChartWrapper;
  col: ChartPalette & { green: string; red: string; amber: string; grey: string; blue: string };
  shortPath: (u: string, max?: number) => string;
  safeJson: (s: string) => any;
  redacted: boolean;
  /** Jump to Issues & fixes, optionally filtered to one check or one area. */
  gotoIssues: (f: { check?: string; area?: string }) => void;
  catLabel: Record<string, string>;
}


const set = (id: string, html: string): void => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
const show = (id: string, on: boolean): void => { const el = document.getElementById(id); if (el) el.style.display = on ? '' : 'none'; };
const empty = (msg: string): string => `<div class="empty-state">${msg}</div>`;
const parseAt = (at: string | null | undefined): number => {
  if (!at) return NaN;
  if (/^\d{4}-\d{2}-\d{2}$/.test(at)) return Date.parse(`${at}T00:00:00Z`);
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(at) ? at : `${at.replace(' ', 'T')}Z`);
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (ym: string): string => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(2, 4)}`;
const dayLabel = (at: string | null | undefined): string => {
  const t = parseAt(at); if (!Number.isFinite(t)) return '-';
  const d = new Date(t); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};
const SEV_BAR: Record<string, string> = { crit: 'var(--intent-danger)', high: 'var(--intent-warning)', med: 'var(--intent-info)', low: 'var(--text-faint)', info: 'var(--text-faint)' };

/** Clicks, last 28 days vs the prior 28, each day counted once (clickWindows), else the older totals.
 *  `prior` is null when the prior 28 days aren't held: no comparison is made. */
const clicks28 = (d: any): { current: number; prior: number | null } | null =>
  d.clickWindows ? { current: d.clickWindows.current, prior: d.clickWindows.prior ?? null } : d.summary ? { current: d.summary.current.clicks, prior: d.summary.prior?.clicks ?? null } : null;

// ── Panel 0: freshness strip ──────────────────────────────────────────────────────────────────
function freshness(d: any): string {
  const src: any[] = d.freshness?.sources ?? [];
  const LABEL: Record<string, string> = { sync: 'Search Console', crawl: 'Crawl', audit: 'Audit', inspect: 'URL inspection', ranks: 'Ranks' };
  const cells: string[] = [];
  const problems: string[] = [];
  for (const kind of ['sync', 'crawl', 'audit', 'inspect', 'ranks']) {
    const s = src.find(r => r.kind === kind);
    if (!s) continue;
    let line = s.state === 'never' ? 'never' : s.state === 'running' ? 'running now' : s.state === 'completed' ? ago(s.at) : `${s.state} ${ago(s.at)}`;
    const end = d.dateRange?.rawMaxDate ?? d.coverage?.gsc?.maxDate;
    if (kind === 'sync' && s.state !== 'never' && end) line += ` · to ${dayLabel(end)}`;
    // The same verdict the sidebar shows (panels.ts freshVerdict): one rule, one dot.
    const { dot, flag, rule } = freshVerdict(d, kind, s);
    const tip = [s.detail, rule].filter(Boolean).join(' ');
    cells.push(`<div class="sf-cell" title="${esc(tip)}"><div class="sf-k"><span class="dot ${dot}"></span>${esc(LABEL[kind])}</div>` +
      `<div class="sf-v">${esc(line)}${flag ? ` <span class="sf-flag">${esc(flag)}</span>` : ''}</div></div>`);
    if (s.error) problems.push(`<div class="sf-err"><b>${esc(LABEL[kind])}:</b> ${esc(String(s.error).slice(0, 160))}</div>`);
  }
  if (!cells.length) return empty('No data sources recorded yet - run <code>refresh_property</code>.');
  const sh = d.gscShape;
  const shapeNote = sh ? `<div class="sf-warn">Search Console history holds two row shapes (${esc((sh.shapes ?? ['all-country', 'per-country']).join(' and '))} rows) on <span class="n">${fmt(sh.mixedDays)}</span> days, ${esc(dayLabel(sh.from))} to ${esc(dayLabel(sh.to))}. Every figure in the dashboard reads one shape per day (the fuller one), so each of those days counts once.</div>` : '';
  return `<div class="sf-row">${cells.join('')}</div>${problems.join('')}${shapeNote}`;
}

// ── Panel 1: verdict line ─────────────────────────────────────────────────────────────────────
function verdict(d: any): string {
  const sum = d.summary, bs = d.brandedSplit;
  const fc = d.findings;
  const lastDelta = (d.auditDeltas ?? []).filter((a: any) => a.runId === fc?.runId).pop();
  const dr = d.drift;
  const v = buildVerdict({
    clicks: sum ? clicks28(d) : null,
    nonBrand: sum && bs ? { current: bs.nonBranded.clicks, prior: bs.priorNonBrandedClicks, brand: bs.brand } : null,
    criticalOpen: fc ? (fc.byCheck ?? []).filter((b: any) => b.severity === 'crit').reduce((s: number, b: any) => s + b.count, 0) : null,
    resolvedSinceLastAudit: lastDelta && !lastDelta.skipped ? lastDelta.resolved : null,
    resolvedNote: lastDelta && !lastDelta.skipped ? lastDelta.excluded?.note ?? null : null,
    pagesChanged: dr?.counts && !dr.staleness ? dr.counts.pagesChanged : null,
  });
  if (v.empty) return empty('Nothing to summarise yet - sync Search Console (<code>sync_gsc</code>) or run a crawl and an audit.');
  const sentence = v.segments.map(s => (s.n ? `<b class="n">${esc(s.text)}</b>` : esc(s.text))).join('');
  const chipCls: Record<string, string> = { up: 'vc-up', down: 'vc-down', flat: 'vc-flat', neutral: 'vc-flat' };
  // Open critical issues read as critical, not as a neutral count.
  const cls = (c: typeof v.chips[number]): string => (c.key === 'critical' && !/^0\b/.test(c.label) ? 'vc-crit' : chipCls[c.direction]);
  const chips = v.chips.map(c => `<span class="vchip ${cls(c)}"><span class="n">${esc(c.label)}</span></span>`).join('');
  return `<p class="verdict-text" title="${esc(v.tooltip)}">${sentence}</p><div class="vchips">${chips}</div>`;
}

// ── Panel 2: the five tiles ───────────────────────────────────────────────────────────────────
interface Tile { label: string; value: string; foot?: string; sub?: string; cls?: string; title?: string }
const tile = (t: Tile): string =>
  `<div class="metric-card${t.cls ? ` ${t.cls}` : ''}"${t.title ? ` title="${esc(t.title)}"` : ''}><div class="label">${esc(t.label)}</div>` +
  `<div class="value">${t.value}</div>${t.foot ? `<div class="metric-foot">${t.foot}</div>` : ''}${t.sub ? `<div class="metric-sub">${t.sub}</div>` : ''}</div>`;

function tiles(d: any): string {
  const out: string[] = [];
  const sum = d.summary;
  if (!sum) {
    out.push(`<div class="metric-card tile-connect"><div class="label">Search Console</div><div class="connect-msg">Connect Search Console to see traffic and trends.</div><div class="metric-sub">Run <code>sync_gsc</code> for this property.</div></div>`);
  } else {
    const { current: c, prior: p } = clicks28(d)!;
    const months = (d.monthly?.months ?? []).filter((m: any) => !m.partial && m.clicks != null).map((m: any) => m.clicks);
    const yoy = d.yoy;
    let yoyTxt = '';
    if (yoy?.available) {
      const yp = direction(yoy.clicks, yoy.priorYearClicks).pct;
      yoyTxt = yp == null ? 'no clicks a year ago' : `<span class="n">${yp >= 0 ? '+' : '−'}${Math.abs(Math.round(yp))}%</span> on a year ago`;
    } else if (yoy?.reason === 'prior-year-gaps') yoyTxt = `year-on-year: the prior-year window holds ${yoy.priorYearDays} of ${yoy.currentDays} days`;
    else if (yoy) yoyTxt = 'year-on-year needs 13 months';
    out.push(tile({
      label: 'Organic clicks · 28d', value: `<span class="n">${fmtCompact(c)}</span>`,
      foot: `${p == null ? '<span class="chg flat" title="The prior 28 days are not fully held in the synced Search Console history.">no prior 28 days held</span>' : p ? `<span class="n">${countDelta(c, p)}</span>` : '<span class="chg flat">no prior clicks</span>'}${months.length >= 2 ? sparkline(months) : ''}`,
      sub: yoyTxt, title: `Last 28 days to ${d.dateRange?.maxDate ?? ''} vs the prior 28.${yoy?.available ? ` Year-on-year: the same 28 days 52 weeks earlier (${yoy.priorWindow.start} to ${yoy.priorWindow.end}).` : ''}${months.length >= 2 ? ` Sparkline: ${months.length} complete months.` : ''}`,
    }));
    const bs = d.brandedSplit;
    if (bs) {
      const tot = bs.branded.clicks + bs.nonBranded.clicks;
      const share = tot ? shareText(bs.nonBranded.clicks, tot) : null;
      out.push(tile({
        label: 'Non-brand share', value: share == null ? '–' : `<span class="n">${share}%</span>`,
        foot: bs.priorNonBrandedClicks || bs.nonBranded.clicks ? `<span class="n">${countDelta(bs.nonBranded.clicks, bs.priorNonBrandedClicks)}</span><span class="tile-note">non-brand clicks</span>` : undefined,
        sub: `of clicks · brand "${esc(bs.brand)}"${bs.uncertain ? ' <span class="brand-uncertain">uncertain (exact-match domain)</span>' : ''}`,
        title: `Non-brand = queries that don't spell "${bs.brand}" in whole words, detected from the domain (a heuristic)${bs.variants?.length ? `. Counted as brand: ${bs.variants.map((v: string) => `"${v}"`).join(', ')}` : ''}.` +
          (bs.uncertain ? ` Uncertain (exact-match domain): ${bs.uncertain.spellings.map((v: string) => `"${v}"`).join(', ')} counted as non-brand. On an exact-match domain the spaced spelling is also the generic search, so it counts as brand only when people also search the brand as one word: spaced spellings are set aside when they draw more impressions than the one-word brand and the one-word brand has earned no click.` : ''),
      }));
    } else {
      out.push(tile({ label: 'Non-brand share', value: '–', sub: 'brand not detected from the domain' }));
    }
  }

  const hs = d.healthScore;
  const hist = (d.healthHistory ?? []).filter((h: any) => h.score != null).map((h: any) => capHealth(h.score, h.errorPages));
  if (hs) {
    const tone = hs.band === 'Excellent' || hs.band === 'Good' ? 'var(--intent-success)' : hs.band === 'Fair' ? 'var(--intent-warning)' : 'var(--intent-danger)';
    const score = capHealth(hs.score, hs.errorPages);
    const capNote = hs.errorPages > 0 ? ` Never shown as 100 while any page carries a critical or high issue: ${hs.errorPages} of ${hs.totalPages} ${hs.errorPages === 1 ? 'page does' : 'pages do'}${(1 - hs.errorPages / hs.totalPages) * 100 >= 99.5 ? ', so the score is capped at 99 rather than rounded up to 100' : ''}.` : '';
    out.push(tile({
      label: 'Site health', value: `<span class="n" style="color:${tone}">${score}</span><span class="kpi-of">/100</span>`,
      foot: `<span class="tile-band" title="Bands are a product convention, not an industry benchmark">${esc(hs.band)}</span>${hist.length >= 2 && new Set(hist).size > 1 ? sparkline(hist, false, [0, 100]) : ''}`,
      // A sparkline over identical scores is a stray flat line: say "unchanged" instead.
      sub: (hs.errorPages ? `<span class="n">${fmt(hs.errorPages)}</span> ${hs.errorPages === 1 ? 'page has' : 'pages have'} a critical or high issue` : 'no page has a critical or high issue') +
        (hist.length >= 2 && new Set(hist).size === 1 ? ` · unchanged over ${hist.length} audits` : ''),
      title: `${hs.definition} ${hs.totalPages - hs.errorPages} of ${hs.totalPages} pages.${capNote} Bands (Weak under 31, Fair, Good from 71, Excellent from 91) are a product convention, not an industry benchmark.${hist.length >= 2 ? ` Sparkline: ${hist.length} audits.` : ''}`,
    }));
  } else {
    out.push(tile({ label: 'Site health', value: '–', sub: (d.coverage?.crawlPages ?? 0) > 0 ? 'run <code>run_audit</code>' : 'run a crawl, then <code>run_audit</code>' }));
  }

  const ic = d.indexCoverage;
  out.push(ic
    ? tile({ label: 'Indexed', value: `<span class="n">${fmt(ic.indexed)}</span><span class="kpi-of"> of <span class="n">${fmt(ic.total)}</span></span>`, sub: 'inspected URLs (a sample)', title: 'From URL Inspection, which is quota-bound: a sample of URLs, never a share of the whole site.' })
    : tile({ label: 'Indexed', value: '–', sub: 'run <code>inspect_urls</code>' }));

  out.push(cwvTile(d));

  const ar = d.agentReadiness;
  out.push(ar
    ? tile({ label: 'AI readiness', value: `<span class="n">${ar.score}</span><span class="kpi-of">/100</span>`, foot: `<span class="tile-band">${esc(ar.level)}</span>`, sub: `checked ${esc(ago(ar.checkedAt))}`, title: 'Agent-readiness probe (check_agent_readiness): the share of discoverability, content, bot-access and capability checks the site passes. One stored result, so no trend yet.' })
    : tile({ label: 'AI readiness', value: '–', sub: 'run <code>check_agent_readiness</code>' }));
  return out.join('');
}

// ── Panel 3a: 16-month trend with event ticks ─────────────────────────────────────────────────
function trend(d: any, ctx: SummaryCtx): void {
  const m = d.monthly;
  const { col } = ctx;
  if (!m?.months?.length) {
    show('sumTrendLegend', false);
    set('sumTrendNote', d.summary ? '' : 'Connect Search Console (<code>sync_gsc</code>) to see up to 16 months of clicks.');
    set('sumTrendSrc', '');
    ctx.wrap('sumTrendChart').setEmpty(d.summary ? 'No monthly data yet' : 'No Search Console data', col);
    return;
  }
  show('sumTrendLegend', true);
  const months: any[] = m.months;
  const byMonth = new Map(months.map(mm => [mm.month, mm]));
  const yoyOk = d.yoy?.available === true;
  const ghost = months.map(mm => {
    if (!yoyOk) return null;
    const [y, mo] = mm.month.split('-').map(Number);
    const prev = byMonth.get(`${y - 1}-${String(mo).padStart(2, '0')}`) as any;
    return prev && !prev.partial && prev.clicks != null && !mm.partial && mm.clicks != null ? prev.clicks : null;
  });
  const anyGhost = ghost.some(g => g != null);
  const idx = new Map(months.map((mm, i) => [mm.month, i]));
  const events: any[] = (d.events ?? []).filter((e: any) => idx.has(e.at.slice(0, 7)));
  // One marker per month and kind (crawls left of the month centre, audits right), with a count
  // when a month had several: day-precise ticks stacked into one smudge at busy months.
  const perMonth = (kind: 'crawl' | 'audit'): [number, number, number][] => {
    const n = new Map<number, number>();
    for (const e of events) if (e.kind === kind) { const i = idx.get(e.at.slice(0, 7))!; n.set(i, (n.get(i) ?? 0) + 1); }
    // Two lanes (crawls above, audits below), so the two kinds' counts never sit side by side.
    return [...n.entries()].map(([i, c]) => [i, kind === 'crawl' ? 1.5 : 0.5, c]);
  };
  const ax = axisDefaults(col, { numeric: true });
  const evColor = { crawl: col.categorical[0], audit: col.categorical[1] } as const;
  ctx.wrap('sumTrendChart').setOption({
    aria: { enabled: true },
    animation: false,
    tooltip: ctx.redacted ? { show: false } : {
      ...tooltipDefaults(col), trigger: 'axis', axisPointer: { type: 'shadow' },
      formatter: (ps: any[]) => {
        const p = ps.find(q => q.seriesName === 'Clicks') ?? ps[0];
        const mm = months[p.dataIndex];
        if (!mm) return '';
        const g = ghost[p.dataIndex];
        return `${monthLabel(mm.month)}<br/>${mm.clicks == null ? 'no Search Console data' : `${fmt(mm.clicks)} clicks`}` +
          `${mm.partial && mm.clicks != null ? ` · partial (${mm.days} of ${mm.daysInMonth} days)` : ''}${g != null ? `<br/>same month last year ${fmt(g)}` : ''}`;
      },
    },
    grid: [{ left: 44, right: 10, top: 12, bottom: 66 }, { left: 44, right: 10, height: 26, bottom: 10 }],
    xAxis: [
      { type: 'category', gridIndex: 0, data: months.map(mm => monthLabel(mm.month)), axisTick: { show: false }, axisLine: { lineStyle: { color: col.border } }, axisLabel: { color: col.axisText, fontSize: 10.5, fontFamily: monoFont(), hideOverlap: true } },
      { type: 'value', gridIndex: 1, min: -0.5, max: months.length - 0.5, show: false },
    ],
    yAxis: [
      { type: 'value', gridIndex: 0, ...ax, axisLabel: { ...ax.axisLabel, show: !ctx.redacted }, axisLine: { show: false }, splitNumber: 3 },
      { type: 'value', gridIndex: 1, min: 0, max: 2, show: false },
    ],
    series: [
      {
        name: 'Clicks', type: 'bar', xAxisIndex: 0, yAxisIndex: 0, barMaxWidth: 28,
        data: months.map(mm => mm.clicks == null ? null : {
          value: mm.clicks,
          itemStyle: mm.partial
            ? { color: 'transparent', borderColor: col.accent, borderWidth: 1.5, borderType: 'dashed', borderRadius: [3, 3, 0, 0] }
            : { color: col.accent, borderRadius: [3, 3, 0, 0] },
        }),
      },
      ...(anyGhost ? [{
        name: 'Same month last year', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: ghost, connectNulls: false,
        symbol: 'circle', symbolSize: 4, lineStyle: { type: 'dashed', width: 1.5, color: col.text, opacity: 0.5 }, itemStyle: { color: col.text, opacity: 0.5 }, z: 3,
      }] : []),
      ...(['crawl', 'audit'] as const).map(k => ({
        name: k === 'crawl' ? 'Crawl' : 'Audit', type: 'scatter', xAxisIndex: 1, yAxisIndex: 1, symbol: 'rect', symbolSize: [3, 9],
        itemStyle: { color: evColor[k] }, tooltip: { show: false }, silent: true,
        // "2×" to the right of a tick when a month had several, in that kind's own lane.
        label: { show: true, position: 'right', distance: 3, fontSize: 9, fontFamily: monoFont(), color: evColor[k], formatter: (p: any) => (p.value[2] > 1 ? `${p.value[2]}×` : '') },
        data: perMonth(k),
      })),
    ],
  });
  const complete = months.filter(mm => !mm.partial && mm.clicks != null);
  const partial = months.filter(mm => mm.partial && mm.clicks != null);
  const nulls = months.filter(mm => mm.clicks == null);
  set('sumTrendLegend',
    `<span><i class="lg-bar"></i>Clicks</span><span><i class="lg-hollow"></i>Partial month</span>` +
    (anyGhost ? '<span><i class="lg-dash"></i>Same month last year</span>' : '') +
    `<span><i class="lg-tick" style="background:${evColor.crawl}"></i>Crawl</span><span><i class="lg-tick" style="background:${evColor.audit}"></i>Audit</span>`);
  const notes: string[] = [];
  if (!yoyOk) notes.push(`Same month last year needs 13 months of Search Console; this property holds <span class="n">${m.monthsHeld}</span>.`);
  if (m.truncated) notes.push(`The last <span class="n">${m.truncated.shownMonths}</span> of <span class="n">${m.truncated.monthsHeld}</span> months held.`);
  if (nulls.length) notes.push(`<span class="n">${nulls.length}</span> month${nulls.length > 1 ? 's have' : ' has'} no Search Console rows (no bar, not zero).`);
  if (partial.length) notes.push('A hollow bar is a partial month, never compared as complete.');
  set('sumTrendNote', notes.join(' '));
  set('sumTrendSrc', `GSC · ${months.length} months`);
  const s = document.getElementById('sumTrendSummary');
  if (s) s.textContent = `Monthly organic clicks for ${months.length} months; ${complete.length} complete, ${partial.length} partial.` +
    (complete.length && !ctx.redacted ? ` Latest complete month ${monthLabel(complete[complete.length - 1].month)}: ${fmt(complete[complete.length - 1].clicks)} clicks.` : '');
}

// ── Panel 3b: health per audit + opened / resolved ────────────────────────────────────────────
const SKIP_LABEL: Record<string, string> = {
  'different-scope': 'different audit scope', 'check-set-changed': 'the check set changed', 'check-set-unknown': 'check set not recorded',
};
function health(d: any, ctx: SummaryCtx): void {
  const { col } = ctx;
  const histAll: any[] = d.healthHistory ?? [];
  const deltas: any[] = d.auditDeltas ?? [];
  const MAX = 12;
  // The same cap as the tile: never 100 while a page carries a critical or high issue.
  const hist = histAll.slice(-MAX).map(h => ({ ...h, score: h.score == null ? null : capHealth(h.score, h.errorPages) }));
  if (!hist.length) {
    ctx.wrap('sumHealthChart').setEmpty((d.coverage?.crawlPages ?? 0) > 0 ? 'No audit yet - run run_audit' : 'Run a crawl, then run_audit', col);
    set('sumHealthNotes', ''); set('sumHealthSrc', '');
    return;
  }
  const byRun = new Map(deltas.map(a => [a.runId, a]));
  // Same-day runs get their time ("17 Oct 16:20", "17 Oct 16:21"), never two identical labels.
  const labels = runLabels(hist.map(h => h.at));
  const comparable = hist.map(h => { const a = byRun.get(h.runId); return a && !a.skipped ? a : null; });
  const nComparable = comparable.filter(Boolean).length;
  // The opened / resolved panel only when there is something to draw: no comparable pair, or
  // pairs that changed nothing, would be an empty 0-1 axis. The note says which instead.
  const bars = comparable.some(a => a && (a.opened || a.resolved));
  const chartEl = document.getElementById('sumHealthChart');
  chartEl?.classList.toggle('chart-health-only', !bars);
  const ax = axisDefaults(col);
  const xLabel = { color: col.axisText, fontSize: 10, fontFamily: monoFont(), hideOverlap: true };
  ctx.wrap('sumHealthChart').setOption({
    aria: { enabled: true }, animation: false,
    tooltip: ctx.redacted ? { show: false } : {
      ...tooltipDefaults(col), trigger: 'axis',
      formatter: (ps: any[]) => {
        const i = ps[0].dataIndex, h = hist[i], a = byRun.get(h.runId);
        const hs = h.score == null ? `health not computable (${String(h.basis ?? '').replace(/^none:/, '') || 'no basis'})` : `health ${h.score}/100`;
        const dl = !a ? 'first audit shown' : a.skipped ? `not compared: ${SKIP_LABEL[a.skipped] ?? a.skipped}`
          : `${fmt(a.opened)} opened · ${fmt(a.resolved)} resolved · ${fmt(a.carried)} carried${a.excluded ? `<br/>${esc(a.excluded.note)}` : ''}`;
        return `${labels[i]}<br/>${hs}<br/>${dl}`;
      },
    },
    legend: { top: 0, right: 0, itemWidth: 10, itemHeight: 8, textStyle: { color: col.text, fontSize: 11 }, data: bars ? ['Health', 'Opened', 'Resolved'] : ['Health'] },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    // Fixed pixel heights: the axis titles keep a constant gap at any chart height.
    grid: bars ? [{ left: 34, right: 10, top: 46, height: 64 }, { left: 34, right: 10, top: 152, bottom: 24 }] : [{ left: 34, right: 10, top: 46, bottom: 26 }],
    xAxis: [
      { type: 'category', gridIndex: 0, data: labels, axisTick: { show: false }, axisLine: { lineStyle: { color: col.border } }, axisLabel: bars ? { show: false } : xLabel },
      ...(bars ? [{ type: 'category', gridIndex: 1, data: labels, axisTick: { show: false }, axisLine: { lineStyle: { color: col.border } }, axisLabel: xLabel }] : []),
    ],
    yAxis: [
      { type: 'value', gridIndex: 0, min: 0, max: 100, splitNumber: 2, name: 'health /100', nameGap: 14, nameTextStyle: { ...ax.nameTextStyle, align: 'left', fontSize: 10, padding: [0, 0, 0, -30] }, ...{ axisLabel: { ...ax.axisLabel, show: !ctx.redacted }, axisLine: { show: false }, splitLine: ax.splitLine } },
      ...(bars ? [{ type: 'value', gridIndex: 1, splitNumber: 2, minInterval: 1, name: 'issues', nameGap: 14, nameTextStyle: { ...ax.nameTextStyle, align: 'left', fontSize: 10, padding: [0, 0, 0, -30] }, ...{ axisLabel: { ...ax.axisLabel, show: !ctx.redacted }, axisLine: { show: false }, splitLine: ax.splitLine } }] : []),
    ],
    series: [
      { name: 'Health', type: 'line', step: 'end', xAxisIndex: 0, yAxisIndex: 0, connectNulls: false, data: hist.map(h => h.score), symbol: 'circle', symbolSize: 5, lineStyle: { width: 1.75, color: col.accent }, itemStyle: { color: col.accent } },
      ...(bars ? [
        { name: 'Opened', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, barMaxWidth: 10, data: comparable.map(a => a ? a.opened : null), itemStyle: { color: col.amber, borderRadius: [2, 2, 0, 0] } },
        { name: 'Resolved', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, barMaxWidth: 10, data: comparable.map(a => a ? a.resolved : null), itemStyle: { color: col.green, borderRadius: [2, 2, 0, 0] } },
      ] : []),
    ],
  });
  const notes: string[] = ['Only audits with the same scope and check set are compared.'];
  const skipped = hist.map(h => byRun.get(h.runId)).filter((a: any) => a?.skipped && !String(a.skipped).startsWith('run-'));
  if (skipped.length) notes.push(`Not compared: ${skipped.map((a: any) => `${dayLabel(a.at)} (${SKIP_LABEL[a.skipped] ?? a.skipped})`).join(', ')}.`);
  // A check whose findings were regrouped between two audits is left out of that pair's bars.
  const regrouped = hist.map(h => byRun.get(h.runId)).filter((a: any) => a && !a.skipped && a.excluded);
  if (regrouped.length) notes.push(`${regrouped.map((a: any) => `${dayLabel(a.at)}: ${esc(a.excluded.note)}`).join('; ')} (they were re-keyed, not opened or resolved).`);
  const failed = deltas.filter(a => String(a.skipped ?? '').startsWith('run-'));
  if (failed.length) notes.push(`<span class="n">${failed.length}</span> audit${failed.length > 1 ? 's' : ''} didn't complete and ${failed.length > 1 ? 'are' : 'is'} stepped over.`);
  const nullScores = hist.filter(h => h.score == null).length;
  if (nullScores) notes.push(`<span class="n">${nullScores}</span> past audit${nullScores > 1 ? 's have' : ' has'} no score: the page set couldn't be rebuilt from crawl snapshots, so it isn't estimated.`);
  if (nComparable === 0) notes.push(hist.length < 2 ? 'Opened vs resolved needs two comparable audits.' : 'No comparable pair yet, so no opened / resolved bars.');
  else if (!bars) {
    const carried = comparable.filter(Boolean).reduce((n: number, a: any) => n + (a.carried ?? 0), 0);
    notes.push(`No issue opened or resolved between the ${nComparable === 1 ? 'two comparable audits' : `${nComparable + 1} comparable audits`}${carried ? ` (<span class="n">${fmt(carried)}</span> carried over)` : ''}, so there are no bars to draw.`);
  }
  if (histAll.length > MAX || d.auditHistoryTruncated) notes.push(`The last <span class="n">${hist.length}</span> of <span class="n">${d.auditHistoryTruncated?.totalRuns ?? histAll.length}</span> audits.`);
  set('sumHealthNotes', `<div class="sum-note">${notes.join(' ')}</div>`);
  set('sumHealthSrc', `Audit · ${hist.length} run${hist.length > 1 ? 's' : ''}`);
  const s = document.getElementById('sumHealthSummary');
  const last = hist[hist.length - 1];
  if (s) s.textContent = `Health score over ${hist.length} audits; latest ${last.score == null ? 'not computable' : `${last.score} out of 100`}. ${nComparable} comparable audit pairs.`;
}

// ── Panel 4: what's broken, by area ───────────────────────────────────────────────────────────
function areas(d: any, ctx: SummaryCtx): string {
  const fc = d.findings;
  if (!fc) return empty((d.coverage?.crawlPages ?? 0) > 0 ? 'No audit yet - run <code>run_audit</code>.' : 'No crawl yet - run <code>start_crawl</code>, then <code>run_audit</code>.');
  const rows: any[] = fc.byCategory ?? [];
  if (!rows.length) return empty('The latest audit found nothing to fix.');
  const LBL: Record<string, string> = { ...ctx.catLabel, merged: 'Search demand' };
  const cnt = (v: number, sev: string): string => `<span class="cnt${v ? ` cnt-${sev}` : ' cnt-zero'}"><span class="n">${v}</span></span>`;
  const anyCompared = rows.some(r => r.opened != null);
  const lastDelta = (d.auditDeltas ?? []).filter((a: any) => a.runId === fc.runId).pop();
  const excludedNote: string | null = lastDelta && !lastDelta.skipped ? lastDelta.excluded?.note ?? null : null;
  const body = rows.map(r => {
    const pages = `${r.capped ? '≥' : ''}<span class="n">${fmt(r.pages)}</span>${r.site ? ' <span class="site-tag" title="Plus site-wide findings">+ site</span>' : ''}`;
    // Only non-zero changes carry a sign; no change at all reads as a muted "no change".
    const since = r.opened == null ? '<span class="cell-null" title="No comparable previous audit">–</span>'
      : !r.opened && !r.resolved ? '<span class="cell-null" title="No change since the last audit">0</span>'
      : `<span title="${fmt(r.opened)} opened, ${fmt(r.resolved)} resolved">` +
        (r.opened ? `<span class="since-o"><span class="n">+${fmt(r.opened)}</span></span>` : '') +
        (r.opened && r.resolved ? ' ' : '') +
        (r.resolved ? `<span class="since-r"><span class="n">−${fmt(r.resolved)}</span></span>` : '') + '</span>';
    // Checks regrouped between the two audits are left out of the change (and of the verdict's count).
    const regroupedTag = r.regrouped?.length && r.opened != null
      ? ` <span class="site-tag" title="${esc(`${r.regrouped.join(', ')}: ${excludedNote ?? 'findings regrouped; not counted'}`)}">regrouped</span>` : '';
    return `<tr class="area-link" data-area="${esc(r.category)}" tabindex="0" role="button" title="Show these issues"><td>${esc(categoryLabel(r.category, LBL))}</td><td class="num">${pages}</td>` +
      `<td class="num sevs">${cnt(r.crit, 'crit')}${cnt(r.high, 'high')}${cnt(r.med, 'med')}${cnt(r.low, 'low')}</td><td class="num">${since}${regroupedTag}</td></tr>`;
  }).join('');
  const judgement = rows.reduce((s, r) => s + (r.judgement || 0), 0);
  const notes: string[] = ['C / H / M / L: pages (or the site) with a critical, high, medium or low issue.'];
  if (judgement) notes.push(`Includes <span class="n">${fmt(judgement)}</span> judgement findings (the audit ran with <code>includeJudgement</code>).`);
  if (rows.some(r => r.capped)) notes.push('≥: a check hit the 500-findings storage cap, so the count is a floor.');
  if (!d.summary && !rows.some(r => r.category === 'merged')) notes.push('Search-demand checks need Search Console, so they did not run.');
  notes.push(anyCompared ? 'Change: issues opened (+) and resolved (−) since the last comparable audit.' : 'Change needs two comparable audits.');
  if (anyCompared && excludedNote) notes.push(`${esc(excludedNote.charAt(0).toUpperCase() + excludedNote.slice(1))} (${esc(lastDelta.excluded.checkIds.join(', '))}).`);
  return `<div class="findings-table areas-table"><table><thead><tr><th>Area</th><th class="num">Pages</th>` +
    `<th class="num sevs"><span class="sev-h" title="Critical">C</span><span class="sev-h" title="High">H</span><span class="sev-h" title="Medium">M</span><span class="sev-h" title="Low and info">L</span></th>` +
    `<th class="num" title="Opened (+) and resolved (−) since the last comparable audit">Change</th></tr></thead><tbody>${body}</tbody></table></div>` +
    `<div class="sum-note">${notes.join(' ')}</div>`;
}

/** The finding's evidence labels as a chip: D deterministic, N judgement, G from Search Console data. */
const evidenceLabel = (labels: string[]): string => { const l = labels.filter(x => ['D', 'N', 'G'].includes(x)); return l.length ? l.join('·') : 'D'; };
const evidenceTitle = (labels: string[]): string => [
  labels.includes('N') ? 'N: judgement, verify before acting' : 'deterministic: backed by the crawled bytes or stored rows',
  labels.includes('G') ? 'G: built from Search Console data' : '',
].filter(Boolean).join('; ');

// ── Panel 5: do this first ────────────────────────────────────────────────────────────────────
function actions(d: any, ctx: SummaryCtx): string {
  const fc = d.findings;
  if (!fc?.top?.length) return empty(fc ? 'The latest audit found nothing to fix.' : 'No audit yet - run <code>run_audit</code> to rank the fixes.');
  const seen = new Set<string>(); const top: any[] = [];
  for (const f of fc.top) { if (top.length >= 5) break; if (seen.has(f.check_id)) continue; seen.add(f.check_id); top.push(f); }
  const byCheck = new Map((fc.byCheck ?? []).map((b: any) => [b.check_id, b]));
  const maxImpact = Math.max(...top.map(f => Number(f.impact) || 0), 1);
  return `<ol class="do-first">${top.map((f, i) => {
    const rec = ctx.safeJson(f.recommendation);
    const b: any = byCheck.get(f.check_id) ?? {};
    const pages = b.urls ?? 0;
    const labels: string[] = (() => { try { return JSON.parse(f.labels || '[]'); } catch { return []; } })();
    const judgement = labels.includes('N');
    const w = Math.max(4, Math.round(((Number(f.impact) || 0) / maxImpact) * 100));
    const sz = String(f.size ?? '');
    const risk = b.clicksAtRisk != null && d.summary
      ? ` · <span class="n">${fmt(b.clicksAtRisk)}</span> clicks (28d) on affected pages` : '';
    return `<li class="df-row" data-check="${esc(f.check_id)}" tabindex="0" role="button" title="Show this check's findings">` +
      `<span class="df-n">${i + 1}</span><div class="df-main"><div class="df-title" title="${esc(rec.title || f.check_id)}">${esc(rec.title || f.check_id)}</div>` +
      `<div class="df-sub">${pages ? `<span class="n">${fmt(pages)}</span> ${pages === 1 ? 'page' : 'pages'}` : 'site-wide'}${risk}</div></div>` +
      `<span class="df-chips"><span class="impact impact-${(sz || 's').toLowerCase()}" title="Impact band ${esc(sz)}: XL 50-100, L 20-49, M 5-19, S under 5">${esc(sz)}</span>` +
      `<span class="tag-badge ${judgement ? 'tag-warning' : 'tag-neutral'}" title="${esc(evidenceTitle(labels))}">${esc(evidenceLabel(labels))}</span></span>` +
      `<span class="df-impact" title="Impact ${f.impact ?? ''} of 100 (relative to this audit's top finding); bar colour = ${esc(SEV_LABEL[f.severity] ?? f.severity)} severity">` +
      `<b class="n">${f.impact ?? '–'}</b><span class="ti-bar df-bar"><span style="width:${w}%;background:${SEV_BAR[f.severity] ?? SEV_BAR.low}"></span></span></span></li>`;
  }).join('')}</ol>` +
    `<div class="df-key"><span><b>Impact</b> 0-100 vs this audit's top finding; bar colour = severity</span>` +
    `<span><b>XL / L / M / S</b> impact band</span><span><b>D</b> deterministic · <b>N</b> judgement · <b>G</b> uses Search Console data</span></div>` +
    `<div class="sum-note">Ranked by impact for the effort (clicks at stake × yield × certainty ÷ hours). Clicks are what the affected pages earn now, not a forecast.</div>`;
}

// ── Panel 6: changed since last crawl ─────────────────────────────────────────────────────────
function drift(d: any, ctx: SummaryCtx): string {
  const dr = d.drift;
  if (!dr || dr.snapshots === 0) return empty('No crawl yet - run <code>start_crawl</code>.');
  if (dr.staleness) return `<div class="sum-banner">This comparison isn't current: a newer crawl (${esc(dayLabel(dr.staleness.newestCrawlAt))}) has no snapshot. Run <code>run_audit</code> to snapshot it.</div>`;
  if (!dr.counts) return empty('Needs two crawls to show change. Crawl again on another day.');
  const c = dr.counts;
  const rows = [
    { k: 'Pages now erroring', v: c.nowErroring, dot: 'dot-crit' },
    { k: 'Noindex added', v: c.noindexAdded, dot: 'dot-crit' },
    { k: 'Canonical changed', v: c.canonicalChanged, dot: 'dot-high' },
    { k: 'Title changed', v: c.titleChanged, dot: 'dot-med' },
    { k: 'Pages no longer reached', v: c.removed, dot: 'dot-high' },
    { k: 'New pages', v: c.added, dot: 'dot-low' },
  ];
  const top = (dr.top ?? []).slice(0, 3).map((t: any) =>
    `<li><span class="dot dot-${t.severity === 'info' ? 'low' : t.severity}"></span><span class="url" title="${esc(t.urlKey)}">${esc(ctx.shortPath(t.urlKey, 30))}</span><span class="dr-f">${esc(t.kind === 'modified' ? t.fields.join(', ').replace(/_/g, ' ') : t.kind === 'added' ? 'new page' : 'not reached')}</span></li>`).join('');
  return `<div class="dr-rows">${rows.map(r => `<div class="dr-row"><span class="dot ${r.dot}"></span><span>${r.k}</span><b class="n">${fmt(r.v)}</b></div>`).join('')}</div>` +
    (top ? `<div class="dr-top-h">Most severe of <span class="n">${fmt(dr.total)}</span> changed</div><ul class="dr-top">${top}</ul>` : '<div class="sum-note">No changes between the two crawls.</div>') +
    `<div class="sum-note">Crawls of ${esc(dayLabel(dr.baselineAt))} and ${esc(dayLabel(dr.currentAt))}. The full diff: <code>detect_changes</code>.</div>`;
}

// ── Panel 7a: ranking mix (now vs prior 28 days) ──────────────────────────────────────────────
function rankingMix(d: any): string {
  const dist: any[] = d.rankingDistribution ?? [];
  if (!d.summary) return empty('Connect Search Console to see the ranking mix.');
  if (dist.length < 28) return empty('Needs 28 days of Search Console data.');
  const sumOf = (rows: any[]): number[] => ['b1', 'b2', 'b3', 'b4'].map(k => rows.reduce((s, r) => s + (r[k] || 0), 0));
  const cur = sumOf(dist.slice(-28));
  const prior = dist.length >= 56 ? sumOf(dist.slice(-56, -28)) : null;
  const B = [
    { k: 'Pos 1-3', c: 'var(--chart-categorical-3)' }, { k: 'Pos 4-10', c: 'var(--chart-categorical-1)' },
    { k: 'Pos 11-20', c: 'var(--chart-categorical-2)' }, { k: 'Pos 21+', c: 'var(--chart-context)' },
  ];
  const tot = (v: number[]): number => v.reduce((a, b) => a + b, 0);
  const pct = (v: number[], i: number): string => shareText(v[i], tot(v));
  const bar = (v: number[]): string => `<div class="mix">${v.map((x, i) => (x ? `<span style="flex:${x};background:${B[i].c}" title="${B[i].k}: ${pct(v, i)}%"></span>` : '')).join('')}</div>`;
  const top10 = (v: number[]): string => shareText(v[0] + v[1], tot(v));
  return `<div class="mix-row"><span class="mix-lbl">Last 28 days</span><span class="mix-val"><span class="n">${top10(cur)}%</span> in the top 10</span></div>${bar(cur)}` +
    (prior ? `<div class="mix-row"><span class="mix-lbl">Prior 28 days</span><span class="mix-val"><span class="n">${top10(prior)}%</span> in the top 10</span></div>${bar(prior)}` : '<div class="sum-note">The prior 28 days aren\'t held yet.</div>') +
    `<div class="mix-legend">${B.map((b, i) => `<span><span class="dot" style="background:${b.c}"></span>${b.k} <b class="n">${pct(cur, i)}%</b></span>`).join('')}</div>` +
    `<div class="sum-note">Share of impressions by Search Console average position, not a live SERP check.</div>`;
}

// ── Panel 7b: gaining and losing pages ────────────────────────────────────────────────────────
function movers(d: any, ctx: SummaryCtx): string {
  const pm = d.pageMovers;
  if (!d.summary || !pm) return empty('Connect Search Console to see gaining and losing pages.');
  const list = (rows: any[], up: boolean): string => rows.length
    ? rows.map(r => `<li><span class="url" title="${esc(r.urlKey)}">${esc(ctx.shortPath(r.urlKey, 30))}</span><b class="n ${up ? 'mv-up' : 'mv-down'}">${up ? '+' : '−'}${fmt(Math.abs(r.change))}</b></li>`).join('')
    : '<li class="mv-none">none</li>';
  return `<div class="mv-h">Gaining</div><ul class="mv">${list(pm.gaining, true)}</ul><div class="mv-h">Losing</div><ul class="mv">${list(pm.losing, false)}</ul>` +
    `<div class="sum-note">Change in clicks, last 28 days vs the prior 28, across <span class="n">${fmt(pm.eligible)}</span> pages with at least ${pm.minPriorClicks} clicks in the prior 28 (so 1 to 3 clicks isn't +200%).</div>`;
}

// ── Panel 8: AI search ────────────────────────────────────────────────────────────────────────
/** The AI search signals: agent readiness, AI-bot access in robots.txt, AI Overview presence.
 * Shown on the Summary and on the AI visibility tab. */
export function aiSignalsHtml(d: any): string {
  const ar = d.agentReadiness;
  const readiness = ar
    ? `<div class="ai-score"><span class="n">${ar.score}</span><span class="kpi-of">/100</span><span class="ai-level">${esc(ar.level)}</span></div>` +
      `<div class="stat-rows">${(ar.byCategory ?? []).map((c: any) => {
        const p = c.total ? Math.round((c.passed / c.total) * 100) : 0;
        return `<div class="stat-row"><div class="sr-top"><span>${esc(c.category)}</span><span><b class="n">${c.passed}</b><em class="n">of ${c.total}</em></span></div><div class="stat-track"><span style="width:${p}%;background:var(--accent)"></span></div></div>`;
      }).join('')}</div><div class="sum-note">Checked ${esc(ago(ar.checkedAt))}.</div>`
    : empty('Run <code>check_agent_readiness</code> to score how ready the site is for AI agents.');

  let botsHtml: string;
  const bots: any[] | null = ar?.bots ?? null;
  if (!ar) botsHtml = empty('Run <code>check_agent_readiness</code> to read the AI-bot rules in robots.txt.');
  else if (!bots) botsHtml = empty('Per-bot access needs a fresh <code>check_agent_readiness</code> (this result predates it), or the site has no robots.txt.');
  else {
    const pill = (b: any): string => {
      const blocked = b.verdict === 'blocked' || (b.verdict === 'not-stated' && b.inherits === 'blocked');
      const cls = blocked ? (b.group === 'search' ? 'bp-bad' : 'bp-muted') : 'bp-ok';
      const txt = b.verdict === 'not-stated' ? `${b.inherits}*` : b.verdict;
      return `<li title="${esc(`${b.operator}: ${b.bot}${b.verdict === 'not-stated' ? ' is not named in robots.txt, so the * group applies' : ''}`)}"><span class="bot">${esc(b.bot)}</span><span class="bp ${cls}">${esc(txt)}</span></li>`;
    };
    botsHtml = `<div class="bots"><div><div class="bots-h">Search and citation</div><ul>${bots.filter(b => b.group === 'search').map(pill).join('')}</ul></div>` +
      `<div><div class="bots-h">Training</div><ul>${bots.filter(b => b.group === 'training').map(pill).join('')}</ul></div></div>` +
      `<div class="sum-note">robots.txt rules for the site root (* = not named, so the default group applies). Blocking a training crawler doesn't remove the site from AI search answers; blocking a search one does.</div>`;
  }

  const ao = d.aiOverview;
  const fp = d.serpFootprint?.features?.find((f: any) => f.feature === 'ai_overview');
  const aio: string[] = [];
  if (ao) {
    aio.push(`<p class="ai-line"><span class="n">${fmt(ao.present)}</span> of <span class="n">${fmt(ao.checked)}</span> checked queries show an AI Overview; it cites the site on <span class="n">${fmt(ao.cited)}</span>` +
      `${ao.unknown ? `, and <span class="n">${fmt(ao.unknown)}</span> ${ao.unknown === 1 ? 'is' : 'are'} unknown (the citations didn't load)` : ''}.</p>` +
      `<div class="sum-note">Content-recon queries only, checked ${esc(ago(ao.checkedAt))}.</div>`);
  } else aio.push(empty('No queries checked yet. <code>recon_targets</code> reads the AI Overview for your losing pages.'));
  if (fp) aio.push(`<p class="ai-line">AI Overviews appear on <span class="n">${fp.volumeSharePct}%</span> of sampled search volume (top <span class="n">${fmt(d.serpFootprint.sampleKeywords)}</span> keywords).</p>`);
  aio.push('<div class="not-measured">Mentions in AI Overviews and ChatGPT come from DataForSEO, on the AI visibility tab. Perplexity, Gemini and AI Mode: <b>not measured</b>.</div>');

  return `<div class="ai-grid"><div><h4>Agent readiness</h4>${readiness}</div><div><h4>AI bots in robots.txt</h4>${botsHtml}</div><div><h4>AI Overviews</h4>${aio.join('')}</div></div>`;
}

// ── Panel 9: data coverage footer ─────────────────────────────────────────────────────────────
function coverageFooter(d: any): string {
  const cv = d.coverage;
  if (!cv) return '';
  const chip = (on: boolean, k: string, v: string, title = ''): string =>
    `<span class="cov-chip${on ? '' : ' cov-off'}"${title ? ` title="${esc(title)}"` : ''}><span class="dot ${on ? 'dot-ok' : 'dot-never'}"></span><span class="cov-k">${k}</span> ${v}</span>`;
  const chips = [
    chip(!!cv.gsc, 'Search Console', cv.gsc ? `<span class="n">${cv.gsc.months}</span> months` : 'none', cv.gsc ? `${cv.gsc.minDate} to ${cv.gsc.maxDate}` : 'Run sync_gsc'),
    // Device / country rows: only a segments:true sync writes them, so they can stop while the totals go on.
    ...(d.segmentsLastDate === undefined || !cv.gsc ? [] : [(() => {
      const last: string | null = d.segmentsLastDate;
      const inWindow = !!last && (!d.breakdownWindowStart || last >= d.breakdownWindowStart);
      return chip(inWindow, 'Device & country', last ? `to ${esc(shortDay(last))}` : 'not synced',
        !last ? 'Run sync_gsc with segments:true to add device and country breakdowns.'
          : inWindow ? `Segment rows to ${last}.` : `No device or country rows in the last 28 days: the last segment sync covered up to ${last}. Run sync_gsc with segments:true to refresh.`);
    })()]),
    chip(cv.crawlPages > 0, 'Crawl', cv.crawlPages ? `<span class="n">${fmt(cv.crawlPages)}</span> pages` : 'none'),
    chip(cv.inspected > 0, 'URL inspection', !cv.inspected ? 'none' : cv.inspectedIndexable == null ? `<span class="n">${fmt(cv.inspected)}</span> URLs (a sample)`
      : `<span class="n">${fmt(cv.inspectedIndexable)}</span> of <span class="n">${fmt(cv.indexablePages)}</span> indexable pages`,
      `A quota-bound sample: ${cv.inspected} URLs inspected in all, ${cv.inspectedIndexable ?? 0} of them indexable crawled pages.`),
    chip(cv.cwvPages > 0, 'Lab CWV', cv.cwvPages ? `<span class="n">${fmt(cv.cwvPages)}</span> pages` : 'none', 'Lighthouse lab data (page_lighthouse), not field data.'),
    chip(cv.backlinkPages > 0, 'Backlinks', cv.backlinkPages ? `<span class="n">${fmt(cv.backlinkPages)}</span> pages` : (d.apiKeys && !d.apiKeys.dataforseo ? 'no DataForSEO key' : 'none')),
    // Derived from the payload (cwvField), never hard-coded.
    ((c) => chip(c.on, 'Field CWV', c.value, c.title))(cwvCoverage(d)),
    chip(false, 'Server logs', 'not collected', 'Log analysis is out of scope.'),
  ];
  return `<span class="cov-title">Data coverage</span>${chips.join('')}`;
}

export function renderSummary(d: any, ctx: SummaryCtx): void {
  set('sumFresh', freshness(d));
  set('sumVerdict', verdict(d));
  set('sumTiles', tiles(d));
  trend(d, ctx);
  health(d, ctx);
  set('sumAreas', areas(d, ctx));
  set('sumAreasSrc', d.findings?.finishedAt ? `Audit · ${ago(d.findings.finishedAt)}` : 'Audit');
  set('sumActions', actions(d, ctx));
  set('sumDrift', drift(d, ctx));
  set('sumMix', rankingMix(d));
  set('sumMovers', movers(d, ctx));
  set('sumAi', aiSignalsHtml(d));
  set('sumCoverage', coverageFooter(d));
  // Traceability: an area row or an action opens Issues & fixes filtered to it.
  const bind = (sel: string, fn: (el: HTMLElement) => void): void => document.querySelectorAll<HTMLElement>(sel).forEach(el => {
    el.onclick = (): void => fn(el);
    el.onkeydown = (e: KeyboardEvent): void => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(el); } };
  });
  bind('#sumAreas .area-link', el => ctx.gotoIssues({ area: el.dataset.area }));
  bind('#sumActions .df-row', el => ctx.gotoIssues({ check: el.dataset.check }));
}
