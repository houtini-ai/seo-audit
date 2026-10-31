// Bounded response-body reads. `await res.arrayBuffer()` / `res.text()` buffer whatever the server
// sends: one 50 MB page (or a gzip sitemap that inflates to gigabytes) exhausted the heap and took
// the whole MCP process down with every other job in it. Every fetch of a third-party or crawled
// body reads through here instead, and says when it stopped early (no silent caps).

/**
 * HTML read per page: 5 MB. Extraction (cheerio + text chunks) costs roughly 70x the HTML size in
 * memory (5 MB of text measured ~350 MB; 15 MB ~1.4 GB), and the crawler extracts several pages at
 * once, so Googlebot's own 15 MB limit is too much to hold. A larger page is read and extracted up
 * to 5 MB and recorded as truncated; real pages that size are rare and already a large-html finding.
 */
export const MAX_HTML_BYTES = 5 * 1024 * 1024;
/** The sitemaps.org limit for one sitemap file, uncompressed. */
export const MAX_SITEMAP_BYTES = 50 * 1024 * 1024;
/** Google processes the first 500 KiB of robots.txt. */
export const MAX_ROBOTS_BYTES = 500 * 1024;

export interface CappedBody {
  buf: Buffer;
  /** True when the body was longer than the cap and the rest was not read. */
  truncated: boolean;
}

/** Read at most `maxBytes` of a fetch Response body, then cancel the stream. */
export async function readCapped(res: { body: ReadableStream<Uint8Array> | null }, maxBytes: number): Promise<CappedBody> {
  if (!res.body) return { buf: Buffer.alloc(0), truncated: false };
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      const room = maxBytes - total;
      if (value.byteLength > room) {
        if (room > 0) chunks.push(Buffer.from(value.buffer, value.byteOffset, room));
        total += Math.max(room, 0);
        truncated = true;
        break;
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      total += value.byteLength;
    }
  } finally {
    if (truncated) { try { await reader.cancel(); } catch { /* already closed */ } }
    else { try { reader.releaseLock(); } catch { /* released */ } }
  }
  return { buf: Buffer.concat(chunks, total), truncated };
}

/** readCapped decoded as UTF-8. */
export async function readCappedText(res: { body: ReadableStream<Uint8Array> | null }, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const { buf, truncated } = await readCapped(res, maxBytes);
  return { text: buf.toString('utf8'), truncated };
}
