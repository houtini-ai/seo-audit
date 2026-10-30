// SEO Console - the domains table: one table over owned properties (GSC, measured) and watched
// domains (DataForSEO, estimated). Mounted by the browser dashboard's "All domains" view and by the
// in-chat get_portfolio widget (portfolio.ts). Paid refreshes are never started here: from chat only.
import { esc, fmtNum, fmtCompact, fmtDate, fmtMonth } from './lib/h.js';
import { renderDomainOverview } from './portfolio-domain.js';

interface Change { from: string; to: string; mode: 'pct' | 'abs'; value: number; diff: number }
interface Metric { value: number | null; source: 'snapshot' | 'history' | null; asOf: string | null; month: Change | null; year: Change | null; spark: (number | null)[]; partial: number | null; empty?: string }
interface PortfolioRow {
  domain: string; locationCode: number; country: string; countryName: string;
  kind: 'owned' | 'watched'; group: string | null; siteUrls: string[];
  clicks28: { value: number; prior: number; change: Change; window: { start: string; end: string } } | null;
  audit: { score: number; prior: number | null; at: string } | null;
  organicKeywords: Metric; organicTraffic: Metric; paidKeywords: Metric; paidTraffic: Metric;
  referringDomains: Metric; domainRank: Metric;
  aiMentions: Metric & { platforms: { google: number | null; chat_gpt: number | null }; chatgptUsOnly: boolean };
  attention: string[];
}
interface ScheduleView { enabled: boolean; budgetUsd: number; weeklyDow: number; monthlyDom: number; nextWeeklyDue: string | null; nextMonthlyDue: string | null; consentedAt: string | null }
interface PortfolioPayload {
  version: string; generatedAt: string;
  months: { lastComplete: string; previous: string; yearAgo: string; current: string };
  counts: { owned: number; watched: number; attention: number };
  groups: string[];
  refresh: { weeklyCapturedAt: string | null; monthlyCapturedAt: string | null; schedule: ScheduleView | null; spentThisMonth: number;
    lastRuns: { id: number; startedAt: string; tier: string; trigger: string; status: string; spent: number; quoted: number | null; note: string | null }[] };
  rows: PortfolioRow[]; empty: boolean; notes: string[];
}

const REFRESH_PROMPT = 'Refresh my SEO Console portfolio';

/**
 * What the table needs from its host. `web` = the browser dashboard: a domain click opens that
 * domain's dashboard (owned) or overview (watched), and watched domains can be added and removed
 * here (free, no API call). In chat, a click opens the overview in place.
 */
export interface PortfolioHost {
  root: HTMLElement;
  callServer: (name: string, args: Record<string, unknown>) => Promise<any>;
  web: boolean;
  /** The chat host can take a message ("Ask Claude to refresh"). */
  canMessage?: () => boolean;
  sendMessage?: (text: string) => Promise<{ isError?: boolean } | undefined>;
  /** After a watched domain is added or removed (the dashboard rebuilds its domain dropdown). */
  onChanged?: () => void;
}
let host: PortfolioHost | null = null;
const callServer = (name: string, args: Record<string, unknown>): Promise<any> => host!.callServer(name, args);

type SortColumn = 'domain' | 'clicks' | 'organicKeywords' | 'organicTraffic' | 'paidKeywords' | 'referringDomains' | 'domainRank' | 'aiMentions' | 'audit';
type TabKey = 'all' | 'attention' | 'owned' | 'watched';
type PeriodMode = 'month' | 'year';
type View = { type: 'table' } | { type: 'domain'; domain: string; locationCode?: number; overview: unknown | null };

let payload: PortfolioPayload | null = null;
let loading = false;
let error: string | null = null;
let view: View = { type: 'table' };
let currentTab: TabKey = 'all';
let groupFilter = '';
let showPaid = typeof window !== 'undefined' && window.innerWidth >= 1500;
let periodMode: PeriodMode = 'month';
let sortColumn: SortColumn = 'organicTraffic';
let sortDir: 1 | -1 = -1;
let loadPromise: Promise<PortfolioPayload | null> | null = null;

