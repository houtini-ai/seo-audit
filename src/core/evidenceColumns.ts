/**
 * query_audit's `columns` filter. `columns` names TOP-LEVEL evidence keys. When none of them is a
 * key the check's evidence has (external-broken nests its detail under examples[]), filtering
 * blanked every finding and read as "the data is missing" (myminingrig dev channel, BUG-1,
 * 2026-11-11). Then the full evidence is returned, and a note names the keys that do exist.
 */
export interface ColumnSelection {
  /** The evidence keys to keep for each finding, or null for all of them. */
  keep: string[] | null;
  /** Set when some or all requested columns weren't evidence keys. */
  note: string | null;
}

export function selectEvidenceColumns(checkId: string, evidences: Record<string, unknown>[], columns?: string[] | null): ColumnSelection {
  if (!columns?.length) return { keep: null, note: null };
  const available = [...new Set(evidences.flatMap(e => Object.keys(e ?? {})))];
  if (!available.length) return { keep: null, note: null }; // no findings: nothing to say
  const matched = columns.filter(k => available.includes(k));
  const unmatched = columns.filter(k => !available.includes(k));
  if (!matched.length) {
    return {
      keep: null,
      note: `None of the requested columns (${unmatched.join(', ')}) is an evidence key for ${checkId}, so the full evidence is returned. Its keys are: ${available.join(', ')}. Nested detail (for example examples[]) is selected by its top-level key.`,
    };
  }
  return {
    keep: matched,
    note: unmatched.length ? `Not evidence keys for ${checkId}, so left out: ${unmatched.join(', ')}. Its keys are: ${available.join(', ')}.` : null,
  };
}
