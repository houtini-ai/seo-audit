// StatBlock + KpiGrid — label + tabular number + delta + optional sparkline.
import { icons } from './icons.js';

export interface StatBlockOpts {
  label: string;
  value: string;           // pre-formatted (caller controls units/decimals)
  change?: number;         // % change vs prior; omit for no delta
  lowerIsBetter?: boolean; // e.g. avg position
  spark?: number[];        // series behind the number
}

/** Inline SVG sparkline — no axes, single muted line. */
export function sparkline(series: number[], lowerIsBetter = false): string {
  const pts = series.filter(v => Number.isFinite(v));
  if (pts.length < 2) return '';
  const w = 96, h = 26, min = Math.min(...pts), max = Math.max(...pts), span = max - min || 1;
  // For position (lower = better) invert Y so an improving trend still rises visually.
  const norm = (v: number): number => (lowerIsBetter ? (v - min) / span : 1 - (v - min) / span);
  const step = w / (pts.length - 1);
  const d = pts.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(norm(v) * (h - 4) + 2).toFixed(1)}`).join(' ');
  return `<svg class="metric-spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

/** Signed delta with triangle glyph; colour reflects better/worse, not up/down. */
export function delta(change: number, lowerIsBetter = false): string {
  if (!change) return `<span class="chg flat">flat</span>`;
  const better = lowerIsBetter ? change < 0 : change > 0;
  const arrow = change > 0 ? icons.triangleUp : icons.triangleDown;
  return `<span class="chg ${better ? 'up' : 'down'}">${arrow} ${Math.abs(Math.round(change))}%</span>`;
}

export const statBlock = (o: StatBlockOpts): string =>
  `<div class="metric-card"><div class="label">${o.label}</div><div class="value">${o.value}</div>` +
  `<div class="metric-foot">${o.change !== undefined ? delta(o.change, o.lowerIsBetter) : ''}${o.spark ? sparkline(o.spark, o.lowerIsBetter) : ''}</div></div>`;

export const kpiGrid = (blocks: StatBlockOpts[]): string =>
  `<div class="metrics">${blocks.map(statBlock).join('')}</div>`;
