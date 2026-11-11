// Opt-in headless-Chromium renderer (Playwright) for the "Response vs Render" tier. Playwright is an
// OPTIONAL dependency: the default install and the HTTP crawler never touch it, and nothing here runs
// unless the user calls render_pages AND has installed the browser. stdio-safe: Playwright talks to
// the browser over a pipe (not stdout), and this module never console.log (the MCP owns stdout for
// JSON-RPC) — any diagnostics go to stderr.

let browserP: Promise<any> | null = null;

// Import through a variable specifier so TypeScript doesn't statically resolve the OPTIONAL dependency
// at build time (it isn't installed in the default build), while runtime import still works when present.
const PLAYWRIGHT = 'playwright';

/** Rendering can't work at all on this install (no `playwright` package, or no browser binary).
 * Distinct from a per-URL failure (timeout, unreachable page), which a batch skips and carries on from. */
export class RendererUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = 'RendererUnavailableError'; }
}

/** True if the optional `playwright` package is importable. Cheap check for graceful degradation.
 * NOT proof that rendering works: npm installs the optional package without its browser, so the
 * launch can still fail, and renderHtml then throws RendererUnavailableError. */
export async function rendererAvailable(): Promise<boolean> {
  try { await import(PLAYWRIGHT); return true; } catch { return false; }
}

/** Launch a headless Chromium, or throw RendererUnavailableError saying what to install. */
async function launchChromium(): Promise<any> {
  let pw: any;
  try {
    pw = await import(PLAYWRIGHT);
  } catch {
    throw new RendererUnavailableError('Rendering needs the optional "playwright" package: run `npm i playwright && npx playwright install chromium`. The rest of the audit works without it (the crawler is HTTP-only by design).');
  }
  try {
    return await pw.chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  } catch (e) {
    throw new RendererUnavailableError(`Playwright is installed but Chromium would not launch — run \`npx playwright install chromium\`. (${e instanceof Error ? e.message.slice(0, 140) : String(e)})`);
  }
}

async function getBrowser(): Promise<any> {
  if (!browserP) {
    browserP = launchChromium();
    // Don't cache a failed launch for the life of the process: once the user installs the browser,
    // the next render_pages call should try again rather than replay the old failure.
    browserP.catch(() => { browserP = null; });
  }
  return browserP;
}

/** Render one URL and return the serialised post-JavaScript DOM as HTML. Reuses one browser process
 * across calls (close it with closeRenderer at the end of a batch). Bounded by `timeoutMs`. */
export async function renderHtml(url: string, ua: string, timeoutMs = 20000): Promise<string> {
  const browser = await getBrowser();
  const ctx = await browser.newContext({ userAgent: ua });
  const page = await ctx.newPage();
  try {
    // networkidle waits for XHR/fetch-driven content to settle — that's the whole point of rendering.
    await page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs });
    return await page.content();
  } finally {
    await ctx.close().catch(() => { /* already gone */ });
  }
}

/**
 * Print an HTML document to an A4 PDF with the optional browser (#79 printable report). The
 * document carries its own @page rules; Playwright adds page numbers in the footer. Uses its OWN
 * browser process, closed when done: sharing render_pages' browser let one close it under the
 * other mid-batch. Throws RendererUnavailableError when Playwright or its browser isn't installed,
 * so the caller can fall back to the HTML file (which prints to PDF from any browser).
 */
export async function pdfFromHtml(html: string, outPath: string, footerLabel: string): Promise<void> {
  const browser = await launchChromium();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await page.setContent(html, { waitUntil: 'networkidle', timeout: 30000 });
    const esc = (s: string): string => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
    await page.pdf({
      path: outPath, format: 'A4', printBackground: true, preferCSSPageSize: true,
      displayHeaderFooter: true, headerTemplate: '<span></span>',
      footerTemplate: `<div style="width:100%;font:8px monospace;color:#6B6B73;padding:0 15mm;display:flex;justify-content:space-between"><span>${esc(footerLabel)}</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`,
    });
  } finally {
    await ctx.close().catch(() => { /* already gone */ });
    await browser.close().catch(() => { /* already gone */ });
  }
}

/** Close the shared render_pages browser process. Safe to call when none was started. */
export async function closeRenderer(): Promise<void> {
  if (browserP) {
    try { (await browserP).close(); } catch { /* already closed / never launched */ }
    browserP = null;
  }
}
