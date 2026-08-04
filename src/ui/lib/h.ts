// Tiny DOM/string helpers shared by the display library. No framework — the
// library renders HTML strings (matching the dashboard's innerHTML pipeline)
// plus a small h() element factory for components that need live wiring.

export const esc = (s: string): string =>
  s.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch] as string));

/** Element factory: h('button', { class: 'btn', onclick: fn }, 'Label'). */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  ...children: (string | Node)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') (el as any)[k] = v;
    else if (k === 'dataset') Object.assign(el.dataset, v as Record<string, string>);
    else el.setAttribute(k, String(v));
  }
  for (const c of children) el.append(c);
  return el;
}

/** Compact number: 1234 -> 1,234 · 56700 -> 56.7k · 14200000 -> 14.2M. */
export const fmtNum = (n: number): string =>
  new Intl.NumberFormat('en', { notation: n >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(n);

/** Axis-discipline formatter (brief pattern #4): 14M not 14,000,000. */
export const fmtAxis = (n: number): string => {
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${+(n / 1e3).toFixed(1)}k`;
  return String(n);
};

/** Null-vs-zero discipline (brief pattern #2): 0 renders as 0; missing as a dash. */
export const fmtCell = (v: number | null | undefined, fmt: (n: number) => string = fmtNum): string =>
  v == null || Number.isNaN(v) ? '<span class="cell-null">–</span>' : fmt(v);