const root = (): HTMLElement => host!.root;
let adding = false;
let addError: string | null = null;
// UI copy rule: no en/em dashes anywhere, even in server-provided text.
const clean = (text: string): string => text.replace(/–|—/g, ' - ');
const attr = (value: string): string => esc(clean(value));
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function copyFallback(text: string): boolean {
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { return document.execCommand('copy'); } catch { return false; } finally { ta.remove(); }
}
function flashCopied(button: HTMLButtonElement): void {
  const original = button.textContent ?? '';
  button.textContent = 'Copied'; button.classList.add('copied');
  window.setTimeout(() => { button.textContent = original; button.classList.remove('copied'); }, 2000);
}
async function copyRefreshPrompt(button: HTMLButtonElement): Promise<void> {
  let ok = false;
  try { await navigator.clipboard.writeText(REFRESH_PROMPT); ok = true; } catch { ok = copyFallback(REFRESH_PROMPT); }
  if (ok) flashCopied(button);
}
// The prompt never carries "confirm": the model must quote the cost and ask first.
async function askToRefresh(button: HTMLButtonElement): Promise<void> {
  try {
    const res = await host!.sendMessage?.(REFRESH_PROMPT);
    if (res?.isError) await copyRefreshPrompt(button);
  } catch { await copyRefreshPrompt(button); }
}

function changeChip(ch: Change | null): string {
  if (!ch) return '';
  const v = ch.value ?? 0;
  const cls = v > 0 ? 'chip-up' : v < 0 ? 'chip-down' : 'chip-zero';
  const sign = v > 0 ? '+' : v < 0 ? '-' : '';
  const text = ch.mode === 'pct' ? `${sign}${Math.abs(v).toFixed(1)}%` : `${sign}${fmtNum(Math.round(Math.abs(v)))}`;
  return `<span class="chip ${cls}">${esc(text)}</span>`;
}

const changeOf = (m: Metric): Change | null => (periodMode === 'month' ? m.month : m.year);

function metricTitle(m: Metric, label: string, extra = ''): string {
  const parts = [`${label}: DataForSEO estimate`];
  if (m.asOf) parts.push(m.source === 'history' ? `month ${fmtMonth(m.asOf)}` : `captured ${fmtDate(m.asOf)}`);
  const ch = changeOf(m);
  if (ch) parts.push(`change ${fmtMonth(ch.from)} to ${fmtMonth(ch.to)}`);
  if (extra) parts.push(extra);
  return parts.join('; ');
}

/** 12-point inline SVG sparkline: one neutral colour (direction lives in the chip), gaps for nulls. */
function sparkline(points: (number | null)[]): string {
  const vals = points ?? [];
  const nums = vals.filter((v): v is number => v != null && Number.isFinite(v));
  if (nums.length < 2) return '';
  const w = 72, hgt = 18, pad = 1;
  const min = Math.min(...nums), max = Math.max(...nums);
  const segs: string[] = []; let cur: string[] = [];
  vals.forEach((v, i) => {
    if (v == null || !Number.isFinite(v)) { if (cur.length) { segs.push(cur.join(' ')); cur = []; } return; }
    const x = pad + (i / Math.max(1, vals.length - 1)) * (w - pad * 2);
    const y = pad + (1 - (max === min ? 0.5 : (v - min) / (max - min))) * (hgt - pad * 2);
    cur.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  });
  if (cur.length) segs.push(cur.join(' '));
  const lines = segs.map(s => s.includes(' ')
    ? `<polyline points="${s}" fill="none" stroke="var(--text-muted)" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" />`
    : `<circle cx="${s.split(',')[0]}" cy="${s.split(',')[1]}" r="1" fill="var(--text-muted)" />`).join('');
  return `<svg width="${w}" height="${hgt}" viewBox="0 0 ${w} ${hgt}" aria-hidden="true">${lines}</svg>`;
}

