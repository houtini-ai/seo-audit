import { App, applyDocumentTheme, applyHostStyleVariables, type McpUiStyles } from '@modelcontextprotocol/ext-apps';

// seo-audit-console refresh is phase-based: gsc → crawl → inspect → ranks → done.
// check_sync_status returns { id, state, startedAt, progress:{phase, rowsFetched, crawled,
// discovered, inspected, periods, siteUrl}, result? }. The opening tool result is
// { jobId, status, siteUrl }. We poll check_sync_status until the job finishes. With the job
// runner (#56) it starts as 'queued' (note says whether a runner is there) before 'running'.

interface JobProgress {
  phase?: string; siteUrl?: string; rowsFetched?: number;
  crawled?: number; discovered?: number; failed?: number; skipped?: number;
  inspected?: number; periods?: number;
  done?: number; total?: number; // CrUX phase (CruxSync emits these)
}
interface Job {
  id?: string; jobId?: string; state?: string; status?: string;
  startedAt?: string; siteUrl?: string; progress?: JobProgress; result?: any;
  /** A failed job's reason; on a status reply with no job at all, a code such as 'not_found'. */
  error?: string;
  /** A queued job's status line: waiting for the job runner, or that none seems to be running. */
  note?: string;
}

const $ = (id: string): HTMLElement => document.getElementById(id)!;
const PHASES = [
  { key: 'gsc', label: 'Search Console' },
  { key: 'crawl', label: 'Crawl' },
  { key: 'inspect', label: 'URL inspection' },
  { key: 'ranks', label: 'Rank history' },
  { key: 'crux', label: 'CrUX field data' },
];

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const LIVE = new Set(['running', 'queued']);
const stateOf = (job: Job): string => job.state ?? job.status ?? 'unknown';
/** Poll only a job that can still change. */
const pollable = (job: Job): boolean => LIVE.has(stateOf(job));

let currentJobId: string | null = null;
let pollFailures = 0;
let startedAt: number | null = null;
let pollInterval: ReturnType<typeof setInterval> | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;

const app = new App({ name: 'SEO Audit - Sync Progress', version: '0.1.0' });

function applyHostContext(ctx: { theme?: 'light' | 'dark'; styles?: { variables?: McpUiStyles } } | undefined): void {
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
  // refresh_property with nothing to run starts no job: say so, and don't wait on one.
  if ((r.status === 'noop' && !r.state) || !currentJobId) {
    renderStopped('nothing to run', 'No job was started: every phase is switched off or has no credentials configured. Ask Claude what is set up.', false);
    return;
  }
  render(r);
  if (pollable(r)) startPolling();
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
      const sc = res?.structuredContent as Job | undefined;
      if (res?.isError || !sc) { pollFailed(); return; }
      pollFailures = 0;
      // No such job (the server restarted, or the registry was pruned): it will never be found again.
      if (!sc.state && !sc.status && sc.error) {
        renderStopped('unknown', `The server no longer knows job ${currentJobId}${sc.error === 'not_found' ? '' : ` (${sc.error})`}: it may have restarted. Ask Claude for the property's current status.`, true);
        return;
      }
      render(sc);
    } catch { pollFailed(); }
  }, 2000);
}
/** A poll that can't be answered is retried; after a minute of nothing but failures, stop and say so. */
function pollFailed(): void {
  if (++pollFailures < 30) return;
  renderStopped('unknown', 'Lost contact with the server, so this job\'s progress can no longer be read. Ask Claude for its status.', true);
}
function stopPolling(): void { if (pollInterval) { clearInterval(pollInterval); pollInterval = null; } if (ticker) { clearInterval(ticker); ticker = null; } }

