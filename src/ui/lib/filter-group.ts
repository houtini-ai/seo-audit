// FilterGroup - a row of count chips with a single active selection.
// Renders into a container and re-renders itself on selection change.
import { esc } from './h.js';

export interface FilterChip {
  key: string;
  label: string;
  count?: number;
  variant?: string; // extra class suffix, e.g. severity for tinting
}

export function filterGroup(
  container: HTMLElement,
  chips: FilterChip[],
  onSelect: (key: string) => void,
  initial = chips[0]?.key ?? '',
): void {
  let active = initial;
  const draw = (): void => {
    container.innerHTML = chips.map(c =>
      `<button class="sev-chip${c.variant ? ` s-${esc(c.variant)}` : ''}${active === c.key ? ' active' : ''}" data-key="${esc(c.key)}">` +
      `${esc(c.label)}${c.count != null ? ` <b>${c.count}</b>` : ''}</button>`).join('');
    container.querySelectorAll<HTMLButtonElement>('.sev-chip').forEach(b =>
      b.addEventListener('click', () => { active = b.dataset.key!; draw(); onSelect(active); }));
  };
  draw();
}
