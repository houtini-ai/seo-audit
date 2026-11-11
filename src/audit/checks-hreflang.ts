/**
 * #55 summary slice 4, group C, item 6: cross-host canonicals and hreflang validation.
 *   - canonical-cross-host          the declared canonical points at another host
 *   - hreflang-invalid-code         an hreflang value Google can't read
 *   - hreflang-missing-self         a page's hreflang set leaves the page itself out
 *   - hreflang-duplicate-locale     one locale mapped to two URLs in a page's set
 *   - hreflang-canonical-conflict   hreflang on, or pointing at, a page canonicalised elsewhere
 *   (and the extensions of the existing broken-hreflang-target and hreflang-no-return-tag, which
 *   moved here from checks.ts so all hreflang checks share one parse)
 *
 * Data: `pages` (latest crawl: url_key, status, canonical_key, hreflang JSON [{lang, href}] with
 * absolute hrefs), `redirect_sources` and `property_meta.host_form`. Same contract as checks.ts: a
 * pure read, deterministic, thresholds stated, missing data = no finding. A rate-limited URL
 * (fetch_state='rate_limited', or a legacy stored 429/503) is unknown, never broken.
 * Reference: https://developers.google.com/search/docs/specialty/international/localized-versions
 */
import type Database from 'better-sqlite3';
import type { CheckContext, CheckDef, RawFinding } from './checks.js';
import { urlKey } from '../core/url-key.js';
import { isInternalHost } from '../core/extract.js';
import { HTML_CT } from '../core/sql.js';
import { equityLookup, equityWeight, EQUITY_RULE, type Equity } from './checks-redirects.js';

const rows = (c: CheckContext, sql: string, ...args: unknown[]): any[] => c.db.prepare(sql).all(...args);
const one = (c: CheckContext, sql: string, ...args: unknown[]): any => c.db.prepare(sql).get(...args);
const hostOf = (u: string | null | undefined): string | null => { try { return u ? new URL(u).hostname.toLowerCase() : null; } catch { return null; } };

// ── hreflang value validation ────────────────────────────────────────────────────────────────
// Google reads `x-default`, or a language (ISO 639-1, two letters) optionally followed by a region
// (ISO 3166-1 alpha-2), hyphen-separated, case-insensitive. A four-letter script subtag (ISO 15924,
// e.g. zh-Hant) is accepted so it is never a false positive. Membership comes from the platform's
// ICU data (Intl.DisplayNames with fallback 'none' = unknown code), not a hand-kept list.
const LANG_NAMES = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' });
const REGION_NAMES = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });
/** Codes ICU names that are not ISO 3166-1 assigned country codes: unknown region, and the exceptionally reserved EU / UN / EZ. */
const NOT_COUNTRIES = new Set(['ZZ', 'EU', 'UN', 'EZ']);
const named = (dn: Intl.DisplayNames, code: string): boolean => { try { return dn.of(code) !== undefined; } catch { return false; } };
const canonical = (tag: string): string | null => { try { return Intl.getCanonicalLocales(tag)[0] ?? null; } catch { return null; } };

/** Why a stored hreflang value is invalid, or null when Google can read it. */
export function hreflangCodeProblem(raw: string): string | null {
  const v = (raw ?? '').trim();
  if (!v) return 'empty value';
  if (v.toLowerCase() === 'x-default') return null;
  if (v.includes('_')) return 'underscore separator (use a hyphen, e.g. en-GB)';
  if (!canonical(v)) return 'not a valid language tag';
  const parts = v.split('-');
  const lang = parts[0];
  if (!/^[a-z]{2}$/i.test(lang)) return `language "${lang}" is not a two-letter ISO 639-1 code`;
  if (!named(LANG_NAMES, lang.toLowerCase())) return `unknown language code "${lang}"`;
  const langCanon = canonical(lang.toLowerCase());
  if (langCanon && langCanon !== lang.toLowerCase()) return `deprecated language code "${lang}" (use "${langCanon}")`;
  let i = 1;
  if (parts[i] && /^[a-z]{4}$/i.test(parts[i])) i++; // script subtag
  const region = parts[i];
  if (region !== undefined) {
    if (!/^[a-z]{2}$/i.test(region)) return `region "${region}" is not a two-letter ISO 3166-1 alpha-2 code`;
    const R = region.toUpperCase();
    if (NOT_COUNTRIES.has(R) || !named(REGION_NAMES, R)) return `"${region}" is not an ISO 3166-1 country code`;
    const regCanon = canonical(`und-${R}`)?.split('-')[1];
    if (regCanon && regCanon !== R) return `"${region}" is not the ISO 3166-1 code (use "${regCanon}")`;
    i++;
  }
  if (parts.length > i) return `unexpected subtag "${parts[i]}" (Google reads language and region only)`;
  return null;
}

