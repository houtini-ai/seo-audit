/**
 * Robots directives (meta robots / X-Robots-Tag) as they apply to Google. One parse for the crawler's
 * indexability verdict and the page extract, so a header scoped to another crawler
 * (`X-Robots-Tag: bingbot: noindex`) doesn't mark a page non-indexable, and `none` (= noindex,
 * nofollow) does. Same scoping rule as snippetRestrictions in audit/checks-signals.ts.
 */

// Directive names that take a value after a colon (so "max-snippet: 0" is not a UA prefix).
const VALUED = new Set(['max-snippet', 'max-image-preview', 'max-video-preview', 'unavailable_after']);

/**
 * The directives in one robots value that apply to Google, lower-cased. In a header a
 * `<user-agent>:` prefix scopes what follows to that crawler; only unscoped or googlebot-scoped
 * directives are returned. A meta value has no scopes (the tag's name is the scope).
 */
export function googleDirectives(value: string | null | undefined, source: 'meta' | 'header'): string[] {
  const out: string[] = [];
  let scope: string | null = null; // null = all crawlers
  for (const raw of (value ?? '').toLowerCase().split(',')) {
    let tok = raw.trim();
    const m = /^([a-z0-9_-]+)\s*:\s*(.*)$/.exec(tok);
    if (m && !VALUED.has(m[1]) && source === 'header') { scope = m[1]; tok = m[2].trim(); }
    if (scope && scope !== 'googlebot') continue;
    if (!tok) continue;
    // "noindex nofollow" / "noindex; nofollow" are written without commas often enough to matter;
    // a valued directive ("max-snippet: 0") stays whole.
    if (/^[a-z0-9_-]+\s*:/.test(tok)) out.push(tok);
    else out.push(...tok.split(/[\s;]+/).filter(Boolean));
  }
  return out;
}

const hasNoindex = (directives: string[]): boolean => directives.some(d => d === 'noindex' || d === 'none');
/** A meta robots (or googlebot) content value that tells Google not to index: `noindex` or `none`. */
export const metaNoindex = (content: string | null | undefined): boolean => hasNoindex(googleDirectives(content, 'meta'));
/** An X-Robots-Tag header that tells Google not to index (unscoped, or scoped to googlebot). */
export const headerNoindex = (xRobotsTag: string | null | undefined): boolean => hasNoindex(googleDirectives(xRobotsTag, 'header'));
