/**
 * Shared SQL fragments. There is exactly ONE definition of "is this page HTML" in SQL —
 * keep it aligned with the runtime helper `isHtmlContentType` in Crawler.ts.
 */
export const HTML_CT = `(LOWER(content_type) LIKE 'text/html%' OR LOWER(content_type) LIKE 'application/xhtml+xml%')`;