// ── Shared parse: every page's hreflang set, resolved to url_keys, plus target state ─────────────
interface Alt { lang: string; href: string; key: string | null } // key null = unparseable href
interface HreflangPage { key: string; url: string; canonicalKey: string | null; alts: Alt[] }
interface TargetState { status: number | null; noindex: number | null; reason: string | null; canonicalKey: string | null; unknown: boolean }
interface HreflangData {
  pages: HreflangPage[];
  /** Latest-crawl state per url_key; `unknown` = rate-limited or a legacy stored 429/503. */
  state: Map<string, TargetState>;
  /** url_key of a URL that redirected in the latest crawl → where it ended. */
  redirects: Map<string, { finalKey: string | null; status: number | null }>;
  /** Each page's declared alternate keys (self included), for return-tag lookups. */
  declared: Map<string, Set<string>>;
}
let _cache: { db: Database.Database; data: HreflangData } | null = null;

/**
 * Parsed once per DB. Stored hrefs may be absolute or raw (older crawls), so each is resolved against
 * the page URL and url_key'd with the property's host_form so it joins pages.url_key.
 */
export function hreflangData(c: CheckContext): HreflangData {
  if (_cache && _cache.db === c.db) return _cache.data;
  const hostForm = (one(c, `SELECT host_form h FROM property_meta LIMIT 1`)?.h ?? 'asis') as 'apex' | 'www' | 'asis';
  const pages: HreflangPage[] = [];
  const declared = new Map<string, Set<string>>();
  for (const p of rows(c, `SELECT url_key, url, canonical_key, hreflang FROM pages WHERE hreflang IS NOT NULL AND hreflang <> '' AND hreflang <> '[]'`)) {
    let arr: unknown;
    try { arr = JSON.parse(p.hreflang); } catch { continue; }
    if (!Array.isArray(arr)) continue;
    const alts: Alt[] = [];
    for (const a of arr as { lang?: unknown; href?: unknown }[]) {
      const lang = typeof a?.lang === 'string' ? a.lang : '';
      const href = typeof a?.href === 'string' ? a.href : '';
      if (!href) continue;
      let key: string | null = null;
      try { key = urlKey(new URL(href, p.url).toString(), { hostForm }); } catch { /* unparseable */ }
      alts.push({ lang, href, key });
    }
    if (!alts.length) continue;
    pages.push({ key: p.url_key, url: p.url, canonicalKey: p.canonical_key ?? null, alts });
    declared.set(p.url_key, new Set(alts.map(a => a.key).filter((k): k is string => !!k)));
  }
  const state = new Map<string, TargetState>();
  for (const p of rows(c, `SELECT url_key, status_code, noindex, indexable_reason, canonical_key, fetch_state FROM pages`)) {
    const unknown = p.fetch_state === 'rate_limited' || p.status_code === 429 || p.status_code === 503 || p.status_code == null;
    state.set(p.url_key, { status: p.status_code, noindex: p.noindex, reason: p.indexable_reason ?? null, canonicalKey: p.canonical_key ?? null, unknown });
  }
  const redirects = new Map<string, { finalKey: string | null; status: number | null }>();
  if (one(c, `SELECT 1 FROM sqlite_master WHERE type='table' AND name='redirect_sources'`))
    for (const r of rows(c, `SELECT url_key, final_key, status FROM redirect_sources`)) redirects.set(r.url_key, { finalKey: r.final_key ?? null, status: r.status ?? null });
  const data = { pages, state, redirects, declared };
  _cache = { db: c.db, data };
  return data;
}
/** A crawled, known target that canonicalises to a different URL. */
const canonicalisedElsewhere = (s: TargetState | undefined, key: string): boolean => !!s && !s.unknown && s.status === 200 && !!s.canonicalKey && s.canonicalKey !== key;

