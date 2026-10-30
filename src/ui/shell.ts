// The browser dashboard's shell: one app for every domain. The domain dropdown moves between
// "All domains" (the domains table), a property's dashboard, and a watched domain's overview; the
// sidebar actions start free jobs (crawl, Search Console sync, URL inspection, audit, agent
// readiness) and show their progress. Paid DataForSEO work is never started here: from chat only,
// where it is quoted first.
import { esc } from './lib/h.js';
import { mountPortfolio, refreshPortfolioView } from './portfolio-view.js';
import { renderDomainOverview } from './portfolio-domain.js';

export type CallServer = (name: string, args: Record<string, unknown>) => Promise<any>;
export interface WebBoot { siteUrl: string; properties?: string[]; others?: string[]; view?: 'domains'; domain?: string }

const sc = (res: any): any => res?.structuredContent ?? res;
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The registrable domain of a property: sc-domain:x.com, https://www.x.com/ and x.com all give x.com. */
export function domainOfProperty(siteUrl: string): string {
  return siteUrl.trim().toLowerCase().replace(/^sc-domain:/, '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '');
}

// ---------- Domain dropdown ----------

/**
 * Build the domain dropdown in the sidebar: All domains, then your Search Console properties, the
 * domains you watch, and any database held for a site that isn't yours (a backlinks pull).
 */
export async function buildDomainPicker(boot: WebBoot, callServer: CallServer): Promise<void> {
  const holder = document.getElementById('sideProperty');
  if (!holder) return;
  let list: { properties: string[]; others: string[]; watched: { domain: string; group: string | null }[] } = {
    properties: boot.properties ?? [], others: boot.others ?? [], watched: [],
  };
  try { list = sc(await callServer('list_domains', {})); } catch { /* the boot list is enough */ }

  holder.querySelector('.property-switcher')?.remove();
  const sel = document.createElement('select');
  sel.className = 'property-switcher';
  sel.setAttribute('aria-label', 'Choose a domain');
  const current = boot.view === 'domains' ? '__all' : boot.domain ? `d:${boot.domain}` : `p:${boot.siteUrl}`;
  const opt = (value: string, label: string, parent: HTMLElement): void => {
    const o = document.createElement('option');
    o.value = value; o.textContent = label; o.selected = value === current;
    parent.appendChild(o);
  };
  const group = (label: string): HTMLOptGroupElement => {
    const g = document.createElement('optgroup'); g.label = label; sel.appendChild(g); return g;
  };
  opt('__all', 'All domains', sel);
  if (list.properties.length) { const g = group('Your properties'); for (const p of list.properties) opt(`p:${p}`, p, g); }
  if (list.watched.length) { const g = group('Watched'); for (const w of list.watched) opt(`d:${w.domain}`, w.group ? `${w.domain} (${w.group})` : w.domain, g); }
  if (list.others.length) { const g = group('Backlink data only'); for (const p of list.others) opt(`p:${p}`, p, g); }
  sel.addEventListener('change', () => {
    const v = sel.value;
    location.href = v === '__all' ? '/?all=1'
      : v.startsWith('d:') ? `/dashboard?domain=${encodeURIComponent(v.slice(2))}`
        : `/dashboard?siteUrl=${encodeURIComponent(v.slice(2))}`;
  });
  holder.appendChild(sel);
  document.getElementById('site')?.setAttribute('hidden', ''); // the dropdown names the domain
}

// ---------- Views without a property ----------

/** Hide the property tabs and show a full-width view in their place. */
function propertyChrome(show: boolean): HTMLElement {
  const nav = document.getElementById('tabs');
  if (nav) nav.hidden = !show;
  const loading = document.getElementById('loading');
  if (loading) loading.style.display = show ? '' : 'none';
  const range = document.getElementById('range');
  if (range) range.textContent = '';
  const view = document.getElementById('domainsView')!;
  view.hidden = show;
  return view;
}

const setTitle = (t: string): void => {
  const el = document.getElementById('pageTitle');
  if (el) el.textContent = t;
  document.title = `${t} - SEO Audit Console`;
};

let repaintMarket: (() => void) | null = null;

/** Re-tint the overview charts after a theme change. */
export function repaintDomainViews(): void {
  repaintMarket?.();
  refreshPortfolioView();
}

/** "All domains": the domains table, with add and remove for watched domains. */
export function showDomainsView(boot: WebBoot, callServer: CallServer): void {
  const root = propertyChrome(false);
  setTitle('All domains');
  mountPortfolio({ root, callServer, web: true, onChanged: () => { void buildDomainPicker(boot, callServer); } });
}

/** A watched domain: its overview (DataForSEO data, estimated), with a way back to the table. */
export async function showWatchedDomain(domain: string, callServer: CallServer): Promise<void> {
  const root = propertyChrome(false);
  root.classList.add('pf-root');
  setTitle(domain);
  root.innerHTML = '<div class="state">Loading domain overview...</div>';
  try {
    const o = sc(await callServer('get_domain_overview', { domain }));
    if (!o || o.notFound) throw new Error(`${domain} is not in the portfolio`);
    const paint = (): void => renderDomainOverview(root, o, { onBack: () => { location.href = '/?all=1'; }, backLabel: 'All domains' });
    paint();
    repaintMarket = paint;
  } catch (e) {
    root.innerHTML = `<div class="state error-state">${esc(errText(e))}</div>`;
  }
}

// ---------- Market & AI tab ----------

/**
 * The property dashboard's "Market & AI" tab: the domain overview (DataForSEO estimates, AI
 * mentions, backlinks) for this property's domain. Loaded on first open, not on page load.
 */
export function setupMarketTab(siteUrl: string, callServer: CallServer): void {
  const btn = document.querySelector<HTMLButtonElement>('.tab-btn[data-panel="market"]');
  const root = document.getElementById('marketView');
  if (!btn || !root) return;
  let started = false;
  btn.addEventListener('click', () => {
    if (started) return;
    started = true;
    root.innerHTML = '<div class="loading">Loading market data...</div>';
    void (async () => {
      try {
        const o = sc(await callServer('get_domain_overview', { domain: domainOfProperty(siteUrl) }));
        // In chat the tool answers { notFound } instead of failing.
        if (!o || o.notFound) throw new Error(`${domainOfProperty(siteUrl)} is not in the portfolio yet`);
        const paint = (): void => renderDomainOverview(root, o, { onBack: () => {}, embedded: true });
        paint();
        repaintMarket = paint;
      } catch (e) {
        started = false;
        root.innerHTML = `<div class="chart-card"><h3>Market &amp; AI</h3><div class="hint">${esc(errText(e))}. DataForSEO numbers (estimated traffic, keywords, backlinks, AI mentions) arrive with a portfolio refresh. That costs money, so it starts from chat: ask Claude to "Refresh my SEO Console portfolio" and it quotes the cost first.</div></div>`;
      }
    })();
  });
}

// ---------- Sidebar actions ----------

interface JobRow { id: string; type: string; state: string; startedAt: string; progress: string; error: string | null; note: string | null }
interface ActionStatus { enabled: boolean; gsc: boolean; runner: boolean; jobs: JobRow[] }

const JOB_LABEL: Record<string, string> = {
  crawl: 'Crawl', sync: 'Search Console sync', inspect: 'URL inspection', refresh: 'Refresh', rank_history: 'Rank history',
  backlinks: 'Backlinks', crux: 'Core Web Vitals', portfolio: 'Portfolio refresh', recon: 'Content recon',
  render: 'Render', duplicates: 'Duplicates', entities: 'Entities', 'fts-index': 'Query index', integrity: 'Integrity check', repair: 'Repair',
};
const STATE_LABEL: Record<string, string> = {
  running: 'running', queued: 'queued', 'queued-no-runner': 'queued, but no job runner is running', completed: 'done',
  failed: 'failed', cancelled: 'cancelled', interrupted: 'interrupted',
};
const LIVE = new Set(['running', 'queued']);
const ago = (iso: string): string => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return !Number.isFinite(m) ? '' : m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

/**
 * The sidebar's Actions block for a property. Hidden when the server is read-only. Polls the job
 * list every few seconds while a job is live, and offers a reload once one finishes.
 */
export function setupActions(siteUrl: string, callServer: CallServer): void {
  const box = document.getElementById('sideActions');
  if (!box) return;
  let status: ActionStatus | null = null;
  let msg: { text: string; err?: boolean; reload?: boolean } | null = null;
  let busy: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const watching = new Set<string>(); // jobs started or seen live on this page

  const paint = (): void => {
    if (!status?.enabled) { box.hidden = true; return; }
    box.hidden = false;
    const live = new Set(status.jobs.filter(j => LIVE.has(j.state)).map(j => j.type));
    const noGsc = !status.gsc && !status.runner;
    const button = (id: string, label: string, title: string, disabled: boolean): string =>
      `<button class="sa-btn" type="button" data-act="${id}" title="${esc(title)}" ${disabled || busy ? 'disabled' : ''}>${busy === id ? 'Working...' : esc(label)}</button>`;
    const jobs = status.jobs.slice(0, 4).map(j => `<div class="sa-job ${esc(j.state)}" title="${esc(j.error ?? j.note ?? '')}">
        <span class="sa-dot" aria-hidden="true"></span>
        <span>${esc(JOB_LABEL[j.type] ?? j.type)}: ${esc(STATE_LABEL[j.state] ?? j.state)}${j.progress && LIVE.has(j.state) ? `, ${esc(j.progress)}` : ''}<br><span class="sa-msg">${esc(ago(j.startedAt))}</span></span>
        ${LIVE.has(j.state) ? `<button class="sa-cancel" type="button" data-cancel="${esc(j.id)}">Cancel</button>` : ''}
      </div>`).join('');
    const gscTitle = 'Search Console credentials are not available where this dashboard runs';
    box.innerHTML = `<div class="sa-title">Actions</div>
      <div class="sa-buttons">
        ${button('crawl', 'Crawl site', 'Fetch the site into the local database (free)', live.has('crawl'))}
        ${button('sync', 'Sync Search Console', noGsc ? gscTitle : 'Pull the latest Search Console data (free)', live.has('sync') || noGsc)}
        ${button('inspect', 'Inspect URLs', noGsc ? gscTitle : 'URL Inspection: index coverage and canonicals (free, Google quota applies)', live.has('inspect') || noGsc)}
        ${button('audit', 'Run audit', 'Run the checks against the stored data (free)', live.has('crawl'))}
        ${button('readiness', 'Agent readiness', 'Probe the site for AI-agent signals (free)', false)}
      </div>
      ${msg ? `<div class="sa-msg ${msg.err ? 'err' : ''}">${esc(msg.text)}${msg.reload ? ' <button class="link-btn" type="button" data-reload>Reload</button>' : ''}</div>` : ''}
      ${status.jobs.length ? `<div class="sa-jobs">${jobs}</div>` : ''}
      ${noGsc ? '<div class="sa-msg">Search Console jobs need its credentials, or the job runner.</div>' : ''}`;
  };

  const poll = async (): Promise<void> => {
    if (timer) clearTimeout(timer);
    try {
      const next = sc(await callServer('action_status', { siteUrl })) as ActionStatus;
      // A job we watched has finished: say so once, and offer the reload that shows its data.
      for (const j of next.jobs) {
        if (LIVE.has(j.state)) { watching.add(j.id); continue; }
        if (!watching.delete(j.id)) continue;
        const label = JOB_LABEL[j.type] ?? j.type;
        msg = j.state === 'completed'
          ? { text: `${label} finished.${j.type === 'crawl' ? ' Run the audit to update the findings.' : ''}`, reload: true }
          : { text: `${label} ${STATE_LABEL[j.state] ?? j.state}${j.error ? `: ${j.error}` : ''}`, err: true };
      }
      status = next;
    } catch { /* keep the last status */ }
    paint();
    const anyLive = !!status?.jobs.some(j => LIVE.has(j.state));
    if (status?.enabled) timer = setTimeout(() => { void poll(); }, anyLive ? 4000 : 30000);
  };

  const act = async (id: string): Promise<void> => {
    let args: Record<string, unknown> = { siteUrl };
    if (id === 'crawl') {
      const answer = window.prompt(`Crawl ${siteUrl}: how many pages at most?`, '4000');
      if (answer === null) return;
      const n = Number(answer.replace(/[, ]/g, ''));
      if (!(n > 0)) { msg = { text: 'Enter a number of pages.', err: true }; paint(); return; }
      args = { ...args, kind: 'crawl', maxPages: n };
    } else if (id === 'sync' || id === 'inspect') {
      args = { ...args, kind: id };
    }
    busy = id; msg = null; paint();
    try {
      if (id === 'audit') {
        msg = { text: 'Running the audit...' }; paint();
        const r = sc(await callServer('run_audit', { siteUrl }));
        msg = { text: `Audit done: ${r.total} findings.`, reload: true };
      } else if (id === 'readiness') {
        const r = sc(await callServer('check_agent_readiness', { siteUrl }));
        msg = { text: `Agent readiness ${r.score} / 100 (${r.level}).`, reload: true };
      } else {
        const r = sc(await callServer('start_job', args));
        watching.add(r.jobId);
        msg = { text: r.queued ? 'Queued for the job runner.' : 'Started.' };
      }
    } catch (e) {
      msg = { text: errText(e), err: true };
    } finally {
      busy = null;
      void poll();
    }
  };

  box.addEventListener('click', ev => {
    const t = ev.target as HTMLElement;
    const a = t.closest<HTMLButtonElement>('[data-act]');
    if (a && !a.disabled) { void act(a.dataset.act!); return; }
    const c = t.closest<HTMLElement>('[data-cancel]');
    if (c) { void callServer('cancel_job', { id: c.dataset.cancel }).finally(() => { void poll(); }); return; }
    if (t.closest('[data-reload]')) location.reload();
  });
  void poll();
}
