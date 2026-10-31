// StatBlock + KpiGrid - label + tabular number + delta + optional sparkline.
import { icons } from './icons.js';
import { fmtNum } from './h.js';
import { countChange, rankChange, SMALL_BASE_MIN } from '../../core/displayRules.js';

export interface StatBlockOpts {
  label: string;
  value: string;           // pre-formatted (caller controls units/decimals)
  change?: number;         // % change vs prior; omit for no delta
  changeHtml?: string;     // a pre-rendered change (countDelta / rankDelta) instead of `change`
  lowerIsBetter?: boolean; // e.g. avg position
  spark?: number[];        // series behind the number
}

/** Inline SVG sparkline - no axes, single muted line. `domain` fixes the vertical scale (e.g. a
 *  0-100 score), so a 71 -> 72 -> 71 wobble isn't drawn as a peak; default = the series' own range. */
export function sparkline(series: number[], lowerIsBetter = false, domain?: [number, number]): string {
  const pts = series.filter(v => Number.isFinite(v));
  if (pts.length < 2) return '';
  const w = 96, h = 26;
  const min = domain ? domain[0] : Math.min(...pts), max = domain ? domain[1] : Math.max(...pts), span = max - min || 1;
  // For position (lower = better) invert Y so an improving trend still rises visually.
  const norm = (v: number): number => (lowerIsBetter ? (v - min) / span : 1 - (v - min) / span);
  const step = w / (pts.length - 1);
  const d = pts.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(norm(v) * (h - 4) + 2).toFixed(1)}`).join(' ');
  return `<svg class="metric-spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

/**
 * A count's change under the small-base rule (core/displayRules.ts): a % on a prior of
 * SMALL_BASE_MIN or more, else the signed difference ("+1 click"), so 0 -> 1 never reads +100%.
 */
/** The change cell when the prior period isn't held (the payload sends null): no comparison, never "up from 0". */
export const NO_PRIOR_HTML = `<span class="chg flat" title="The prior period is not fully held in the synced Search Console history, so there is nothing to compare with.">no prior</span>`;

export function countDelta(current: number, prior: number | null, unit = 'click', lowerIsBetter = false): string {
  if (prior == null) return NO_PRIOR_HTML;
  const c = countChange(current, prior);
  if (c.mode === 'pct') return delta(c.value, lowerIsBetter);
  if (!c.diff) return `<span class="chg flat" title="${fmtNum(prior)} → ${fmtNum(current)}">flat</span>`;
  const better = lowerIsBetter ? c.diff < 0 : c.diff > 0;
  const n = Math.abs(c.diff);
  const title = `${fmtNum(prior)} → ${fmtNum(current)} ${unit}s. Under ${SMALL_BASE_MIN} in the prior period, so the change is shown as a count, not a percentage.`;
  return `<span class="chg ${better ? 'up' : 'down'}" title="${title}">${c.diff > 0 ? icons.triangleUp : icons.triangleDown} ${c.diff > 0 ? '+' : '−'}${fmtNum(n)} ${n === 1 ? unit : `${unit}s`}</span>`;
}

/**
 * An average-position change in positions, never a % of a rank. The arrow points the way the RANK
 * moved (up = better, the position number fell), and the colour says better or worse.
 */
export function rankDelta(current: number, prior: number | null, opts: { short?: boolean } = {}): string {
  if (prior == null) return NO_PRIOR_HTML;
  const r = rankChange(current, prior);
  const title = `Average position ${prior.toFixed(1)} → ${current.toFixed(1)}: ${r.flat ? 'no change' : `${r.positions.toFixed(1)} position${r.positions === 1 ? '' : 's'} ${r.better ? 'better' : 'worse'}`} (lower is better).`;
  if (r.flat) return `<span class="chg flat" title="${title}">flat</span>`;
  const unit = opts.short ? '' : ` position${r.positions === 1 ? '' : 's'}`;
  return `<span class="chg ${r.better ? 'up' : 'down'}" title="${title}">${r.better ? icons.triangleUp : icons.triangleDown} ${r.positions.toFixed(1)}${unit}</span>`;
}

/** Signed delta with triangle glyph; colour reflects better/worse, not up/down. */
export function delta(change: number, lowerIsBetter = false): string {
  if (!change) return `<span class="chg flat">flat</span>`;
  const better = lowerIsBetter ? change < 0 : change > 0;
  const arrow = change > 0 ? icons.triangleUp : icons.triangleDown;
  return `<span class="chg ${better ? 'up' : 'down'}">${arrow} ${Math.abs(change) < 0.5 ? "<1" : Math.abs(Math.round(change))}%</span>`;
}

export const statBlock = (o: StatBlockOpts): string =>
  `<div class="metric-card"><div class="label">${o.label}</div><div class="value">${o.value}</div>` +
  `<div class="metric-foot">${o.changeHtml ?? (o.change !== undefined ? delta(o.change, o.lowerIsBetter) : '')}${o.spark ? sparkline(o.spark, o.lowerIsBetter) : ''}</div></div>`;

export const kpiGrid = (blocks: StatBlockOpts[]): string =>
  `<div class="metrics">${blocks.map(statBlock).join('')}</div>`;
