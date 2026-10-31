// The domain-dropdown's options, as pure data so the UI builds the DOM from it and a probe can
// test it without a browser (the displayRules.ts pattern). The one bug this fixes: a property
// opened by its URL that isn't in the lists - a hidden property, say, which list_domains leaves out
// of `properties`/`others` - matched no option, so the <select> fell back to showing "All domains"
// while the page actually showed that property. The open property/domain is now always an option,
// and selected.

export interface DomainPickerLists {
  properties?: string[];
  others?: string[];
  hidden?: string[];
  watched?: { domain: string; group: string | null }[];
}
export interface DomainPickerContext {
  /** 'domains' when the All-domains view is open. */
  view?: 'domains';
  /** A watched domain, when one is open. */
  domain?: string;
  /** The property, when a property dashboard is open. */
  siteUrl: string;
}
export interface DomainPickerOption { value: string; label: string; group: string | null; selected: boolean }

/** The value the <select> should show for the current context. */
export function currentPickerValue(ctx: DomainPickerContext): string {
  return ctx.view === 'domains' ? '__all' : ctx.domain ? `d:${ctx.domain}` : `p:${ctx.siteUrl}`;
}

/** The ordered options, exactly one selected (the open property/domain), including one for a
 *  property opened by URL that is in none of the lists (a hidden property). */
export function domainPickerOptions(ctx: DomainPickerContext, lists: DomainPickerLists): DomainPickerOption[] {
  const current = currentPickerValue(ctx);
  const options: Omit<DomainPickerOption, 'selected'>[] = [{ value: '__all', label: 'All domains', group: null }];
  for (const p of lists.properties ?? []) options.push({ value: `p:${p}`, label: p, group: 'Your properties' });
  for (const w of lists.watched ?? []) options.push({ value: `d:${w.domain}`, label: w.group ? `${w.domain} (${w.group})` : w.domain, group: 'Watched' });
  for (const p of lists.others ?? []) options.push({ value: `p:${p}`, label: p, group: 'Backlink data only' });
  if (current !== '__all' && !options.some(o => o.value === current)) {
    const name = current.slice(2);
    const isHidden = (lists.hidden ?? []).includes(name);
    options.push({ value: current, label: isHidden ? `${name} (hidden)` : name, group: current.startsWith('d:') ? 'Watched' : 'This property' });
  }
  return options.map(o => ({ ...o, selected: o.value === current }));
}
