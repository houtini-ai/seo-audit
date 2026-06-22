/**
 * Structured-data validation. Google has NO public Rich-Results validation API and
 * validator.schema.org has none either (it's a Google-run service; the /validate endpoint
 * is undocumented + anti-scraped), so we validate captured JSON-LD locally against a
 * maintained map. Grounded in research/11 and research/01 §5 (#109–123). Deterministic by
 * design: we ONLY flag documented-required fields and unambiguous value errors —
 * recommended-only fields, unknown properties, and unknown @types are deliberately NOT
 * flagged (Google ignores them; flagging them is false-positive noise that erodes trust).
 *
 * Coverage (~30 @types):
 *  - Content: Article/BlogPosting/NewsArticle, FAQPage/QAPage, Review/AggregateRating,
 *    Movie/Book, VideoObject, Recipe, Course, SoftwareApplication, BreadcrumbList, WebSite, Organization.
 *  - Commerce: Product (name + one-of offers/review/aggregateRating).
 *  - Jobs: JobPosting (title/description/datePosted/hiringOrganization + one-of
 *    jobLocation/jobLocationType/applicantLocationRequirements — so remote jobs aren't flagged).
 *  - Datasets: Dataset (name, description).
 *  - Travel: Hotel/LodgingBusiness/Resort/BedAndBreakfast/Restaurant (name, address);
 *    TouristAttraction/TouristDestination/Trip/TouristTrip (name); LocalBusiness; Event.
 *  - ONE_OF groups: "at least one of" required-sets (Google treats some fields as alternatives).
 *  - Nested required (Product/SoftwareApplication.offers → price+priceCurrency;
 *    Review.reviewRating → ratingValue; JobPosting.jobLocation → address), only when present.
 *  - Value sanity: absolute URLs, ISO-8601 dates, ISO-4217 priceCurrency, bare-number price.
 *  - Type-level dedup so a complete + partial node of the same type doesn't false-flag.
 * The `pages.json_ld` column is JSON.stringify(arrayOfRawBlockStrings).
 */

// Google "Required properties" per type (the fields Google actually rewards). Kept conservative
// on purpose — only fields Google documents as REQUIRED, and only for the standalone @type
// (nested objects like Product.review/aggregateRating aren't extracted as nodes, so requiring
// `author`/`ratingValue` here can't false-flag a nested review that inherits context).
const REQUIRED: Record<string, string[]> = {
  Article: ['headline', 'author', 'datePublished', 'image'],
  BlogPosting: ['headline', 'author', 'datePublished', 'image'],
  NewsArticle: ['headline', 'author', 'datePublished', 'image'],
  Product: ['name'], // + one-of(offers/review/aggregateRating) below
  Organization: ['name', 'url', 'logo'],
  BreadcrumbList: ['itemListElement'],
  WebSite: ['url'],
  Event: ['name', 'startDate', 'location'],
  Recipe: ['name', 'image'],
  VideoObject: ['name', 'thumbnailUrl', 'uploadDate'],
  JobPosting: ['title', 'description', 'datePosted', 'hiringOrganization'], // + one-of(location…) below
  LocalBusiness: ['name', 'address'],
  Course: ['name', 'description', 'provider'],
  FAQPage: ['mainEntity'],
  QAPage: ['mainEntity'],
  Review: ['author', 'reviewRating'],
  AggregateRating: ['ratingValue'],
  Movie: ['name'],
  Book: ['name', 'author'],
  SoftwareApplication: ['name'],
  Dataset: ['name', 'description'],
  // Travel — lodging/food are LocalBusiness subtypes (need name+address); places/trips need a name.
  Hotel: ['name', 'address'],
  LodgingBusiness: ['name', 'address'],
  Resort: ['name', 'address'],
  BedAndBreakfast: ['name', 'address'],
  Restaurant: ['name', 'address'],
  TouristAttraction: ['name'],
  TouristDestination: ['name'],
  Trip: ['name'],
  TouristTrip: ['name'],
};
// One-of required: at least one of the group must be present. Google treats these as "any of"
// (a remote JobPosting uses jobLocationType instead of jobLocation; a Product can qualify via
// review/aggregateRating instead of offers) — so flatly requiring one member is a false positive.
const ONE_OF: Record<string, string[][]> = {
  Product: [['offers', 'review', 'aggregateRating']],
  JobPosting: [['jobLocation', 'jobLocationType', 'applicantLocationRequirements']],
};
// Nested required: e.g. Product.offers must carry price + priceCurrency. Only checked when the
// parent field is present (so a SoftwareApplication relying on aggregateRating instead of offers
// isn't flagged for a missing offers.price, and a remote JobPosting isn't flagged for jobLocation).
const NESTED_REQUIRED: Record<string, { field: string; sub: string[] }> = {
  Product: { field: 'offers', sub: ['price', 'priceCurrency'] },
  SoftwareApplication: { field: 'offers', sub: ['price', 'priceCurrency'] },
  Review: { field: 'reviewRating', sub: ['ratingValue'] },
  JobPosting: { field: 'jobLocation', sub: ['address'] },
};
// Schemas Google has restricted — eligible only in narrow contexts (research/01 #119).
const FORBIDDEN = new Set(['FAQPage', 'HowTo']);

