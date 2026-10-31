// The Summary tab's one-line verdict (panel 1). A TEMPLATE, not
// prose: every clause is built only from a payload value, and a clause whose source is missing is
// omitted, never rendered as zero. Pure and dependency-free, so the UI bundles it and the probe
// tests it over every empty state.

/** The ±5% dead band for "flat": a stated product rule, shown in the verdict's tooltip. */
export const DEAD_BAND_PCT = 5;

export interface VerdictInput {
  /** Last 28 days vs the prior 28 (absent with no GSC). `prior` null = the prior 28 days aren't held. */
  clicks?: { current: number; prior: number | null } | null;
  /** Non-brand clicks, same windows; the brand token is a heuristic, named in the tooltip. */
  nonBrand?: { current: number; prior: number | null; brand: string } | null;
  /** Critical findings in the latest audit (absent with no audit). */
  criticalOpen?: number | null;
  /** Findings resolved since the previous COMPARABLE audit (absent when there is no such pair). */
  resolvedSinceLastAudit?: number | null;
  /** Checks left out of that count because their findings were regrouped between the two audits
   *  (auditDeltas[].excluded.note), said in brackets so the number isn't read as the whole story. */
  resolvedNote?: string | null;
  /** Pages changed between the two latest crawls (absent with < 2 snapshots or a stale diff). */
  pagesChanged?: number | null;
}

export type Direction = 'up' | 'down' | 'flat';
/** A run of text; `n` marks a number (rendered bold and redactable). */
export interface Segment { text: string; n?: boolean }
export interface VerdictChip { key: 'clicks' | 'critical' | 'changes'; label: string; direction: Direction | 'neutral' }
export interface Verdict { segments: Segment[]; chips: VerdictChip[]; tooltip: string; empty: boolean }

export function direction(current: number, prior: number): { dir: Direction; pct: number | null } {
  if (!prior) return { dir: current > 0 ? 'up' : 'flat', pct: null };
  const pct = ((current - prior) / prior) * 100;
  return { dir: Math.abs(pct) < DEAD_BAND_PCT ? 'flat' : pct > 0 ? 'up' : 'down', pct };
}

const fmt = (n: number): string => Math.round(n).toLocaleString('en-GB');
const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

export function buildVerdict(v: VerdictInput): Verdict {
  const clauses: Segment[][] = [];
  const chips: VerdictChip[] = [];
  const tips: string[] = [];

  if (v.clicks && v.clicks.prior == null) {
    // No comparison to make: say what is held instead of comparing with a window we don't have.
    clauses.push([{ text: 'Organic clicks: ' }, { text: fmt(v.clicks.current), n: true }, { text: ' in the last 28 days (the prior 28 days are not fully held, so there is no comparison)' }]);
    chips.push({ key: 'clicks', label: 'Clicks: no prior', direction: 'neutral' });
  } else if (v.clicks && v.clicks.prior != null) {
    const d = direction(v.clicks.current, v.clicks.prior);
    const seg: Segment[] = [];
    if (d.dir === 'flat') seg.push({ text: 'Organic clicks are flat on the prior 28 days' });
    else if (d.pct == null) seg.push({ text: 'Organic clicks are up from none in the prior 28 days' });
    else seg.push({ text: `Organic clicks are ${d.dir} ` }, { text: `${Math.abs(Math.round(d.pct))}%`, n: true }, { text: ' on the prior 28 days' });
    if (v.nonBrand && v.nonBrand.prior != null) {
      const nb = direction(v.nonBrand.current, v.nonBrand.prior);
      if (nb.dir === 'flat') seg.push({ text: ' (non-brand flat)' });
      else if (nb.pct == null) seg.push({ text: ' (non-brand up from none)' }); // prior 0, current > 0: no percentage to give
      else seg.push({ text: ` (non-brand ${nb.dir} ` }, { text: `${Math.abs(Math.round(nb.pct))}%`, n: true }, { text: ')' });
      tips.push(`Non-brand = queries that don't spell the brand "${v.nonBrand.brand}" in whole words (spaced spellings count), detected from the domain (a heuristic).`);
    }
    clauses.push(seg);
    chips.push({ key: 'clicks', label: d.dir === 'flat' ? 'Clicks flat' : d.pct == null ? 'Clicks up' : `Clicks ${d.dir === 'up' ? '+' : '-'}${Math.abs(Math.round(d.pct))}%`, direction: d.dir });
    tips.push(`"Flat" means within ±${DEAD_BAND_PCT}% (a stated product rule, not a benchmark).`);
  }

  if (v.criticalOpen != null) {
    const seg: Segment[] = [{ text: `${fmt(v.criticalOpen)}`, n: true }, { text: ` critical ${plural(v.criticalOpen, 'issue is', 'issues are')} open` }];
    if (v.resolvedSinceLastAudit != null) {
      seg.push({ text: ', ' }, { text: fmt(v.resolvedSinceLastAudit), n: true }, { text: ' resolved since the last audit' });
      if (v.resolvedNote) seg.push({ text: ` (${v.resolvedNote})` });
    }
    clauses.push(seg);
    chips.push({ key: 'critical', label: `${fmt(v.criticalOpen)} critical`, direction: 'neutral' }); // a count, not a direction
  }

  if (v.pagesChanged != null) {
    clauses.push([{ text: fmt(v.pagesChanged), n: true }, { text: ` ${plural(v.pagesChanged, 'page', 'pages')} changed since the last crawl` }]);
    chips.push({ key: 'changes', label: `${fmt(v.pagesChanged)} changed`, direction: 'neutral' });
  }

  if (!clauses.length) return { segments: [], chips: [], tooltip: '', empty: true };
  const segments: Segment[] = [];
  clauses.forEach((c, i) => {
    if (i) segments.push({ text: '; ' });
    segments.push(...c);
  });
  segments.push({ text: '.' });
  tips.push('Built only from the panels below; a clause is left out when its data is missing.');
  return { segments, chips, tooltip: tips.join(' '), empty: false };
}
