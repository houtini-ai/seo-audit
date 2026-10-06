/**
 * Shared lexical primitives for the demand-clustering features (opportunities.ts,
 * contentArchitecture.ts). One copy so the stop-word list, tokenizer and the
 * Jaccard similarity used for greedy clustering can't drift between them.
 */
export const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'with', 'your', 'you', 'is', 'are', 'best', 'how', 'what', 'vs', 'why', 'can', 'my', 'i', 'it']);

export const tokenize = (s: string): string[] =>
  (s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(t => t.length >= 2 && !STOP.has(t));

export const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
};