/** A final panel with no job behind it (nothing was started, or the job can't be read any more). */
function renderStopped(badgeText: string, message: string, isError: boolean): void {
  stopPolling();
  const badge = $('status-badge');
  badge.textContent = badgeText;
  badge.className = `status-badge ${isError ? 'interrupted' : 'idle'}`;
  $('job-id').textContent = currentJobId ? `Job ${currentJobId}` : '';
  $('phases').innerHTML = PHASES.map(ph => `<div class="phase pending"><span class="dot"></span><span class="plabel">${ph.label}</span></div>`).join('');
  $('current').style.display = 'none';
  const sum = $('summary');
  sum.style.display = 'block';
  sum.innerHTML = `<div class="${isError ? 'summary-error' : 'summary-note'}">${escapeHtml(message)}</div>`;
}

/** How each phase ended, from the finished job: its result names what ran, what was skipped (and
 *  why) and what failed. With no result (a failed job), the last phase reached is where it stopped. */
function phaseOutcomes(job: Job, state: string): { cls: string; note: string }[] {
  const r = job.result && typeof job.result === 'object' ? job.result : null;
  const reached = PHASES.findIndex(ph => ph.key === job.progress?.phase);
  return PHASES.map((ph, i) => {
    if (r) {
      if (r[`${ph.key}Error`]) return { cls: 'failed', note: `failed: ${String(r[`${ph.key}Error`])}` };
      if (r[`${ph.key}Skipped`]) return { cls: 'skipped', note: `skipped: ${String(r[`${ph.key}Skipped`])}` };
      if (r[ph.key]) return { cls: 'done', note: '' };
      return { cls: 'pending', note: Array.isArray(r.phases) ? 'not run' : '' };
    }
    if (reached < 0) return { cls: 'pending', note: '' };
    if (i < reached) return { cls: 'done', note: '' };
    if (i === reached) return state === 'completed' ? { cls: 'done', note: '' } : state === 'cancelled' ? { cls: 'skipped', note: 'cancelled during this phase' } : { cls: 'failed', note: state };
    return { cls: 'pending', note: '' };
  });
}