const emptyCell = (m: Metric): string => {
  const why = m.empty ?? 'no data';
  return `<td class="num-cell metric-cell" title="${attr(why)}"><div class="empty-metric">${esc(clean(why))}</div></td>`;
};

function metricCell(m: Metric, label: string, opts: { extra?: string; suffix?: string; spark?: boolean } = {}): string {
  if (m.value == null) return emptyCell(m);
  // Estimates (ETV) arrive with decimals; whole visits and keywords read as what they are.
  const shown = opts.suffix ? `${Math.round(m.value)}${opts.suffix}` : fmtCompact(Math.round(m.value));
  return `<td class="num-cell metric-cell" title="${attr(metricTitle(m, label, opts.extra))}">
    <div class="metric-value"><span class="num">${esc(shown)}</span> ${changeChip(changeOf(m))}</div>
    ${opts.spark === false ? '' : `<div class="spark">${sparkline(m.spark)}</div>`}
  </td>`;
}

function aiCell(row: PortfolioRow): string {
  const m = row.aiMentions;
  const g = m.platforms.google, c = m.platforms.chat_gpt;
  const extra = `AI Overviews ${g == null ? 'not reported' : fmtNum(g)}, ChatGPT ${c == null ? 'not reported' : fmtNum(c)}${m.chatgptUsOnly ? ' (ChatGPT: US data)' : ''}; monthly mentions`;
  return metricCell(m, 'AI mentions', { extra });
}

function clicksCell(row: PortfolioRow): string {
  if (!row.clicks28) return `<td class="num-cell"><span class="dash" title="Search Console data exists only for owned sites">-</span></td>`;
  const t = `Search Console clicks (measured), ${fmtDate(row.clicks28.window.start)} to ${fmtDate(row.clicks28.window.end)}, vs the 28 days before`;
  return `<td class="num-cell" title="${attr(t)}"><div class="metric-value"><span class="num">${esc(fmtCompact(row.clicks28.value))}</span> ${changeChip(row.clicks28.change)}</div></td>`;
}

function paidCell(row: PortfolioRow): string {
  if (!showPaid) return '';
  const k = row.paidKeywords.value, v = row.paidTraffic.value;
  if (k == null && v == null) return emptyCell(row.paidKeywords);
  return `<td class="num-cell" title="${attr(metricTitle(row.paidTraffic, 'Paid traffic'))}"><div class="paid-cell">
    <span>${k == null ? '-' : esc(fmtCompact(k))} keywords</span><span>${v == null ? '-' : esc(fmtCompact(v))} visits</span></div></td>`;
}

function auditCell(row: PortfolioRow): string {
  if (!row.audit) return `<td class="num-cell"><span class="dash" title="Audits exist only for owned sites">-</span></td>`;
  const d = row.audit.prior != null ? row.audit.score - row.audit.prior : null;
  const chip = d == null ? '' : changeChip({ from: '', to: '', mode: 'abs', value: d, diff: d });
  return `<td class="num-cell" title="${attr(`Audit health, latest run ${fmtDate(row.audit.at)}`)}"><div class="metric-value"><span class="num">${row.audit.score} / 100</span> ${chip}</div></td>`;
}

/** Where a domain opens in the browser dashboard: an owned site's property dashboard, else the
 * watched domain's own page (its overview). */
export function domainHref(row: { kind: string; domain: string; siteUrls: string[] }): string {
  return row.kind === 'owned' && row.siteUrls[0]
    ? `/dashboard?siteUrl=${encodeURIComponent(row.siteUrls[0])}`
    : `/dashboard?domain=${encodeURIComponent(row.domain)}`;
}

