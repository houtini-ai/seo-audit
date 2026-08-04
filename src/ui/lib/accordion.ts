// AccordionGroup - native <details> items with a shared expand/collapse control.
import { esc } from './h.js';
import { icons } from './icons.js';

export interface AccordionItem {
  summaryHtml: string; // badges + title + counts (pre-built, escaped by caller)
  bodyHtml: string;
  open?: boolean;
}

export const accordionItem = (i: AccordionItem): string =>
  `<details class="rec-acc"${i.open ? ' open' : ''}>` +
  `<summary>${i.summaryHtml}<span class="rec-chev" aria-hidden="true">${icons.chevron}</span></summary>` +
  `<div class="rec-body">${i.bodyHtml}</div></details>`;

export const accordionGroup = (items: AccordionItem[]): string => items.map(accordionItem).join('');

/** Expand-all / collapse-all buttons controlling every <details> inside scope. */
export function accordionControls(ctrl: HTMLElement, scope: HTMLElement): void {
  ctrl.innerHTML =
    `<button class="recs-btn" data-act="expand">Expand all</button>` +
    `<button class="recs-btn" data-act="collapse">Collapse all</button>`;
  ctrl.querySelectorAll<HTMLButtonElement>('.recs-btn').forEach(b =>
    b.addEventListener('click', () => {
      const open = b.dataset.act === 'expand';
      scope.querySelectorAll('details').forEach(d => { (d as HTMLDetailsElement).open = open; });
    }));
}

/** Category section header used above accordion groups. */
export const accordionSection = (title: string, count: number, itemsHtml: string): string =>
  `<div class="rec-cat"><h4 class="rec-cat-title">${esc(title)} <span class="rec-cat-count">${count}</span></h4>${itemsHtml}</div>`;