function render(job: Job): void {
  const state = stateOf(job);
  // A state this widget doesn't know can't be waited on: show it and stop.
  if (!TERMINAL.has(state) && !LIVE.has(state)) {
    renderStopped(state, `The job reports the state "${state}", which this view can't follow. Ask Claude for its status.`, true);
    return;
  }
  const p = job.progress ?? {};
  if (job.startedAt && startedAt === null) startedAt = Date.parse(job.startedAt);
  if (job.siteUrl) $('site').textContent = extractDomain(job.siteUrl);
  else if (p.siteUrl) $('site').textContent = extractDomain(p.siteUrl);
  $('job-id').textContent = currentJobId ? `Job ${currentJobId}` : '';

  const badge = $('status-badge');
  badge.textContent = state;
  badge.className = `status-badge ${state}`;
  if (startedAt) $('elapsed').textContent = formatDuration(Date.now() - startedAt);

  const done = TERMINAL.has(state);
  const outcomes = done ? phaseOutcomes(job, state) : [];
  const curIdx = done ? PHASES.length : state === 'queued' ? -1 : Math.max(0, PHASES.findIndex(ph => ph.key === p.phase));

  // Phase stepper
  $('phases').innerHTML = PHASES.map((ph, i) => {
    const cls = done ? outcomes[i].cls : i < curIdx ? 'done' : i === curIdx ? 'active' : 'pending';
    return `<div class="phase ${cls}"${done && outcomes[i].note ? ` title="${escapeHtml(outcomes[i].note)}"` : ''}><span class="dot"></span><span class="plabel">${ph.label}</span></div>`;
  }).join('');

  // Active phase detail
  const cur = $('current');
  if (state === 'queued') {
    cur.style.display = 'block';
    $('cur-label').textContent = 'Queued: waiting for the job runner';
    $('cur-count').textContent = '';
    // The default note just repeats the label; anything longer is the "no runner" advice.
    $('cur-meta').textContent = job.note && job.note !== 'waiting for the job runner' ? job.note : '';
    const fill = $('cur-fill');
    fill.classList.add('indeterminate'); fill.style.width = '100%';
  } else if (!done && p.phase) {
    cur.style.display = 'block';
    let label = '', count = '', meta = '', pct = -1;
    if (p.phase === 'gsc') { label = 'Fetching Search Console history'; count = `${formatNumber(p.rowsFetched ?? 0)} rows`; }
    else if (p.phase === 'crawl') {
      label = 'Crawling pages'; count = `${p.crawled ?? 0} / ${p.discovered ?? 0}`;
      pct = p.discovered ? Math.min(100, ((p.crawled ?? 0) / p.discovered) * 100) : -1;
      if (p.failed) meta = `${p.failed} failed`;
    } else if (p.phase === 'inspect') { label = 'Inspecting top URLs (GSC, rate-limited)'; count = `${p.inspected ?? 0} inspected`; }
    else if (p.phase === 'ranks') { label = 'Fetching DataForSEO rank history'; count = p.periods ? `${p.periods} periods` : 'fetching…'; }
    else if (p.phase === 'crux') { label = 'Fetching CrUX field data (Core Web Vitals)'; count = p.total ? `${p.done ?? 0} / ${p.total}` : 'starting…'; pct = p.total ? Math.min(100, ((p.done ?? 0) / p.total) * 100) : -1; }
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
    const rows = [
      r.gsc ? ['Search Console', `${formatNumber(r.gsc.rowsFetched ?? 0)} rows · ${r.gsc.startDate}–${r.gsc.endDate}`] : null,
      r.crawl ? ['Crawl', `${r.crawl.crawled ?? 0} pages · ${r.crawl.failed ?? 0} failed`] : null,
      r.inspect ? ['URL inspection', `${r.inspect.inspected ?? 0} inspected`] : null,
      r.ranks ? ['Rank history', `${r.ranks.periods ?? 0} periods${r.ranks.cost ? ` · $${r.ranks.cost}` : ''}`] : null,
      r.crux ? ['CrUX field data', `${r.crux.ok ?? 0} of ${r.crux.queried ?? 0} targets with data${r.crux.insufficientData ? ` · ${r.crux.insufficientData} with too little traffic` : ''}${r.crux.errors?.length ? ` · ${r.crux.errors.length} errors` : ''}`] : null,
    ].filter(Boolean) as [string, string][];
    // What didn't run, and why: a skipped or failed phase is never shown as done.
    const problems = PHASES.map((ph, i) => (outcomes[i].cls === 'skipped' || (outcomes[i].cls === 'failed' && r[`${ph.key}Error`]) ? [ph.label, outcomes[i].note] : null))
      .filter(Boolean) as [string, string][];
    const rowsHtml = rows.map(([k, v]) => `<div class="summary-row"><span>${k}</span><span>${escapeHtml(v)}</span></div>`).join('') +
      problems.map(([k, v]) => `<div class="summary-row summary-row--warn"><span>${k}</span><span>${escapeHtml(v)}</span></div>`).join('');
    if (state === 'failed' || state === 'interrupted') {
      sum.innerHTML = `<div class="summary-error">Refresh ${state}${job.error ? `: ${escapeHtml(job.error)}` : ''}</div>` + rowsHtml;
    } else if (state === 'cancelled') {
      sum.innerHTML = `<div class="summary-warn">Refresh cancelled${job.error ? `: ${escapeHtml(job.error)}` : ''}. ${rows.length ? 'What finished before it stopped:' : 'Nothing finished before it stopped.'}</div>` + rowsHtml;
    } else {
      const partial = problems.length > 0;
      // This widget lives in chat: the next step is a request to Claude, not a dashboard button.
      sum.innerHTML = `<div class="${partial ? 'summary-warn' : 'summary-done'}">${partial ? `Refresh finished, with ${problems.length} phase${problems.length === 1 ? '' : 's'} skipped or failed.` : '✓ Refresh complete.'} Ask Claude to run the audit next.</div>` + rowsHtml;
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