// ── broken-hreflang-target (existing, extended) ──────────────────────────────────────────────
/**
 * An alternate that is 4xx/5xx, noindex, or (new) a URL that redirected in the latest crawl. Pages
 * are keyed by the FINAL url, so a redirecting alternate is never a pages row of its own: before,
 * those were silently skipped although the fix text named redirects. Also new: a legacy stored
 * 429/503 is unknown, like a rate-limited fetch, not broken. Uncrawled (e.g. other-domain) targets
 * are unknown and skipped.
 */
function brokenHreflangTarget(c: CheckContext): RawFinding[] {
  const d = hreflangData(c);
  const out: RawFinding[] = [];
  for (const p of d.pages) {
    const bad: { href: string; lang: string; reason: string; finalKey?: string | null }[] = [];
    const seen = new Set<string>();
    for (const a of p.alts) {
      if (!a.key || a.key === p.key || seen.has(a.key)) continue;
      seen.add(a.key);
      const st = d.state.get(a.key);
      if (st) {
        if (st.unknown) continue;
        if (st.status !== 200) bad.push({ href: a.href, lang: a.lang, reason: st.status! >= 300 && st.status! < 400 ? `unresolved redirect (${st.status})` : `http-${st.status}` });
        else if (st.noindex === 1) bad.push({ href: a.href, lang: a.lang, reason: 'noindex' });
      } else {
        const r = d.redirects.get(a.key);
        if (r && r.finalKey !== a.key) bad.push({ href: a.href, lang: a.lang, reason: `redirects (${r.status ?? '3xx'})`, finalKey: r.finalKey });
      }
    }
    if (bad.length) out.push({ urlKey: p.key, evidence: { brokenAlternates: bad.slice(0, 10).map(b => b.href), count: bad.length, alternates: bad.slice(0, 10) } });
  }
  return out;
}

// ── hreflang-no-return-tag (existing, extended) ──────────────────────────────────────────────
/**
 * A live, indexable, crawled alternate whose own hreflang set doesn't link back. x-default is not a
 * reciprocation requirement (but a return link via x-default counts). Extended: an alternate that
 * canonicalises elsewhere is hreflang-canonical-conflict's finding, not a missing return tag.
 */
function hreflangNoReturnTag(c: CheckContext): RawFinding[] {
  const d = hreflangData(c);
  const out: RawFinding[] = [];
  for (const p of d.pages) {
    if (canonicalisedElsewhere(d.state.get(p.key), p.key)) continue; // its set is ignored: hreflang-canonical-conflict
    const missing = new Set<string>();
    for (const a of p.alts) {
      if (!a.key || a.key === p.key || a.lang.toLowerCase() === 'x-default') continue;
      const st = d.state.get(a.key);
      if (!st || st.unknown || st.status !== 200 || st.noindex === 1) continue; // broken or unknown: not this check's
      if (canonicalisedElsewhere(st, a.key)) continue;
      if (!d.declared.get(a.key)?.has(p.key)) missing.add(a.key);
    }
    if (missing.size) out.push({ urlKey: p.key, evidence: { missingReturnFrom: [...missing].slice(0, 10), count: missing.size } });
  }
  return out;
}