function domainCell(row: PortfolioRow): string {
  const label = attr(`${row.domain} (${row.countryName})`);
  const name = host!.web
    ? `<a class="domain-link" href="${attr(domainHref(row))}" title="${label}">${esc(row.domain)}</a>`
    : `<button class="domain-link" type="button" data-domain="${attr(row.domain)}" data-loc="${row.locationCode}" title="${label}">${esc(row.domain)}</button>`;
  const remove = host!.web && row.kind === 'watched'
    ? `<button class="row-remove" type="button" data-remove="${attr(row.domain)}" data-loc="${row.locationCode}" title="Stop watching ${attr(row.domain)}" aria-label="Stop watching ${attr(row.domain)}">Remove</button>` : '';
  return `<td class="cell-domain">
    <div class="domain-main">
      ${name}
      <span class="country-chip" title="${attr(row.countryName)}">${esc(row.country)}</span>
    </div>
    <div class="domain-badges">
      <span class="badge ${row.kind === 'owned' ? 'gsc' : 'watched'}">${row.kind === 'owned' ? 'GSC' : 'Watched'}</span>
      ${row.group ? `<span class="group-label">${esc(clean(row.group))}</span>` : ''}
      ${remove}
    </div>
  </td>`;
}

/** Totals under the table for the rows shown: measured clicks and estimated traffic, never mixed. */
function totalsLine(rows: PortfolioRow[]): string {
  if (!rows.length) return '';
  const clicks = rows.reduce((t, r) => t + (r.clicks28?.value ?? 0), 0);
  const withClicks = rows.filter(r => r.clicks28).length;
  const traffic = rows.reduce((t, r) => t + (r.organicTraffic.value ?? 0), 0);
  const withTraffic = rows.filter(r => r.organicTraffic.value != null).length;
  return `<div class="totals-line"><span>Showing <b>${rows.length}</b> domain${rows.length === 1 ? '' : 's'}</span>` +
    (withClicks ? `<span>Search Console clicks, 28 days (measured): <b class="num">${esc(fmtCompact(clicks))}</b> across ${withClicks}</span>` : '') +
    (withTraffic ? `<span>Organic traffic (estimated): <b class="num">${esc(fmtCompact(Math.round(traffic)))}</b> across ${withTraffic}</span>` : '') + '</div>';
}

/** A needs-attention reason that names a free fix gets a button for it (browser, owned rows only). */
function fixButton(row: PortfolioRow, reason: string): string {
  if (!host!.web || row.kind !== 'owned' || !row.siteUrls[0]) return '';
  const kind = /Search Console data is/i.test(reason) ? 'sync' : /crawl/i.test(reason) ? 'crawl' : null;
  if (!kind) return '';
  return ` <button type="button" class="reason-fix" data-fix-kind="${kind}" data-site="${attr(row.siteUrls[0])}">${kind === 'sync' ? 'Sync now' : 'Crawl now'}</button>`;
}

/** The add-a-watched-domain form (browser dashboard only). Adding costs nothing: the domain's
 * numbers arrive on the next portfolio refresh, which is quoted and started from chat. */
function addForm(): string {
  if (!host!.web) return '';
  const groups = payload?.groups ?? [];
  return `<form class="add-domain" id="add-domain" autocomplete="off">
    <label><span>Domain</span><input name="domain" required placeholder="rival.com" spellcheck="false"></label>
    <label><span>Group</span><input name="group" list="pf-groups" placeholder="competitors"></label>
    <datalist id="pf-groups">${groups.map(g => `<option value="${attr(g)}">`).join('')}</datalist>
    <label><span>Country</span><input name="location" placeholder="United States"></label>
    <button class="btn primary" type="submit" ${adding ? 'disabled' : ''}>${adding ? 'Adding...' : 'Watch domain'}</button>
    <span class="add-note">${addError ? `<span class="add-error">${esc(clean(addError))}</span>` : 'Free to add. Its numbers arrive with the next portfolio refresh.'}</span>
  </form>`;
}

function sortValue(row: PortfolioRow, col: SortColumn): number | string | null {
  switch (col) {
    case 'domain': return row.domain;
    case 'clicks': return row.clicks28?.value ?? null;
    case 'organicKeywords': return row.organicKeywords.value;
    case 'organicTraffic': return row.organicTraffic.value;
    case 'paidKeywords': return row.paidTraffic.value;
    case 'referringDomains': return row.referringDomains.value;
    case 'domainRank': return row.domainRank.value;
    case 'aiMentions': return row.aiMentions.value;
    case 'audit': return row.audit?.score ?? null;
  }
}