const URL_FIELDS = /^(image|logo|thumbnailurl|contenturl|url)$/i;
const DATE_FIELDS = /^(datepublished|datemodified|startdate|enddate|uploaddate|dateposted|validfrom)$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/;
const CURRENCY_FIELD = /^pricecurrency$/i;
const ISO_4217 = /^[A-Z]{3}$/;            // e.g. USD, GBP, AUD
const PRICE_FIELD = /^price$/i;
const PLAIN_NUMBER = /^\d+(\.\d+)?$/;     // Google requires a bare number — no "$", commas, or "Free"

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

// Value sanity on a node's present fields: absolute URLs (#120), ISO-8601 dates (#121),
// ISO-4217 currency, and bare-number prices. Run on the node AND on nested offer objects
// (price/priceCurrency live inside offers, not at the top level).
function checkValues(obj: Record<string, unknown>, type: string | undefined, issues: SchemaIssue[]): void {
  for (const [k, v] of Object.entries(obj)) {
    if (URL_FIELDS.test(k) && v != null && !urlIsAbsolute(v)) {
      issues.push({ kind: 'value', type, detail: `${k} is not an absolute URL.`, fields: [k] });
    }
    if (DATE_FIELDS.test(k) && typeof v === 'string' && !ISO_DATE.test(v)) {
      issues.push({ kind: 'value', type, detail: `${k} is not ISO-8601 ("${v}").`, fields: [k] });
    }
    if (CURRENCY_FIELD.test(k) && typeof v === 'string' && !ISO_4217.test(v)) {
      issues.push({ kind: 'value', type, detail: `priceCurrency "${v}" is not a 3-letter ISO-4217 code (e.g. USD).`, fields: ['priceCurrency'] });
    }
    if (PRICE_FIELD.test(k) && v != null && typeof v !== 'number' && !(typeof v === 'string' && PLAIN_NUMBER.test(v))) {
      issues.push({ kind: 'value', type, detail: `price "${String(v)}" is not a plain number (no currency symbols or thousands separators).`, fields: ['price'] });
    }
  }
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
        checkValues(off, type, issues); // price/priceCurrency value sanity inside offers
      }
    }
  }

  for (const group of ONE_OF[type] ?? []) {
    if (!group.some(f => node[f] !== undefined && node[f] !== null && node[f] !== '')) {
      issues.push({ kind: 'required', type, detail: `${type} needs at least one of: ${group.join(', ')}.`, fields: group });
    }
  }

  checkValues(node, type, issues);
}

/** Does this node fully satisfy its type's required (incl. nested) fields? */
function fullyComplete(node: Record<string, unknown>, type: string): boolean {
  const required = REQUIRED[type];
  if (!required) return false;
  if (!required.every(f => node[f] !== undefined && node[f] !== null && node[f] !== '')) return false;
  for (const group of ONE_OF[type] ?? []) {
    if (!group.some(f => node[f] !== undefined && node[f] !== null && node[f] !== '')) return false;
  }
  const nested = NESTED_REQUIRED[type];
  if (nested) {
    const fv = node[nested.field];
    if (fv === undefined || fv === null) return false;
    const offers = Array.isArray(fv) ? fv : [fv];
    if (!offers.length) return false;
    for (const off of offers) {
      if (!isObj(off) || !nested.sub.every(s => off[s] !== undefined && off[s] !== null && off[s] !== '')) return false;
    }
  }
  return true;
}

/** Validate the raw `pages.json_ld` column. Returns all issues found across blocks. */
export function validateJsonLdColumn(col: string | null): SchemaIssue[] {
  if (!col) return [];
  const issues: SchemaIssue[] = [];
  let blocks: unknown;
  try { blocks = JSON.parse(col); } catch { return [{ kind: 'parse', detail: 'json_ld column is not valid JSON.' }]; }
  const rawBlocks: string[] = Array.isArray(blocks) ? blocks.filter((b): b is string => typeof b === 'string') : [];

  const allNodes: Record<string, unknown>[] = [];
  for (const raw of rawBlocks) {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { issues.push({ kind: 'parse', detail: 'A JSON-LD block does not parse (check trailing commas / escaped quotes).' }); continue; }
    const nodes: Record<string, unknown>[] = [];
    nodesOf(parsed, nodes);
    allNodes.push(...nodes);
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

  // Type-level dedup: if the page has at least one FULLY-complete node of a type, don't flag a
  // sibling incomplete node of that type for "missing required fields" — Google uses the valid
  // one. (A common WP/RankMath pattern: a complete @graph Article + a second partial Article for
  // entity SEO.) Only suppresses 'required'; parse/context/value/forbidden issues always stand.
  const satisfied = new Set<string>();
  for (const n of allNodes) { const t = typeOf(n); if (t && fullyComplete(n, t)) satisfied.add(t); }
  return satisfied.size ? issues.filter(i => !(i.kind === 'required' && i.type && satisfied.has(i.type))) : issues;
}