// ── canonical-cross-host ─────────────────────────────────────────────────────────────────────
/**
 * A 200 HTML page whose declared canonical (resolved against the page URL) names a different host.
 * Not cross-host: the www/apex twin of the page's host, and an http->https (or reverse) switch on the
 * same host; scheme is ignored here (broken-canonical-target owns the HTTPS->HTTP downgrade).
 * Findings with equity (the redirect checks' rule) are listed first; the engine prices each one by
 * the page's own GSC traffic.
 */
function canonicalCrossHost(c: CheckContext): RawFinding[] {
  const equity = equityLookup(c);
  const out: RawFinding[] = [];
  for (const p of rows(c, `SELECT url_key urlKey, url, canonical_url canon FROM pages
      WHERE status_code = 200 AND ${HTML_CT} AND canonical_url IS NOT NULL AND canonical_url <> '' AND COALESCE(fetch_state,'') <> 'rate_limited'`)) {
    let canonUrl: URL;
    try { canonUrl = new URL(p.canon, p.url); } catch { continue; }
    if (canonUrl.protocol !== 'http:' && canonUrl.protocol !== 'https:') continue;
    const pageHost = hostOf(p.url);
    const canonHost = canonUrl.hostname.toLowerCase();
    if (!pageHost || canonHost === pageHost || isInternalHost(canonHost, pageHost)) continue;
    const eq = equity(p.urlKey);
    out.push({ urlKey: p.urlKey, evidence: { url: p.url, canonical: canonUrl.toString(), pageHost, canonicalHost: canonHost, equity: eq, hasEquity: eq.hasEquity, rule: EQUITY_RULE,
      note: 'the canonical hands indexing to another host' + (eq.hasEquity ? '; this page has search traffic or links' : '') } });
  }
  return out.sort((a, b) => equityWeight(b.evidence.equity as Equity) - equityWeight(a.evidence.equity as Equity));
}

// ── New hreflang checks ──────────────────────────────────────────────────────────────────────
/** Only pages that answered 200 and are not canonicalised elsewhere are judged on their own set. */
const judgeable = (d: HreflangData, p: HreflangPage): boolean => {
  const st = d.state.get(p.key);
  return !!st && !st.unknown && st.status === 200 && !canonicalisedElsewhere(st, p.key);
};

function hreflangInvalidCode(c: CheckContext): RawFinding[] {
  const d = hreflangData(c);
  const out: RawFinding[] = [];
  for (const p of d.pages) {
    const st = d.state.get(p.key);
    if (!st || st.unknown || st.status !== 200) continue;
    const bad = new Map<string, string>();
    for (const a of p.alts) { const why = hreflangCodeProblem(a.lang); if (why && !bad.has(a.lang)) bad.set(a.lang, why); }
    if (bad.size) out.push({ urlKey: p.key, evidence: { invalid: [...bad].slice(0, 10).map(([value, problem]) => ({ value, problem })), count: bad.size, annotations: p.alts.length } });
  }
  return out;
}

function hreflangMissingSelf(c: CheckContext): RawFinding[] {
  const d = hreflangData(c);
  const out: RawFinding[] = [];
  for (const p of d.pages) {
    if (!judgeable(d, p)) continue;
    if (p.alts.some(a => a.key === p.key)) continue;
    out.push({ urlKey: p.key, evidence: { url: p.url, annotations: p.alts.length, declared: p.alts.slice(0, 10).map(a => ({ lang: a.lang, href: a.href })) } });
  }
  return out;
}

/**
 * A real language cluster (2+ distinct alternates besides the page) with no x-default. Google RECOMMENDS
 * x-default (it names the page for users whose language matches no listed locale); it isn't required,
 * so this is low severity and reported without spamming:
 *   - no cluster on the site uses x-default -> ONE site-level finding (a template decision), with a count and sample;
 *   - some clusters use it and some don't -> per-page findings for the ones that don't (an inconsistency).
 */
