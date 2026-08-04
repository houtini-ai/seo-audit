// DataGrid - the one table primitive: sticky headers, click-to-sort, right-
// aligned numerics with tabular numerals, and a lightweight virtual window via
// content-visibility:auto (the .grid-virtual class) instead of pagination.
// Cell formatters (formatDiff / formatStatBar / formatTrend) live here too.
import { esc, fmtNum } from './h.js';
import { icons } from './icons.js';

export interface GridColumn {
  label: string;
  numeric?: boolean;  // right-aligned, sorts numerically
  sortable?: boolean; // default true
}

export interface GridOpts {
  columns: GridColumn[];
  rowsHtml: string[];   // caller-built <tr> strings (cells use .num for numerics)
  virtual?: boolean;    // content-visibility window for long lists
  emptyHtml?: string;
}

/** Build the table HTML. Call attachSort(container) after inserting it. */
export const dataGrid = (o: GridOpts): string => {
  if (!o.rowsHtml.length) return o.emptyHtml ?? '<p class="muted">–</p>';
  const head = o.columns.map(c => `<th${c.numeric ? ' class="num"' : ''}${c.sortable === false ? ' data-nosort=""' : ''}>${esc(c.label)}</th>`).join('');
  return `<table class="data-grid${o.virtual ? ' grid-virtual' : ''}"><thead><tr>${head}</tr></thead><tbody>${o.rowsHtml.join('')}</tbody></table>`;
};

/** Wire click-to-sort on every table inside the container. Numeric columns are
 * detected from the header's .num class or the first row's cells; blanks and
 * dashes sink to the bottom. Detail-row pairs (tr.fi-detail-row) travel with
 * their parent row. */
export function attachSort(container: HTMLElement | null): void {
  if (!container) return;
  container.querySelectorAll('table').forEach(table => {
    const tbody = table.querySelector('tbody');
    if (!tbody) return;
    const ths = [...table.querySelectorAll('thead th')] as HTMLElement[];
    const first = tbody.querySelector('tr');
    const toNum = (raw: string): number => {
      const m = raw.replace(/[−–]/g, '-').match(/-?\d[\d,]*\.?\d*/);
      return m ? parseFloat(m[0].replace(/,/g, '')) : NaN;
    };
    ths.forEach((th, i) => {
      if (th.hasAttribute('data-nosort') || th.classList.contains('nosort')) return;
      const numeric = th.classList.contains('num')
        || !!(first && (first.children[i] as HTMLElement | undefined)?.classList.contains('num'));
      th.classList.add('sortable-th');
      th.addEventListener('click', () => {
        const dir = th.getAttribute('aria-sort') === 'ascending' ? 'descending' : 'ascending';
        ths.forEach(x => { x.removeAttribute('aria-sort'); x.classList.remove('sort-asc', 'sort-desc'); });
        th.setAttribute('aria-sort', dir);
        th.classList.add(dir === 'ascending' ? 'sort-asc' : 'sort-desc');
        const val = (tr: Element): string =>
          (tr.children[i] as HTMLElement | undefined)?.getAttribute('data-sort')
          ?? ((tr.children[i] as HTMLElement | undefined)?.textContent ?? '').trim();
        // Pair each sortable row with its detail row (if any) so pairs move together.
        const rows = [...tbody.querySelectorAll(':scope > tr')].filter(r => !r.classList.contains('fi-detail-row'));
        rows.sort((a, b) => {
          if (numeric) {
            const x = toNum(val(a)), y = toNum(val(b)), ax = isNaN(x), ay = isNaN(y);
            if (ax && ay) return 0; if (ax) return 1; if (ay) return -1;
            return dir === 'ascending' ? x - y : y - x;
          }
          const x = val(a).toLowerCase(), y = val(b).toLowerCase(), c = x < y ? -1 : x > y ? 1 : 0;
          return dir === 'ascending' ? c : -c;
        });
        rows.forEach(r => {
          const det = r.nextElementSibling;
          tbody.appendChild(r);
          if (det?.classList.contains('fi-detail-row')) tbody.appendChild(det);
        });
      });
    });
  });
}

/* --- Cell formatters --- */

/** before -> after, with the change carrying the meaning. */
export const formatDiff = (before: number | null | undefined, after: number | null | undefined, fmt = fmtNum): string => {
  const b = before == null ? '–' : fmt(before);
  const a = after == null ? '–' : fmt(after);
  return `<span class="cell-diff"><span class="diff-before">${b}</span><span class="diff-arrow">→</span><span class="diff-after">${a}</span></span>`;
};

/** Inline SF-style stat bar: count + share of a base, colour by tone. */
export const formatStatBar = (count: number, base: number, tone: 'ok' | 'warn' | 'bad' | 'muted' | 'accent' = 'accent'): string => {
  const pct = base > 0 ? Math.min(100, (count / base) * 100) : 0;
  const width = Math.max(pct, count > 0 ? 1.5 : 0);
  return `<span class="cell-statbar"><span class="statbar-track"><span class="statbar-fill sb-${tone}" style="width:${width.toFixed(1)}%"></span></span>` +
    `<span class="statbar-count">${fmtNum(count)}</span><span class="statbar-pct">${pct < 1 && count > 0 ? '<1' : Math.round(pct)}%</span></span>`;
};

/** Signed value + direction triangle; green when better, red when worse. */
export const formatTrend = (value: number, opts: { lowerIsBetter?: boolean; suffix?: string } = {}): string => {
  if (!value) return `<span class="cell-trend flat">0${opts.suffix ?? ''}</span>`;
  const better = opts.lowerIsBetter ? value < 0 : value > 0;
  const arrow = value > 0 ? icons.triangleUp : icons.triangleDown;
  return `<span class="cell-trend ${better ? 'up' : 'down'}">${arrow} ${value > 0 ? '+' : '−'}${fmtNum(Math.abs(value))}${opts.suffix ?? ''}</span>`;
};
