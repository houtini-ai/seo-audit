/**
 * Structured-data validation. Google has NO public Rich-Results validation API, so
 * we maintain a versioned required-field map and validate captured JSON-LD ourselves.
 * Grounded in research/11 and research/01 §5 (#109–123). Deterministic by design:
 * we ONLY flag documented-required fields and unambiguous value errors — recommended-
 * only fields and unknown @types are deliberately NOT flagged (false positives erode
 * trust). The `pages.json_ld` column is JSON.stringify(arrayOfRawBlockStrings).
 */

// Google "Required properties" per type (the fields Google actually rewards).
const REQUIRED: Record<string, string[]> = {
  Article: ['headline', 'author', 'datePublished', 'image'],
  BlogPosting: ['headline', 'author', 'datePublished', 'image'],
  NewsArticle: ['headline', 'author', 'datePublished', 'image'],
  Product: ['name', 'offers'],
  Organization: ['name', 'url', 'logo'],
  BreadcrumbList: ['itemListElement'],
  WebSite: ['url'],
  Event: ['name', 'startDate', 'location'],
  Recipe: ['name', 'image'],
  VideoObject: ['name', 'thumbnailUrl', 'uploadDate'],
  JobPosting: ['title', 'description', 'datePosted', 'hiringOrganization', 'jobLocation'],
  LocalBusiness: ['name', 'address'],
  Course: ['name', 'description', 'provider'],
  FAQPage: ['mainEntity'],
};
// Nested required: e.g. Product.offers must carry price + priceCurrency.
const NESTED_REQUIRED: Record<string, { field: string; sub: string[] }> = {
  Product: { field: 'offers', sub: ['price', 'priceCurrency'] },
};
// Schemas Google has restricted — eligible only in narrow contexts (research/01 #119).
const FORBIDDEN = new Set(['FAQPage', 'HowTo']);

const URL_FIELDS = /^(image|logo|thumbnailurl|contenturl|url)$/i;
const DATE_FIELDS = /^(datepublished|datemodified|startdate|enddate|uploaddate|dateposted|validfrom)$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/;

export type SchemaIssueKind = 'parse' | 'context' | 'type' | 'required' | 'value' | 'forbidden';
export interface SchemaIssue {
  kind: SchemaIssueKind;
  type?: string;          // the @type the issue relates to
  detail: string;         // human-readable
  fields?: string[];      // missing/offending field names
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Normalise @type (may be a string or array) to the first concrete type string. */
function typeOf(node: Record<string, unknown>): string | null {
  const t = node['@type'];
  if (typeof t === 'string') return t;
  if (Array.isArray(t) && typeof t[0] === 'string') return t[0];
  return null;
}

/** Flatten a parsed block into its constituent nodes (handles arrays + @graph). */
function nodesOf(parsed: unknown, out: Record<string, unknown>[]): void {
  if (Array.isArray(parsed)) { for (const p of parsed) nodesOf(p, out); return; }
  if (!isObj(parsed)) return;
  if (Array.isArray(parsed['@graph'])) { nodesOf(parsed['@graph'], out); return; }
  out.push(parsed);
}

function urlIsAbsolute(v: unknown): boolean {
  if (typeof v === 'string') return /^https?:\/\//i.test(v);
  if (isObj(v)) return urlIsAbsolute(v.url ?? v['@id']); // ImageObject etc.
  if (Array.isArray(v)) return v.every(urlIsAbsolute);
  return true; // not a URL-bearing shape we can judge → don't flag
}

function validateNode(node: Record<string, unknown>, issues: SchemaIssue[]): void {
  const type = typeOf(node);
  if (!type) { issues.push({ kind: 'type', detail: 'Node has no @type.' }); return; }

  if (FORBIDDEN.has(type)) {
    issues.push({ kind: 'forbidden', type, detail: `${type} rich results are restricted to narrow contexts — likely ineligible on this page.` });
  }

  const required = REQUIRED[type];
  if (required) {
    const missing = required.filter(f => node[f] === undefined || node[f] === null || node[f] === '');
    if (missing.length) issues.push({ kind: 'required', type, detail: `${type} missing required field(s): ${missing.join(', ')}.`, fields: missing });

    const nested = NESTED_REQUIRED[type];
    if (nested && node[nested.field] !== undefined) {
      const offers = Array.isArray(node[nested.field]) ? (node[nested.field] as unknown[]) : [node[nested.field]];
      for (const off of offers) {
        if (!isObj(off)) continue;
        const missSub = nested.sub.filter(f => off[f] === undefined || off[f] === null || off[f] === '');
        if (missSub.length) issues.push({ kind: 'required', type, detail: `${type}.${nested.field} missing: ${missSub.join(', ')}.`, fields: missSub.map(f => `${nested.field}.${f}`) });
      }
    }
  }

  // Value sanity (#120 absolute URLs, #121 ISO-8601 dates) — only on present fields.
  for (const [k, v] of Object.entries(node)) {
    if (URL_FIELDS.test(k) && v != null && !urlIsAbsolute(v)) {
      issues.push({ kind: 'value', type, detail: `${k} is not an absolute URL.`, fields: [k] });
    }
    if (DATE_FIELDS.test(k) && typeof v === 'string' && !ISO_DATE.test(v)) {
      issues.push({ kind: 'value', type, detail: `${k} is not ISO-8601 ("${v}").`, fields: [k] });
    }
  }
}

/** Validate the raw `pages.json_ld` column. Returns all issues found across blocks. */
export function validateJsonLdColumn(col: string | null): SchemaIssue[] {
  if (!col) return [];
  const issues: SchemaIssue[] = [];
  let blocks: unknown;
  try { blocks = JSON.parse(col); } catch { return [{ kind: 'parse', detail: 'json_ld column is not valid JSON.' }]; }
  const rawBlocks: string[] = Array.isArray(blocks) ? blocks.filter((b): b is string => typeof b === 'string') : [];

  for (const raw of rawBlocks) {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { issues.push({ kind: 'parse', detail: 'A JSON-LD block does not parse (check trailing commas / escaped quotes).' }); continue; }
    const nodes: Record<string, unknown>[] = [];
    nodesOf(parsed, nodes);
    for (const node of nodes) {
      const ctx = node['@context'];
      const ctxOk = typeof ctx === 'string' ? /schema\.org/i.test(ctx) : Array.isArray(ctx) ? ctx.some(c => typeof c === 'string' && /schema\.org/i.test(c)) : isObj(ctx);
      // @context lives on the top-level node; nested @graph nodes inherit it — only flag when absent everywhere.
      if (ctx !== undefined && !ctxOk) issues.push({ kind: 'context', detail: '@context is not https://schema.org.' });
      validateNode(node, issues);
    }
    // A block whose top node carries no @context at all.
    if (isObj(parsed) && parsed['@context'] === undefined && !Array.isArray(parsed['@graph'])) {
      issues.push({ kind: 'context', detail: 'JSON-LD block has no @context.' });
    }
  }
  return issues;
}