function hreflangMissingXDefault(c: CheckContext): RawFinding[] {
  const d = hreflangData(c);
  const clusters = d.pages.filter(p => judgeable(d, p) && new Set(p.alts.filter(a => a.key && a.key !== p.key && a.lang.toLowerCase() !== 'x-default').map(a => a.key)).size >= 2);
  if (!clusters.length) return [];
  const hasX = (p: HreflangPage): boolean => p.alts.some(a => a.lang.trim().toLowerCase() === 'x-default');
  const without = clusters.filter(p => !hasX(p));
  if (!without.length) return [];
  if (without.length === clusters.length)
    return [{ urlKey: null, evidence: { scope: 'site', clusterPages: clusters.length, withXDefault: 0, sample: without.slice(0, 5).map(p => p.url), note: 'no hreflang set on the site declares x-default' } }];
  return without.map(p => ({ urlKey: p.key, evidence: { url: p.url, annotations: p.alts.length, siteClustersWithXDefault: clusters.length - without.length, note: 'other hreflang sets on the site declare x-default; this one does not' } }));
}

/** Same value (case-insensitive) mapped to two different URLs in one page's set. The same URL twice is harmless. */
function hreflangDuplicateLocale(c: CheckContext): RawFinding[] {
  const d = hreflangData(c);
  const out: RawFinding[] = [];
  for (const p of d.pages) {
    if (!judgeable(d, p)) continue;
    const byLang = new Map<string, Set<string>>();
    for (const a of p.alts) {
      if (!a.key) continue;
      const l = a.lang.trim().toLowerCase();
      (byLang.get(l) ?? byLang.set(l, new Set()).get(l)!).add(a.key);
    }
    const dups = [...byLang].filter(([, s]) => s.size > 1).map(([lang, s]) => ({ lang, urls: [...s].slice(0, 5) }));
    if (dups.length) out.push({ urlKey: p.key, evidence: { duplicates: dups.slice(0, 10), count: dups.length } });
  }
  return out;
}

/**
 * Two shapes: the page carrying the hreflang set is itself canonicalised to another URL (Google
 * ignores annotations on a non-canonical page), or a crawled 200 alternate canonicalises elsewhere.
 * A 4xx/5xx, noindex or redirecting alternate is broken-hreflang-target's, not this check's.
 */
function hreflangCanonicalConflict(c: CheckContext): RawFinding[] {
  const d = hreflangData(c);
  const out: RawFinding[] = [];
  for (const p of d.pages) {
    const own = d.state.get(p.key);
    if (!own || own.unknown || own.status !== 200) continue;
    if (canonicalisedElsewhere(own, p.key)) {
      out.push({ urlKey: p.key, evidence: { kind: 'page-canonicalised', canonical: own.canonicalKey, annotations: p.alts.length,
        note: 'this page declares hreflang but canonicalises to another URL, so Google ignores its annotations' } });
      continue;
    }
    const conflicts: { lang: string; href: string; canonicalisesTo: string | null }[] = [];
    const seen = new Set<string>();
    for (const a of p.alts) {
      if (!a.key || a.key === p.key || seen.has(a.key)) continue;
      seen.add(a.key);
      const st = d.state.get(a.key);
      if (canonicalisedElsewhere(st, a.key)) conflicts.push({ lang: a.lang, href: a.href, canonicalisesTo: st!.canonicalKey });
    }
    if (conflicts.length) out.push({ urlKey: p.key, evidence: { kind: 'alternate-canonicalised', alternates: conflicts.slice(0, 10), count: conflicts.length,
      note: 'hreflang alternates must be the canonical URLs; these alternates canonicalise elsewhere' } });
  }
  return out;
}

const LOCALIZED_DOCS = 'https://developers.google.com/search/docs/specialty/international/localized-versions';

/** The two pre-existing hreflang checks (ids, titles and labels unchanged), now backed by this module. */
export const HREFLANG_EXISTING_CHECKS: CheckDef[] = [
  {
    id: 'broken-hreflang-target', category: 'indexation', severity: 'high', labels: ['D'], certainty: 1, effortBase: 3, fixType: 'per-page',
    title: 'hreflang points to a broken/non-indexable URL', fix: 'Point each hreflang alternate at a live, indexable URL — Google drops the whole cluster if an alternate is 4xx/5xx/redirect/noindex.',
    run: brokenHreflangTarget,
  },
  {
    id: 'hreflang-no-return-tag', category: 'indexation', severity: 'high', labels: ['D'], certainty: 1, effortBase: 3, fixType: 'per-page',
    title: 'hreflang missing return tag (not reciprocated)', fix: 'Add the reciprocal hreflang on the target page — Google ignores one-way hreflang annotations that don’t link back.',
    run: hreflangNoReturnTag,
  },
];