function visibleRows(): PortfolioRow[] {
  if (!payload) return [];
  let rows = payload.rows.slice();
  if (currentTab === 'attention') rows = rows.filter(r => r.attention.length > 0);
  else if (currentTab === 'owned') rows = rows.filter(r => r.kind === 'owned');
  else if (currentTab === 'watched') rows = rows.filter(r => r.kind === 'watched');
  if (groupFilter) rows = rows.filter(r => r.group === groupFilter);
  return rows.sort((a, b) => {
    const av = sortValue(a, sortColumn), bv = sortValue(b, sortColumn);
    if (av == null && bv == null) return a.domain.localeCompare(b.domain);
    if (av == null) return 1;   // nulls last, whatever the direction
    if (bv == null) return -1;
    const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
    return cmp * sortDir;
  });
}

const arrow = (col: SortColumn): string => (sortColumn !== col ? '' : `<span class="arrow">${sortDir === 1 ? '▲' : '▼'}</span>`);
const th = (col: SortColumn, label: string, extra = ''): string =>
  `<th class="clickable num ${sortColumn === col ? 'active' : ''}" data-sort="${col}" aria-sort="${sortColumn === col ? (sortDir === 1 ? 'ascending' : 'descending') : 'none'}">${label}${extra}${arrow(col)}</th>`;

