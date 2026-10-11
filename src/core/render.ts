// Opt-in headless-Chromium renderer (Playwright) for the "Response vs Render" tier. Playwright is an
// OPTIONAL dependency: the default install and the HTTP crawler never touch it, and nothing here runs
// unless the user calls render_pages AND has installed the browser. stdio-safe: Playwright talks to
// the browser over a pipe (not stdout), and this module never console.log (the MCP owns stdout for
// JSON-RPC) — any diagnostics go to stderr.

let browserP: Promise<any> | null = null;

// Import through a variable specifier so TypeScript doesn't statically resolve the OPTIONAL dependency
// at build time (it isn't installed in the default build), while runtime import still works when present.
const PLAYWRIGHT = 'playwright';

/** True if the optional `playwright` package is importable. Cheap check for graceful degradation. */
export async function rendererAvailable(): Promise<boolean> {
  try { await import(PLAYWRIGHT); return true; } catch { return false; }
}

async function getBrowser(): Promise<any> {
  if (!browserP) {
    browserP = (async () => {
      let pw: any;
      try {
        pw = await import(PLAYWRIGHT);
      } catch {
        throw new Error('Rendering needs the optional "playwright" package: run `npm i playwright && npx playwright install chromium`. The rest of the audit works without it (the crawler is HTTP-only by design).');
      }
      try {
        return await pw.chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
      } catch (e) {
        throw new Error(`Playwright is installed but Chromium would not launch — run \`npx playwright install chromium\`. (${e instanceof Error ? e.message.slice(0, 140) : String(e)})`);
      }
    })();
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

/** Close the shared browser process. Safe to call when none was started. */
export async function closeRenderer(): Promise<void> {
  if (browserP) {
    try { (await browserP).close(); } catch { /* already closed / never launched */ }
    browserP = null;
  }
}
