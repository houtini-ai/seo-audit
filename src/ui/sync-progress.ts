import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';

// seo-audit-console refresh is phase-based: gsc → crawl → inspect → ranks → done.
// check_sync_status returns { id, state, startedAt, progress:{phase, rowsFetched, crawled,
// discovered, inspected, periods, siteUrl}, result? }. The opening tool result is
// { jobId, status, siteUrl }. We poll check_sync_status until state != 'running'.

interface JobProgress {
  phase?: string; siteUrl?: string; rowsFetched?: number;
  crawled?: number; discovered?: number; failed?: number; skipped?: number;
  inspected?: number; periods?: number;
}
interface Job {
  id?: string; jobId?: string; state?: string; status?: string;
  startedAt?: string; siteUrl?: string; progress?: JobProgress; result?: any; error?: string;
}

const $ = (id: string): HTMLElement => document.getElementById(id)!;
const PHASES = [
  { key: 'gsc', label: 'Search Console' },
  { key: 'crawl', label: 'Crawl' },
  { key: 'inspect', label: 'URL inspection' },
  { key: 'ranks', label: 'Rank history' },
];

let currentJobId: string | null = null;
let startedAt: number | null = null;
let pollInterval: ReturnType<typeof setInterval> | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;

const app = new App({ name: 'SEO Audit - Sync Progress', version: '0.1.0' });

function applyHostContext(ctx: { theme?: 'light' | 'dark'; styles?: { variables?: Record<string, string> } } | undefined): void {
  if (!ctx) return;
  if (ctx.theme) { applyDocumentTheme(ctx.theme); document.documentElement.classList.toggle('dark', ctx.theme === 'dark'); }
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
}
app.onhostcontextchanged = (ctx) => applyHostContext(ctx as any);

app.ontoolresult = (result: { structuredContent?: Job }) => {
  const r = result.structuredContent;
  if (!r) return;
  currentJobId = r.jobId ?? r.id ?? null;
  if (r.siteUrl) $('site').textContent = extractDomain(r.siteUrl);
  render(r);
  startPolling();
};

// Production-inert preview hook (screenshot harness): render a fixed job, no host/poll.
const __fixture = (window as any).__SYNC_FIXTURE__;
if (__fixture) {
  applyHostContext({ theme: (window as any).__SYNC_THEME__ ?? 'light' });
  currentJobId = __fixture.id ?? __fixture.jobId ?? 'preview';
  if (__fixture.startedAt) startedAt = Date.parse(__fixture.startedAt);
  render(__fixture);
} else {
  app.connect().then(() => applyHostContext(app.getHostContext() as any));
}

function startPolling(): void {
  if (!ticker) ticker = setInterval(() => { if (startedAt) $('elapsed').textContent = formatDuration(Date.now() - startedAt); }, 1000);
  if (pollInterval || !currentJobId) return;
  pollInterval = setInterval(async () => {
    if (!currentJobId) return;
    try {
      const res = await app.callServerTool({ name: 'check_sync_status', arguments: { jobId: currentJobId } });
      if (res?.structuredContent) render(res.structuredContent as Job);
    } catch { /* keep polling */ }
  }, 2000);
}
function stopPolling(): void { if (pollInterval) { clearInterval(pollInterval); pollInterval = null; } if (ticker) { clearInterval(ticker); ticker = null; } }

function render(job: Job): void {
  const state = job.state ?? job.status ?? 'running';
  const p = job.progress ?? {};
  if (job.startedAt && startedAt === null) startedAt = Date.parse(job.startedAt);
  if (job.siteUrl) $('site').textContent = extractDomain(job.siteUrl);
  else if (p.siteUrl) $('site').textContent = extractDomain(p.siteUrl);
  $('job-id').textContent = currentJobId ? `Job ${currentJobId}` : '';

  const badge = $('status-badge');
  badge.textContent = state;
  badge.className = `status-badge ${state}`;
  if (startedAt) $('elapsed').textContent = formatDuration(Date.now() - startedAt);

  const done = state === 'completed' || state === 'failed' || state === 'cancelled';
  const curIdx = done ? PHASES.length : Math.max(0, PHASES.findIndex(ph => ph.key === p.phase));

  // Phase stepper
  $('phases').innerHTML = PHASES.map((ph, i) => {
    const cls = done && state === 'completed' ? 'done' : i < curIdx ? 'done' : i === curIdx ? 'active' : 'pending';
    return `<div class="phase ${cls}"><span class="dot"></span><span class="plabel">${ph.label}</span></div>`;
  }).join('');

  // Active phase detail
  const cur = $('current');
  if (!done && p.phase) {
    cur.style.display = 'block';
    let label = '', count = '', meta = '', pct = -1;
    if (p.phase === 'gsc') { label = 'Fetching Search Console history'; count = `${formatNumber(p.rowsFetched ?? 0)} rows`; }
    else if (p.phase === 'crawl') {
      label = 'Crawling pages'; count = `${p.crawled ?? 0} / ${p.discovered ?? 0}`;
      pct = p.discovered ? Math.min(100, ((p.crawled ?? 0) / p.discovered) * 100) : -1;
      if (p.failed) meta = `${p.failed} failed`;
    } else if (p.phase === 'inspect') { label = 'Inspecting top URLs (GSC, rate-limited)'; count = `${p.inspected ?? 0} inspected`; }
    else if (p.phase === 'ranks') { label = 'Fetching DataForSEO rank history'; count = p.periods ? `${p.periods} periods` : 'fetching…'; }
    $('cur-label').textContent = label;
    $('cur-count').textContent = count;
    $('cur-meta').textContent = meta;
    const fill = $('cur-fill');
    if (pct >= 0) { fill.classList.remove('indeterminate'); fill.style.width = `${pct}%`; }
    else { fill.classList.add('indeterminate'); fill.style.width = '100%'; }
  } else {
    cur.style.display = 'none';
  }

  // Summary on completion
  const sum = $('summary');
  if (done) {
    stopPolling();
    sum.style.display = 'block';
    const r = job.result ?? {};
    if (state === 'failed') {
      sum.innerHTML = `<div class="summary-error">Sync failed${job.error ? `: ${escapeHtml(job.error)}` : ''}</div>`;
    } else {
      const rows = [
        r.gsc ? ['Search Console', `${formatNumber(r.gsc.rowsFetched ?? 0)} rows · ${r.gsc.startDate}–${r.gsc.endDate}`] : null,
        r.crawl ? ['Crawl', `${r.crawl.crawled ?? 0} pages · ${r.crawl.failed ?? 0} failed`] : null,
        r.inspect ? ['URL inspection', `${r.inspect.inspected ?? 0} inspected`] : null,
        r.ranks ? ['Rank history', `${r.ranks.periods ?? 0} periods${r.ranks.cost ? ` · $${r.ranks.cost}` : ''}`] : null,
      ].filter(Boolean) as [string, string][];
      sum.innerHTML = `<div class="summary-done">✓ Refresh complete - run <code>run_audit</code> next.</div>` +
        rows.map(([k, v]) => `<div class="summary-row"><span>${k}</span><span>${escapeHtml(v)}</span></div>`).join('');
    }
  } else {
    sum.style.display = 'none';
  }
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}
function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2).replace(/\.?0+$/, '') + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}
function extractDomain(s: string): string { return s.replace(/^sc-domain:/, '').replace(/^https?:\/\//, '').replace(/\/+$/, ''); }
function escapeHtml(s: string): string { return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string)); }
