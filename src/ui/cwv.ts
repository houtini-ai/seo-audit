// Field Core Web Vitals (CrUX) in the dashboard: the Summary tile and the Crawl health section.
//
// Honesty rules (the Summary spec's, applied to CrUX):
//   - a metric CrUX had no value for reads "not enough Chrome traffic", never 0;
//   - the window is always named, and a history-only window (no current 28-day record) says so
//     and how old it is, so a stale window is never read as today's figure;
//   - the windows overlap (28 days, a week apart): plotted as a trend, never summed.
import { esc, sparkline, axisDefaults, tooltipDefaults, monoFont, type ChartPalette, type EChartWrapper } from './lib/index.js';
import { assessField, fieldValue, fieldWindowLagDays, parseAt, type FieldBand } from '../core/displayRules.js';

type FF = 'PHONE' | 'DESKTOP';
const FF_LABEL: Record<FF, string> = { PHONE: 'Phone', DESKTOP: 'Desktop' };
const BAND_LABEL: Record<FieldBand, string> = { good: 'Good', 'needs-improvement': 'Needs improvement', poor: 'Poor' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = (iso: string | null | undefined, year = false): string => {
  const t = parseAt(iso); if (!Number.isFinite(t)) return '-';
  const d = new Date(t); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${year ? ` ${d.getUTCFullYear()}` : ''}`;
};
/** Over this many days between the newest window's end and the last check, the window is called old. */
const OLD_WINDOW_DAYS = 14;
const NO_TRAFFIC = 'not enough Chrome traffic';

type Metric = 'lcp' | 'inp' | 'cls' | 'fcp' | 'ttfb';
const METRIC: Record<Metric, { label: string; key: string; name: string }> = {
  lcp: { label: 'LCP', key: 'largest_contentful_paint', name: 'Largest Contentful Paint' },
  inp: { label: 'INP', key: 'interaction_to_next_paint', name: 'Interaction to Next Paint' },
  cls: { label: 'CLS', key: 'cumulative_layout_shift', name: 'Cumulative Layout Shift' },
  fcp: { label: 'FCP', key: 'first_contentful_paint', name: 'First Contentful Paint' },
  ttfb: { label: 'TTFB', key: 'experimental_time_to_first_byte', name: 'Time to First Byte' },
};
const thresholdText = (cf: any, m: Metric): string => {
  const t = cf.thresholds?.[METRIC[m].key];
  if (!t) return '';
  const v = (x: number): string => fieldValue(m, x) ?? String(x);
  return `good at or under ${v(t.good)}, poor over ${v(t.poor)}`;
};
const formFactors = (cf: any): FF[] => (['PHONE', 'DESKTOP'] as FF[]).filter(f => cf?.formFactors?.[f]);

/** The newest window across form factors, and whether any form factor has a current record. */
function windowInfo(cf: any): { last: string; first: string; historyOnly: boolean; lag: number | null; old: boolean } | null {
  const ffs = formFactors(cf);
  if (!ffs.length) return null;
  const f = ffs.map(k => cf.formFactors[k]).sort((a: any, b: any) => (a.period.last < b.period.last ? 1 : -1))[0];
  const historyOnly = ffs.every(k => cf.formFactors[k].source !== 'record');
  const lag = fieldWindowLagDays(f.period.last, cf.lastChecked ?? cf.fetchedAt);
  return { last: f.period.last, first: f.period.first, historyOnly, lag, old: lag != null && lag > OLD_WINDOW_DAYS };
}

// ── Summary tile ──────────────────────────────────────────────────────────────────────────────
export function cwvTile(d: any): string {
  const cf = d.cwvField;
  const ffs = formFactors(cf);
  if (!cf || !ffs.length) {
    return `<div class="metric-card"><div class="label">Field CWV</div><div class="value">–</div>` +
      `<div class="metric-sub">ask Claude to pull CrUX field data</div></div>`;
  }
  const per = ffs.map(f => ({ f, a: assessField(cf.formFactors[f].metrics) }));
  const anyFail = per.some(p => p.a.status === 'fail');
  const allPass = per.every(p => p.a.status === 'pass');
  const value = anyFail ? 'Fail' : allPass ? 'Pass' : 'Partial';
  const tone = anyFail ? 'var(--intent-danger)' : allPass ? 'var(--intent-success)' : 'var(--text-secondary)';
  const w = windowInfo(cf)!;
  const missing = [...new Set(per.flatMap(p => p.a.missing))];
  const chips = per.map(p => {
    const cls = p.a.status === 'fail' ? 'fc-bad' : p.a.status === 'pass' ? 'fc-ok' : 'fc-unk';
    return `<span class="fc-chip ${cls}">${FF_LABEL[p.f]} ${p.a.status === 'fail' ? esc(BAND_LABEL[p.a.worst!].toLowerCase()) : p.a.status === 'pass' ? 'pass' : 'unknown'}</span>`;
  }).join('');
  // Sparkline: phone LCP p75 over the held windows (desktop when phone has none).
  const lcpHist = ((cf.formFactors.PHONE ?? cf.formFactors.DESKTOP).history?.lcp ?? []).map((h: any) => h.p75).filter((v: any) => v != null);
  const subs: string[] = [];
  if (missing.length) subs.push(`${missing.join(', ')}: ${NO_TRAFFIC}`);
  subs.push(`window to ${esc(day(w.last))}${w.historyOnly ? ' (no current record)' : ''}`);
  const lines = per.map(p => {
    const m = cf.formFactors[p.f].metrics;
    const part = (k: 'lcp' | 'inp' | 'cls'): string => { const v = fieldValue(k, m[k]?.p75); return `${METRIC[k].label} ${v ?? NO_TRAFFIC}${v && m[k]?.band ? ` (${BAND_LABEL[m[k].band as FieldBand].toLowerCase()})` : ''}`; };
    return `${FF_LABEL[p.f]}: ${part('lcp')}, ${part('inp')}, ${part('cls')}.`;
  });
  const title = `Chrome UX Report field data for ${cf.origin}: the 75th percentile of real Chrome visits over the 28 days ${day(w.first, true)} to ${day(w.last, true)}.` +
    (w.historyOnly ? ` No current 28-day record: CrUX had too little recent traffic, so this is the newest weekly history window${w.lag != null ? `, ${w.lag} days before the last check` : ''}.` : '') +
    ` Pass = LCP, INP and CLS all good at p75 (LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1, Google's thresholds); a metric with too little traffic is left out, never counted as 0. ${lines.join(' ')}` +
    (lcpHist.length >= 2 ? ` Sparkline: LCP p75 over ${lcpHist.length} windows.` : '');
  return `<div class="metric-card" title="${esc(title)}"><div class="label">Field CWV · CrUX</div>` +
    `<div class="value"><span class="n" style="color:${tone}">${value}</span></div>` +
    `<div class="metric-foot"><span class="fc-chips">${chips}</span>${lcpHist.length >= 2 ? sparkline(lcpHist, true) : ''}</div>` +
    `<div class="metric-sub">${subs.join(' · ')}</div></div>`;
}

/** The coverage chip for field CWV, derived from the payload (Summary footer). */
export function cwvCoverage(d: any): { on: boolean; value: string; title: string } {
  const cf = d.cwvField;
  const ffs = formFactors(cf);
  if (!cf || !ffs.length) return { on: false, value: 'none', title: 'Chrome UX Report field data: ask Claude to pull CrUX (needs a CRUX_API_KEY).' };
  const w = windowInfo(cf)!;
  const windows = Math.max(...ffs.map(f => cf.formFactors[f].windows ?? 0));
  return {
    on: true,
    value: `origin, <span class="n">${windows}</span> window${windows === 1 ? '' : 's'}`,
    title: `Chrome UX Report origin data (${ffs.map(f => FF_LABEL[f].toLowerCase()).join(' and ')}), newest window to ${day(w.last, true)}${w.historyOnly ? ', history only (no current record)' : ''}.`,
  };
}

// ── Crawl health section ──────────────────────────────────────────────────────────────────────
const bandBadge = (b: FieldBand | null | undefined): string =>
  b ? `<span class="fband fband-${b === 'needs-improvement' ? 'ni' : b}">${BAND_LABEL[b]}</span>` : '';

function distBar(m: any): string {
  const parts = [['good', m?.good], ['ni', m?.ni], ['poor', m?.poor]] as const;
  if (parts.every(([, v]) => v == null)) return '';
  const pct = (v: number | null | undefined): string => (v == null ? '–' : `${(v * 100).toFixed(v > 0 && v < 0.01 ? 1 : 0)}%`);
  const label: Record<string, string> = { good: 'good', ni: 'needs improvement', poor: 'poor' };
  return `<div class="fdist" role="img" aria-label="${parts.map(([k, v]) => `${label[k]} ${pct(v)}`).join(', ')}">` +
    parts.map(([k, v]) => (v ? `<span class="fd-${k}" style="flex:${v}" title="${label[k]}: ${pct(v)} of visits"></span>` : '')).join('') + `</div>` +
    `<div class="fdist-key">${parts.map(([k, v]) => `<span><i class="fd-${k}"></i>${pct(v)}</span>`).join('')}</div>`;
}

function metricRow(cf: any, ff: FF, m: Metric): string {
  const v = cf.formFactors[ff].metrics[m];
  const val = fieldValue(m, v?.p75);
  const name = `<span class="fm-k" title="${esc(`${METRIC[m].name}, 75th percentile; ${thresholdText(cf, m)}`)}">${METRIC[m].label}</span>`;
  if (!val) return `<div class="fm-row">${name}<span class="fm-none">${NO_TRAFFIC}</span></div>`;
  // An empty cell when there's no band keeps the bar in its own (fixed) column.
  return `<div class="fm-row">${name}<span class="fm-v n">${esc(val)}</span>${bandBadge(v.band) || '<span></span>'}<div class="fm-dist">${distBar(v)}</div></div>`;
}

function breakdown(cf: any, ff: FF): string {
  const b = cf.formFactors[ff].lcpBreakdown ?? {};
  const parts = [['ttfb', 'Server response (TTFB)'], ['loadDelay', 'Resource load delay'], ['loadDuration', 'Resource load duration'], ['renderDelay', 'Element render delay']] as const;
  const have = parts.filter(([k]) => b[k] != null);
  if (!have.length) return `<div class="fm-none fb-none">LCP breakdown: not reported by CrUX for this window (it needs more LCP image loads).</div>`;
  const total = have.reduce((s, [k]) => s + b[k], 0) || 1;
  return `<div class="fb"><div class="fb-h">LCP breakdown (p75 of each part)</div><div class="fb-bar">${have.map(([k, l]) => `<span class="fb-${parts.findIndex(p => p[0] === k)}" style="flex:${b[k] / total}" title="${l}: ${Math.round(b[k])} ms"></span>`).join('')}</div>` +
    `<div class="fb-key">${parts.map(([k, l], i) => `<span><i class="fb-${i}"></i>${l} <b class="n">${b[k] == null ? '–' : `${Math.round(b[k])} ms`}</b></span>`).join('')}</div></div>`;
}

export interface CwvCtx { wrap: (id: string) => EChartWrapper; col: ChartPalette & { green: string }; redacted: boolean }

export function renderFieldCwv(d: any, ctx: CwvCtx): void {
  const card = document.getElementById('fieldCwvCard');
  if (!card) return;
  const cf = d.cwvField;
  const ffs = formFactors(cf);
  const set = (id: string, html: string): void => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
  const trendEl = document.getElementById('fieldCwvTrend');
  if (!cf || !ffs.length) {
    set('fieldCwvSrc', '');
    set('fieldCwvNote', '');
    set('fieldCwv', '<div class="empty-state">No field data yet. <code>sync_crux</code> pulls the Chrome UX Report for this origin and its top pages (needs a <code>CRUX_API_KEY</code>).</div>');
    if (trendEl) trendEl.style.display = 'none';
    set('fieldCwvTrendNote', '');
    return;
  }
  const w = windowInfo(cf)!;
  set('fieldCwvSrc', `CrUX · to ${day(w.last)}`);
  set('fieldCwvNote', w.historyOnly
    ? `<div class="sum-banner">No current 28-day record: Chrome had too little recent traffic on ${esc(cf.origin)} for CrUX to publish one. The newest window with enough traffic is ${esc(day(w.first, true))} to ${esc(day(w.last, true))}${w.lag != null ? `, <span class="n">${w.lag}</span> days before the last check (${esc(day(cf.lastChecked ?? cf.fetchedAt, true))})` : ''}. These are the latest real-user figures CrUX holds, not today's.</div>`
    : w.old ? `<div class="sum-banner">The newest window ends ${esc(day(w.last, true))}, ${w.lag} days before the last check: ask Claude to pull CrUX again for a fresher one.</div>` : '');
  set('fieldCwv', ffs.map(ff => {
    const f = cf.formFactors[ff];
    const a = assessField(f.metrics);
    const verdict = a.status === 'pass' ? '<span class="fband fband-good">Passes</span>' : a.status === 'fail' ? `<span class="fband fband-${a.worst === 'poor' ? 'poor' : 'ni'}">Fails</span>` : '<span class="fband">Not assessable</span>';
    const assessed = ['LCP', 'INP', 'CLS'].filter(x => !a.missing.includes(x as 'LCP'));
    const few = `${a.missing.join(' and ')} ${a.missing.length > 1 ? 'have' : 'has'} too little Chrome traffic to measure`;
    const why = a.status === 'unknown' ? `<div class="fm-note">${few}, so there's no pass or fail.</div>`
      : a.missing.length ? `<div class="fm-note">Assessed on ${assessed.join(' and ')}; ${few}.</div>` : '';
    return `<div class="fcwv-col"><div class="fcwv-h"><h4>${FF_LABEL[ff]}</h4>${verdict}<span class="fcwv-win">${esc(day(f.period.first))} to ${esc(day(f.period.last, true))}${f.source === 'record' ? '' : ' · history'}</span></div>${why}` +
      `<div class="fm-rows">${(['lcp', 'inp', 'cls'] as Metric[]).map(m => metricRow(cf, ff, m)).join('')}` +
      `<div class="fm-sep">Diagnostics</div>${(['fcp', 'ttfb'] as Metric[]).map(m => metricRow(cf, ff, m)).join('')}</div>${breakdown(cf, ff)}</div>`;
  }).join(''));

  // History trend: small multiples (LCP s, INP ms, CLS), one line per form factor, with the
  // "good" threshold dashed. Only metrics with at least one window get a panel.
  const metrics = (['lcp', 'inp', 'cls'] as const).filter(m => ffs.some(ff => (cf.formFactors[ff].history?.[m] ?? []).some((h: any) => h.p75 != null)));
  const maxWindows = Math.max(0, ...ffs.flatMap(ff => metrics.map(m => (cf.formFactors[ff].history?.[m] ?? []).filter((h: any) => h.p75 != null).length)));
  const absent = (['lcp', 'inp', 'cls'] as const).filter(m => !metrics.includes(m)).map(m => METRIC[m].label);
  if (!trendEl) return;
  if (!metrics.length || maxWindows < 2) {
    trendEl.style.display = 'none';
    set('fieldCwvTrendNote', `Trend: CrUX holds ${maxWindows} window${maxWindows === 1 ? '' : 's'} with data, so there's no trend yet. Each weekly <code>sync_crux</code> adds one.${absent.length ? ` ${absent.join(', ')}: ${NO_TRAFFIC} in any window.` : ''}`);
    return;
  }
  trendEl.style.display = '';
  const { col } = ctx;
  const dates = [...new Set(ffs.flatMap(ff => metrics.flatMap(m => (cf.formFactors[ff].history?.[m] ?? []).map((h: any) => h.periodLast as string))))].sort();
  const H = metrics.length;
  trendEl.style.height = `${50 + H * 96}px`;
  const ax = axisDefaults(col, { numeric: true });
  const ffColor: Record<FF, string> = { PHONE: col.categorical[0], DESKTOP: col.categorical[2] };
  const toUnit = (m: string, v: number | null): number | null => (v == null ? null : m === 'lcp' ? Math.round(v / 10) / 100 : m === 'cls' ? v : Math.round(v));
  const unit: Record<string, string> = { lcp: 's', inp: 'ms', cls: '' };
  ctx.wrap('fieldCwvTrend').setOption({
    aria: { enabled: true }, animation: false,
    legend: { top: 0, right: 0, itemWidth: 12, itemHeight: 8, textStyle: { color: col.text, fontSize: 11 }, data: ffs.map(f => FF_LABEL[f]) },
    tooltip: ctx.redacted ? { show: false } : { ...tooltipDefaults(col), trigger: 'axis' },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    grid: metrics.map((_, i) => ({ left: 52, right: 16, top: 40 + i * 96, height: 62 })),
    title: metrics.map((m, i) => ({ text: `${METRIC[m].label} p75${unit[m] ? ` (${unit[m]})` : ''}`, left: 52, top: 22 + i * 96, textStyle: { color: col.text, fontSize: 11, fontWeight: 600 } })),
    xAxis: metrics.map((_, i) => ({
      type: 'category', gridIndex: i, data: dates, boundaryGap: false, axisTick: { show: false }, axisLine: { lineStyle: { color: col.border } },
      axisLabel: i === H - 1 ? { color: col.axisText, fontSize: 10, fontFamily: monoFont(), formatter: (v: string) => day(v), hideOverlap: true } : { show: false },
    })),
    // A fixed, round scale that always shows the "good" line: 0-3 s, 0-300 ms, 0-0.15 (or the
    // data's own max when it's above that), in three steps.
    yAxis: metrics.map((m, i) => {
      const floor = { lcp: 3, inp: 300, cls: 0.15 }[m];
      const step = { lcp: 1, inp: 100, cls: 0.05 }[m];
      const dataMax = Math.max(0, ...ffs.flatMap(ff => (cf.formFactors[ff].history?.[m] ?? []).map((h: any) => toUnit(m, h.p75) ?? 0)));
      const max = Math.max(floor, Math.ceil(dataMax / step) * step);
      return { type: 'value', gridIndex: i, min: 0, max, interval: max / 3, ...ax, axisLabel: { ...ax.axisLabel, show: !ctx.redacted, formatter: (v: number) => (m === 'cls' ? v.toFixed(2) : String(+v.toFixed(1))) }, axisLine: { show: false } };
    }),
    series: metrics.flatMap((m, i) => ffs.map((ff, j) => {
      const byDate = new Map<string, number | null>((cf.formFactors[ff].history?.[m] ?? []).map((h: any) => [h.periodLast, toUnit(m, h.p75)]));
      const t = cf.thresholds?.[METRIC[m].key];
      return {
        name: FF_LABEL[ff], type: 'line', xAxisIndex: i, yAxisIndex: i, connectNulls: false, symbol: 'circle', symbolSize: 5,
        lineStyle: { width: 1.75, color: ffColor[ff] }, itemStyle: { color: ffColor[ff] },
        data: dates.map(dt => byDate.get(dt) ?? null),
        ...(j === 0 && t ? { markLine: { silent: true, symbol: 'none', label: { show: true, position: 'insideEndTop', formatter: 'good', color: col.muted, fontSize: 9.5 }, lineStyle: { type: 'dashed', color: col.green, width: 1 }, data: [{ yAxis: toUnit(m, t.good) }] } } : {}),
      };
    })),
  });
  set('fieldCwvTrendNote', `p75 per 28-day window, oldest first; the windows overlap (a week apart), so read them as a trend, never a sum. Dashed: Google's "good" threshold.${absent.length ? ` ${absent.join(', ')}: ${NO_TRAFFIC} in any window.` : ''}${maxWindows < 4 ? ` Only <span class="n">${maxWindows}</span> windows held: each weekly <code>sync_crux</code> adds one.` : ''}`);
}
