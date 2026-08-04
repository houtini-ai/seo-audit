// Badge — the one pill/label primitive. Variants map to the intent layer;
// severity/size/status all resolve through it so tinting stays consistent.
import { esc } from './h.js';

export type BadgeVariant = 'danger' | 'warning' | 'success' | 'info' | 'accent' | 'neutral';

/** Soft-tinted pill: intent background + intent text (pricemonitor style). */
export const badge = (label: string, variant: BadgeVariant = 'neutral', title = ''): string =>
  `<span class="badge badge-${variant}"${title ? ` title="${esc(title)}"` : ''}>${esc(label)}</span>`;

/** Outlined mono tag (impact sizes XL/L/M/S) — quieter than the tinted pill. */
export const tag = (label: string, variant: BadgeVariant = 'neutral', title = ''): string =>
  `<span class="tag-badge tag-${variant}"${title ? ` title="${esc(title)}"` : ''}>${esc(label)}</span>`;

const SEV_VARIANT: Record<string, BadgeVariant> = {
  crit: 'danger', high: 'warning', med: 'info', low: 'neutral', info: 'neutral',
};
export const sevBadge = (sev: string): string => badge(sev, SEV_VARIANT[sev] ?? 'neutral');

const SIZE_VARIANT: Record<string, BadgeVariant> = { xl: 'danger', l: 'warning', m: 'accent', s: 'neutral' };
export const sizeVariant = (size: string): BadgeVariant => SIZE_VARIANT[size.toLowerCase()] ?? 'neutral';

/** HTTP status chip: 200 = success, 3xx = warning, 4xx/5xx = danger, unknown = dash. */
export const statusBadge = (s: number | null | undefined): string => {
  if (s == null) return badge('–', 'neutral');
  return badge(String(s), s === 200 ? 'success' : s >= 400 ? 'danger' : s >= 300 ? 'warning' : 'neutral');
};