export const HREFLANG_CHECKS: CheckDef[] = [
  {
    id: 'canonical-cross-host', category: 'indexation', severity: 'high', labels: ['D'], certainty: 1, effortBase: 3, fixType: 'per-page',
    title: 'Canonical points to a different host',
    fix: 'The canonical names another host (an old domain, a staging or CDN hostname, a sister site), so Google may index that host\'s URL instead of this one. www/apex twins and http/https switches are not counted. If this page should rank, make the canonical self-referencing on this host; if the move is real, redirect instead. Pages with search traffic or links are listed first.',
    run: canonicalCrossHost,
  },
  {
    id: 'hreflang-invalid-code', category: 'indexation', severity: 'med', labels: ['D'], certainty: 1, effortBase: 1, fixType: 'per-page',
    title: 'hreflang value Google cannot read',
    fix: `Google reads x-default, or a two-letter ISO 639-1 language optionally followed by an ISO 3166-1 alpha-2 region, hyphenated (en, en-GB, pt-BR); an invalid value drops that annotation. Common errors: en-uk (use en-GB), en_US (hyphen, not underscore), three-letter languages, es-419 or en-EU (not country codes). Codes are checked against the platform's ICU data. ${LOCALIZED_DOCS}`,
    run: hreflangInvalidCode,
  },
  {
    id: 'hreflang-missing-self', category: 'indexation', severity: 'med', labels: ['D'], certainty: 1, effortBase: 1, fixType: 'per-page',
    title: 'hreflang set does not list the page itself',
    fix: `Each language version must list itself as well as its alternates. Add a self-referencing hreflang (with the page's own canonical URL) to this page's set; usually one template change. Pages canonicalised elsewhere are reported by hreflang-canonical-conflict instead. ${LOCALIZED_DOCS}`,
    run: hreflangMissingSelf,
  },
  {
    id: 'hreflang-missing-x-default', category: 'indexation', severity: 'low', labels: ['D'], certainty: 1, effortBase: 1, fixType: 'global',
    title: 'hreflang set has no x-default',
    fix: `Add an x-default alternate to each hreflang set, pointing at the page for users whose language matches none of your locales (usually a language picker or the main-market page). Google recommends it but does not require it, so this is low priority unless the site uses it on some sets and not others. ${LOCALIZED_DOCS}`,
    run: hreflangMissingXDefault,
  },
  {
    id: 'hreflang-duplicate-locale', category: 'indexation', severity: 'med', labels: ['D'], certainty: 1, effortBase: 1, fixType: 'per-page',
    title: 'One hreflang locale mapped to two URLs',
    fix: 'The same language/region value points at two different URLs in this page\'s set, so Google can\'t tell which one serves that locale. Keep one URL per value (case-insensitive); give each other version its own locale code. The same URL listed twice is not counted.',
    run: hreflangDuplicateLocale,
  },
  {
    id: 'hreflang-canonical-conflict', category: 'indexation', severity: 'high', labels: ['D'], certainty: 1, effortBase: 3, fixType: 'per-page',
    title: 'hreflang and canonical disagree',
    fix: `Either the page declaring hreflang canonicalises to another URL (Google ignores annotations on a non-canonical page), or an alternate it lists canonicalises elsewhere. hreflang must connect canonical URLs: point each alternate at its canonical, and make every locale page self-canonical (never canonicalise one locale to another). Broken, noindex or redirecting alternates are reported by broken-hreflang-target. ${LOCALIZED_DOCS}`,
    run: hreflangCanonicalConflict,
  },
];