function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportCSV(): void {
  if (!payload) return;
  const headers = ['domain', 'country', 'kind', 'group', 'clicks_28d_measured', 'organic_keywords', 'organic_traffic_est', 'paid_keywords', 'paid_traffic_est',
    'referring_domains', 'domain_rank_dataforseo', 'ai_mentions_monthly', 'audit_health', 'change_basis', 'needs_attention'];
  const lines = [headers.join(',')];
  for (const r of visibleRows()) {
    const ch = changeOf(r.organicTraffic) ?? changeOf(r.referringDomains);
    lines.push([r.domain, r.country, r.kind, r.group ?? '', r.clicks28?.value ?? '', r.organicKeywords.value ?? '', r.organicTraffic.value ?? '',
      r.paidKeywords.value ?? '', r.paidTraffic.value ?? '', r.referringDomains.value ?? '', r.domainRank.value ?? '', r.aiMentions.value ?? '',
      r.audit?.score ?? '', ch ? `${ch.from} to ${ch.to}` : '', r.attention.join('; ')].map(csvCell).join(','));
  }
  const url = URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = `portfolio-${payload.months.lastComplete}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function renderTable(el: HTMLElement): void {
  if (!payload) return;
  const p = payload;
  const vs = periodMode === 'month' ? p.months.previous : p.months.yearAgo;
  const comparing = `Comparing ${fmtMonth(vs)} with ${fmtMonth(p.months.lastComplete)} (last complete months; a series that lags compares its own latest month, named in each tooltip)`;
  const s = p.refresh.schedule;
  const scheduleText = s?.enabled
    ? `Schedule: weekly on ${DAYS[s.weeklyDow] ?? s.weeklyDow}, monthly on day ${s.monthlyDom}, budget $${fmtNum(s.budgetUsd)} a month, spent $${fmtNum(p.refresh.spentThisMonth)} this month`
    : `No schedule. Ask in chat to schedule a refresh.${p.refresh.spentThisMonth ? ` Spent $${fmtNum(p.refresh.spentThisMonth)} this month.` : ''}`;
  const last = p.refresh.lastRuns?.[0];
  const warn = last && (last.status === 'partial-budget' || last.status === 'skipped-reconfirm' || last.status === 'partial') && last.note
    ? `<div class="warning-line">${esc(clean(last.note))}</div>` : '';
  const notes = p.notes.map(n => `<div class="notes-line">${esc(clean(n))}</div>`).join('');
  const canMessage = !host!.web && !!host!.canMessage?.();
  const cols = 8 + (showPaid ? 1 : 0);
  const rows = visibleRows();

  el.innerHTML = `
    <div class="page-header">
      <div class="heading">
        <h1>Domains</h1>
        <div class="subline">${p.counts.owned} owned &middot; ${p.counts.watched} watched</div>
        <div class="caption">${esc(comparing)}</div>
      </div>
      <div class="controls">
        <div class="segmented" role="group" aria-label="Compare with">
          <button type="button" data-mode="month" class="${periodMode === 'month' ? 'active' : ''}" aria-pressed="${periodMode === 'month'}">Month</button>
          <button type="button" data-mode="year" class="${periodMode === 'year' ? 'active' : ''}" aria-pressed="${periodMode === 'year'}">Year</button>
        </div>
        <label class="checkbox"><input type="checkbox" id="show-paid" ${showPaid ? 'checked' : ''}> Show paid</label>
        <button class="btn" type="button" id="export-csv" ${p.empty ? 'disabled' : ''}>Export CSV</button>
      </div>
    </div>
    <div class="refresh-strip">
      <div class="refresh-info">
        <div class="refresh-line">${p.refresh.weeklyCapturedAt ? '<span class="dot-ok"></span>' : ''}Weekly data: captured ${p.refresh.weeklyCapturedAt ? esc(fmtDate(p.refresh.weeklyCapturedAt)) : 'never'}</div>
        <div class="refresh-line">Monthly history: captured ${p.refresh.monthlyCapturedAt ? esc(fmtDate(p.refresh.monthlyCapturedAt)) : 'never'}</div>
        <div class="refresh-line">${esc(scheduleText)}</div>
        ${notes}${warn}
      </div>
      <div class="refresh-actions">
        <button class="btn link" type="button" id="copy-prompt" title="Paste this into chat: Claude quotes the cost before spending anything">Copy refresh prompt</button>
        ${canMessage ? '<button class="btn" type="button" id="ask-refresh">Ask Claude to refresh</button>' : ''}
      </div>
    </div>
    ${addForm()}
    ${p.empty ? `<div class="empty-state"><h2>No domains yet</h2><p>${host!.web ? 'Sync a property, or watch a domain with the form above.' : 'Sync a property, or ask in chat to add a domain to watch.'}</p></div>` : `
    <div class="tabs-row">
      <div class="tabs" role="tablist">
        <button type="button" role="tab" class="tab ${currentTab === 'all' ? 'active' : ''}" data-tab="all">All <span class="tab-n">${p.rows.length}</span></button>
        <button type="button" role="tab" class="tab ${currentTab === 'attention' ? 'active' : ''}" data-tab="attention">Needs attention<span class="pill">${p.counts.attention}</span></button>
        <button type="button" role="tab" class="tab ${currentTab === 'owned' ? 'active' : ''}" data-tab="owned">Owned <span class="tab-n">${p.counts.owned}</span></button>
        <button type="button" role="tab" class="tab ${currentTab === 'watched' ? 'active' : ''}" data-tab="watched">Watched <span class="tab-n">${p.counts.watched}</span></button>
      </div>
      ${p.groups.length ? `<select class="group-filter" id="group-filter" aria-label="Group">
        <option value="">Group: All groups</option>
        ${p.groups.map(g => `<option value="${attr(g)}" ${g === groupFilter ? 'selected' : ''}>Group: ${esc(clean(g))}</option>`).join('')}
      </select>` : ''}
    </div>
    <div class="table-card"><div class="table-scroll"><table>
      <thead>
        <tr class="band">
          <th rowspan="2" class="band-domain clickable ${sortColumn === 'domain' ? 'active' : ''}" data-sort="domain">Domain ${arrow('domain')}</th>
          <th>Search Console (measured)</th>
          <th colspan="${5 + (showPaid ? 1 : 0)}">DataForSEO (estimated)</th>
          <th>Audit</th>
        </tr>
        <tr class="headers">
          ${th('clicks', 'Clicks, 28 days')}
          ${th('organicKeywords', 'Organic keywords')}
          ${th('organicTraffic', 'Organic traffic')}
          ${showPaid ? th('paidKeywords', 'Paid keywords and traffic') : ''}
          ${th('referringDomains', 'Referring domains')}
          ${th('domainRank', 'Domain Rank')}
          ${th('aiMentions', 'AI mentions', '<span class="th-caption">AI Overviews + ChatGPT, monthly</span>')}
          ${th('audit', 'Audit health')}
        </tr>
      </thead>
      <tbody>
        ${rows.map(r => `<tr>${domainCell(r)}${clicksCell(r)}${metricCell(r.organicKeywords, 'Organic keywords')}${metricCell(r.organicTraffic, 'Organic traffic')}${paidCell(r)}${metricCell(r.referringDomains, 'Referring domains (root domains)')}${metricCell(r.domainRank, 'Domain Rank (DataForSEO, 0 to 100)', { suffix: ' / 100' })}${aiCell(r)}${auditCell(r)}</tr>`
          + (r.attention.length ? `<tr class="attention-row"><td colspan="${cols}"><div class="attention-list">${r.attention.map(a => `<span class="attention-reason"><span class="dot"></span>${esc(clean(a))}${fixButton(r, a)}</span>`).join('')}</div></td></tr>` : '')).join('')
          || `<tr><td class="empty-filter" colspan="${cols}">No domains match the current filters.</td></tr>`}
      </tbody>
    </table></div>${totalsLine(rows)}</div>
    <div class="footnote">
      Estimated figures are DataForSEO estimates for each row's country. Clicks are measured by Google Search Console. Domain Rank is DataForSEO's rank (0 to 100), not an Authority Score. AI mentions cover Google AI Overviews and ChatGPT only; ChatGPT data is US-only.
    </div>`}`;

  el.querySelectorAll<HTMLElement>('[data-sort]').forEach(x => x.addEventListener('click', () => {
    const col = x.dataset.sort as SortColumn;
    if (sortColumn === col) sortDir = sortDir === 1 ? -1 : 1; else { sortColumn = col; sortDir = col === 'domain' ? 1 : -1; }
    rerender();
  }));
  el.querySelectorAll<HTMLElement>('[data-tab]').forEach(x => x.addEventListener('click', () => { currentTab = x.dataset.tab as TabKey; rerender(); }));
  el.querySelectorAll<HTMLElement>('[data-mode]').forEach(x => x.addEventListener('click', () => { periodMode = x.dataset.mode as PeriodMode; rerender(); }));
  el.querySelectorAll<HTMLElement>('button.domain-link').forEach(x => x.addEventListener('click', () => {
    if (x.dataset.domain) void openDomain(x.dataset.domain, Number(x.dataset.loc) || undefined);
  }));
  el.querySelectorAll<HTMLButtonElement>('[data-fix-kind]').forEach(x => x.addEventListener('click', () => {
    const kind = x.dataset.fixKind!, siteUrl = x.dataset.site!;
    x.disabled = true; x.textContent = 'Starting...';
    void callServer('start_job', { siteUrl, kind })
      .then(r => { const q = (r?.structuredContent ?? r)?.queued; x.textContent = q ? 'Queued' : 'Started'; })
      .catch(e => { x.disabled = false; x.textContent = kind === 'sync' ? 'Sync now' : 'Crawl now'; window.alert(e instanceof Error ? e.message : String(e)); });
  }));
  el.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach(x => x.addEventListener('click', () => {
    const d = x.dataset.remove!;
    if (!window.confirm(`Stop watching ${d}? Its stored history is kept, and adding it again brings it back.`)) return;
    x.disabled = true;
    void callServer('portfolio_remove_domain', { domain: d, locationCode: Number(x.dataset.loc) || undefined })
      .then(() => reload())
      .catch(e => { x.disabled = false; window.alert(e instanceof Error ? e.message : String(e)); });
  }));
  el.querySelector<HTMLFormElement>('#add-domain')?.addEventListener('submit', ev => {
    ev.preventDefault();
    const f = new FormData(ev.currentTarget as HTMLFormElement);
    const domain = String(f.get('domain') ?? '').trim();
    if (!domain) return;
    adding = true; addError = null; rerender();
    void callServer('portfolio_add_domain', { domain, group: String(f.get('group') ?? ''), location: String(f.get('location') ?? '') })
      .then(() => { adding = false; return reload(); })
      .catch(e => { adding = false; addError = e instanceof Error ? e.message : String(e); rerender(); });
  });
  const gf = el.querySelector<HTMLSelectElement>('#group-filter');
  gf?.addEventListener('change', () => { groupFilter = gf.value; rerender(); });
  const sp = el.querySelector<HTMLInputElement>('#show-paid');
  sp?.addEventListener('change', () => { showPaid = sp.checked; rerender(); });
  el.querySelector('#export-csv')?.addEventListener('click', exportCSV);
  el.querySelector<HTMLButtonElement>('#copy-prompt')?.addEventListener('click', e => void copyRefreshPrompt(e.currentTarget as HTMLButtonElement));
  el.querySelector<HTMLButtonElement>('#ask-refresh')?.addEventListener('click', e => void askToRefresh(e.currentTarget as HTMLButtonElement));
}

function rerender(): void {
  const el = root();
  if (loading) { el.innerHTML = `<div class="state">${view.type === 'domain' ? 'Loading domain overview...' : 'Loading portfolio...'}</div>`; return; }
  if (error) { el.innerHTML = `<div class="state error-state">${esc(clean(error))}</div>`; return; }
  if (view.type === 'domain') {
    if (view.overview) renderDomainOverview(el, view.overview, { onBack: backToTable });
    else el.innerHTML = `<div class="state">Loading domain overview...</div>`;
    return;
  }
  renderTable(el);
}

export function backToTable(): void {
  view = { type: 'table' };
  if (payload) rerender(); else void loadPortfolio();
}

/** Chat only: the overview replaces the table in place (the browser dashboard links instead). */
export async function openDomain(domain: string, locationCode?: number): Promise<void> {
  view = { type: 'domain', domain, locationCode, overview: null };
  loading = true; error = null; rerender();
  try {
    const res = await callServer('get_domain_overview', { domain, ...(locationCode ? { locationCode } : {}) });
    const o = res?.structuredContent ?? res;
    if (!o || (o as any).notFound) throw new Error(`${domain} is not in the portfolio.`);
    view = { type: 'domain', domain, locationCode, overview: o };
    window.scrollTo(0, 0);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally { loading = false; rerender(); }
}

export function loadPortfolio(): Promise<PortfolioPayload | null> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    if (view.type === 'table') { loading = true; error = null; rerender(); }
    try {
      const res = await callServer('get_portfolio_data', {});
      payload = (res?.structuredContent ?? res) as PortfolioPayload;
      return payload;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      return null;
    } finally {
      loading = false; loadPromise = null;
      if (view.type === 'table') rerender();
    }
  })();
  return loadPromise;
}

/** Re-read the table after an add or remove, and tell the host (its dropdown lists watched domains). */
async function reload(): Promise<void> {
  payload = null;
  await loadPortfolio();
  host?.onChanged?.();
}

/** Mount the table on a host. A fixture payload (screenshot harness) renders without a server. */
export function mountPortfolio(h: PortfolioHost, opts: { fixture?: unknown; overviewFixture?: unknown; defer?: boolean } = {}): void {
  host = h;
  h.root.classList.add('pf-root');
  if (opts.fixture) {
    payload = opts.fixture as PortfolioPayload;
    if (opts.overviewFixture) view = { type: 'domain', domain: String((opts.overviewFixture as any)?.row?.domain ?? ''), overview: opts.overviewFixture };
    rerender();
    return;
  }
  if (!opts.defer) void loadPortfolio();
}

/** Re-render (a theme change re-tints the overview's charts). */
export function refreshPortfolioView(): void { if (host) rerender(); }

