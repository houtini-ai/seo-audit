// Card - white surface, 1px line, title + optional hint. The static panels in
// dashboard.html use the same .chart-card classes; this factory covers
// dynamically-built cards so both paths share one look.
import { esc } from './h.js';

export interface CardOpts {
  title?: string;
  hint?: string;      // pre-escaped HTML allowed via hintHtml
  hintHtml?: string;
  id?: string;
  bodyHtml?: string;
}

export const card = (o: CardOpts): string =>
  `<div class="chart-card"${o.id ? ` id="${esc(o.id)}"` : ''}>` +
  (o.title ? `<h3>${esc(o.title)}</h3>` : '') +
  (o.hintHtml ? `<div class="hint">${o.hintHtml}</div>` : o.hint ? `<div class="hint">${esc(o.hint)}</div>` : '') +
  (o.bodyHtml ?? '') +
  `</div>`;
