/**
 * Printable A4 report (#79): the Summary for one property plus the portfolio, as one self-contained
 * HTML document in the Houtini house style. Flowing pages with print CSS (@page A4, sections that
 * avoid breaking) rather than fixed-height sheets, because the data varies by property and a fixed
 * sheet silently clips whatever overflows. export_report writes it, and prints it to PDF when the
 * optional Playwright browser is installed; otherwise any browser's Print > Save as PDF gives the
 * same pages.
 *
 * Pure: everything comes from the payloads passed in. Every number shown carries its window or
 * source, a missing source omits its block (never a zero), and capped lists say what they left out.
 */
import type { DashboardData } from './dashboardData.js';
import type { PortfolioPayload } from './portfolioData.js';
import { buildVerdict } from './summaryVerdict.js';
import { CHECKS } from '../audit/checks.js';

const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
// House rule: no en or em dashes in anything we render, including stored text.
const clean = (s: unknown): string => esc(String(s ?? '').replace(/[–—]/g, ' - '));
const num = (n: number | null | undefined): string => (n == null || !Number.isFinite(n) ? '-' : Math.round(n).toLocaleString('en-GB'));
const pct = (cur: number, prior: number | null | undefined): string | null => {
  if (prior == null || prior <= 0) return null;
  const p = ((cur - prior) / prior) * 100;
  return `${p >= 0 ? '+' : ''}${Math.round(p)}%`;
};
const monthLabel = (ym: string): string => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
};
const dateLabel = (iso: string | null | undefined): string => {
  if (!iso) return '-';
  const s = iso.length <= 10 ? `${iso}T00:00:00Z` : /[zZ]|[+-]\d\d:?\d\d$/.test(iso.slice(10)) ? iso.replace(' ', 'T') : `${iso.replace(' ', 'T')}Z`;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : esc(iso);
};
const pathOf = (u: string | null | undefined): string => { if (!u) return 'site-wide'; try { const x = new URL(u); return (x.pathname + x.search) || '/'; } catch { return u; } };
const AREA: Record<string, string> = { crawlability: 'Crawlability', indexation: 'Indexation', onpage: 'On-page', content: 'Content', schema: 'Structured data', security: 'Security', performance: 'Performance', accessibility: 'Accessibility', 'war-stories': 'Known failure patterns', merged: 'Search Console and crawl combined' };
const SEV: Record<string, string> = { crit: 'Critical', high: 'High', med: 'Medium', low: 'Low', info: 'Info' };
const checkTitle = (id: string): string => CHECKS.find(c => c.id === id)?.title ?? id;

/** Rows shown in the portfolio table before it says how many it left out. */
export const PRINT_PORTFOLIO_ROWS = 30;
const TOP_FINDINGS = 10;

export interface PrintReportInput {
  data: DashboardData;
  /** The portfolio payload, or null when the portfolio is empty or unreadable. */
  portfolio: PortfolioPayload | null;
  /** The property's bare domain, to find and highlight its portfolio row. */
  domain: string;
  version: string;
  now?: Date;
}

const CSS = `
:root { --ink:#121216; --muted:#6B6B73; --hair:#E4E4DF; --accent:#0F7A5C; --wash:#E3F1EB; --crit:#B42318; --warn:#B54708; }
@page { size: A4; margin: 16mm 15mm 18mm; }
* { box-sizing: border-box; }
html, body { margin: 0; background: #fff; color: var(--ink); }
body { font: 10.5pt/1.5 'Schibsted Grotesk', -apple-system, 'Segoe UI', Roboto, sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.wrap { max-width: 180mm; margin: 0 auto; }
.mono { font-family: 'JetBrains Mono', ui-monospace, Consolas, monospace; }
header.top { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 1px solid var(--hair); padding-bottom: 6px; }
.brand { font-weight: 700; letter-spacing: -0.01em; }
.kick { font: 600 7.5pt 'JetBrains Mono', ui-monospace, monospace; letter-spacing: .12em; text-transform: uppercase; color: var(--accent); margin: 26px 0 8px; }
h1 { font-size: 26pt; line-height: 1.08; margin: 0 0 10px; letter-spacing: -0.02em; }
h2 { font-size: 15pt; margin: 0 0 10px; letter-spacing: -0.01em; }
h3 { font-size: 10.5pt; margin: 16px 0 6px; }
.verdict { font-size: 12pt; color: var(--ink); max-width: 165mm; }
.meta { font: 7.5pt 'JetBrains Mono', ui-monospace, monospace; color: var(--muted); margin-top: 8px; }
.tiles { display: grid; border-top: 1px solid var(--hair); border-bottom: 1px solid var(--hair); margin: 18px 0; }
.tile { padding: 12px 12px 12px 0; }
.tile + .tile { border-left: 1px solid var(--hair); padding-left: 12px; }
.tile .v { font: 600 19pt 'JetBrains Mono', ui-monospace, monospace; line-height: 1.1; }
.tile .l { font: 7.5pt 'JetBrains Mono', ui-monospace, monospace; color: var(--muted); margin-top: 4px; }
.good { color: var(--accent); } .bad { color: var(--crit); } .warn { color: var(--warn); }
section { margin-top: 22px; }
section.page { break-before: page; }
section.first { break-before: auto; }
.block { break-inside: avoid; margin-bottom: 14px; }
table { width: 100%; border-collapse: collapse; font-size: 9pt; }
th { text-align: left; font: 600 7pt 'JetBrains Mono', ui-monospace, monospace; letter-spacing: .06em; text-transform: uppercase; border-top: 1.5px solid var(--ink); border-bottom: 1px solid var(--ink); padding: 5px 6px 5px 0; }
td { border-bottom: 1px solid var(--hair); padding: 5px 6px 5px 0; vertical-align: top; }
tr { break-inside: avoid; }
td.n, th.n { text-align: right; font-family: 'JetBrains Mono', ui-monospace, monospace; white-space: nowrap; }
tr.hl td { background: var(--wash); }
.src { font: 7pt 'JetBrains Mono', ui-monospace, monospace; color: var(--muted); margin-top: 4px; }
.sev { font: 600 7pt 'JetBrains Mono', ui-monospace, monospace; text-transform: uppercase; }
.sev.crit { color: var(--crit); } .sev.high { color: var(--warn); }
.note { background: var(--wash); border-left: 3px solid var(--accent); padding: 8px 10px; font-size: 9.5pt; break-inside: avoid; }
ul.att { margin: 4px 0 0; padding-left: 16px; } ul.att li { margin: 2px 0; }
footer.colophon { margin-top: 26px; border-top: 1px solid var(--hair); padding-top: 8px; font: 7.5pt 'JetBrains Mono', ui-monospace, monospace; color: var(--muted); }
@media screen { body { background: #ECEBE6; } .wrap { background: #fff; padding: 16mm 15mm; margin: 24px auto; box-shadow: 0 1px 3px rgba(0,0,0,.08); } }
`;

type Row = PortfolioPayload['rows'][number];

function tiles(d: DashboardData, row: Row | null): string {
  const out: string[] = [];
  const cw = d.clickWindows;
  if (cw) {
    const ch = pct(cw.current, cw.prior);
    out.push(`<div class="tile"><div class="v">${num(cw.current)}</div><div class="l">Search Console clicks, last 28 days${ch ? ` (${ch} vs the prior 28)` : ''}</div></div>`);
  }
  if (d.healthScore) out.push(`<div class="tile"><div class="v">${num(d.healthScore.score)}<span style="font-size:10pt">/100</span></div><div class="l">Site health (${clean(d.healthScore.band)}): ${num(d.healthScore.errorPages)} of ${num(d.healthScore.totalPages)} pages have a critical or high issue</div></div>`);
  if (d.findings) {
    const crit = d.findings.byCheck.filter(b => b.severity === 'crit').reduce((s, b) => s + b.count, 0);
    const high = d.findings.byCheck.filter(b => b.severity === 'high').reduce((s, b) => s + b.count, 0);
    out.push(`<div class="tile"><div class="v ${crit ? 'bad' : 'good'}">${num(crit)}</div><div class="l">Critical findings open (${num(high)} high), audit of ${dateLabel(d.findings.finishedAt)}</div></div>`);
  }
  const phone = d.cwvField?.formFactors?.PHONE;
  if (phone) {
    const bands = (['lcp', 'inp', 'cls'] as const).map(k => phone.metrics[k]?.band ?? null);
    const known = bands.filter(Boolean);
    const pass = known.length === 3 && known.every(b => b === 'good');
    out.push(`<div class="tile"><div class="v ${pass ? 'good' : 'warn'}">${known.length < 3 ? 'Partial' : pass ? 'Pass' : 'Fail'}</div><div class="l">Core Web Vitals for real users on phones (CrUX, to ${dateLabel(phone.period.last)})</div></div>`);
  } else if (row?.organicTraffic.value != null) {
    out.push(`<div class="tile"><div class="v">${num(row.organicTraffic.value)}</div><div class="l">Organic traffic, estimated by DataForSEO (${clean(row.countryName)})</div></div>`);
  }
  return out.length ? `<div class="tiles" style="grid-template-columns:repeat(${out.length},1fr)">${out.join('')}</div>` : '';
}

function verdictLine(d: DashboardData): string {
  const fc = d.findings;
  const lastDelta = (d.auditDeltas ?? []).filter(a => a.runId === fc?.runId).pop();
  const v = buildVerdict({
    clicks: d.clickWindows ? { current: d.clickWindows.current, prior: d.clickWindows.prior ?? null } : d.summary ? { current: d.summary.current.clicks, prior: d.summary.prior?.clicks ?? null } : null,
    nonBrand: d.summary && d.brandedSplit ? { current: d.brandedSplit.nonBranded.clicks, prior: d.brandedSplit.priorNonBrandedClicks, brand: d.brandedSplit.brand } : null,
    criticalOpen: fc ? fc.byCheck.filter(b => b.severity === 'crit').reduce((s, b) => s + b.count, 0) : null,
    resolvedSinceLastAudit: lastDelta && !lastDelta.skipped ? lastDelta.resolved : null,
    resolvedNote: lastDelta && !lastDelta.skipped ? lastDelta.excluded?.note ?? null : null,
    pagesChanged: d.drift?.counts && !d.drift.staleness ? d.drift.counts.pagesChanged : null,
  });
  if (v.empty) return '';
  return `<p class="verdict">${v.segments.map(s => (s.n ? `<b>${clean(s.text)}</b>` : clean(s.text))).join('')}</p>`;
}

function performance(d: DashboardData): string {
  const parts: string[] = [];
  const mc = d.monthly;
  const months = (mc?.months ?? []).slice(-13);
  if (mc && months.length) {
    const shownNote = mc.months.length > months.length ? ` Showing the last ${months.length} of ${mc.months.length} months.` : '';
    parts.push(`<div class="block"><h3>Clicks and impressions by month</h3><table><thead><tr><th>Month</th><th class="n">Clicks</th><th class="n">Impressions</th><th class="n">Days held</th></tr></thead><tbody>${
      months.map(m => `<tr><td>${monthLabel(m.month)}${m.partial ? ' <span class="src">(partial)</span>' : ''}</td><td class="n">${num(m.clicks)}</td><td class="n">${num(m.impressions)}</td><td class="n">${m.days} of ${m.daysInMonth}</td></tr>`).join('')
    }</tbody></table><div class="src">Source: Google Search Console, ${dateLabel(mc.gscMinDate)} to ${dateLabel(mc.gscMaxDate)}. A partial month is incomplete and is never compared as a whole one.${shownNote}${mc.truncated ? ` ${mc.truncated.monthsHeld} months are held in all.` : ''}</div></div>`);
  }
  const pm = d.pageMovers;
  if (pm && (pm.gaining.length || pm.losing.length)) {
    const rows = (xs: typeof pm.gaining, label: string): string => xs.map(x => `<tr><td>${label}</td><td>${clean(pathOf(x.urlKey))}</td><td class="n">${num(x.prevClicks)}</td><td class="n">${num(x.clicks)}</td><td class="n">${x.change >= 0 ? '+' : ''}${num(x.change)}</td></tr>`).join('');
    parts.push(`<div class="block"><h3>Biggest page movers</h3><table><thead><tr><th></th><th>Page</th><th class="n">Prior 28 days</th><th class="n">Last 28 days</th><th class="n">Change</th></tr></thead><tbody>${rows(pm.gaining, 'Up')}${rows(pm.losing, 'Down')}</tbody></table><div class="src">Clicks. Pages with at least ${num(pm.minPriorClicks)} clicks in the prior window (${num(pm.eligible)} eligible).</div></div>`);
  }
  const bs = d.brandedSplit;
  if (bs) {
    parts.push(`<div class="block"><h3>Branded and non-branded search</h3><table><thead><tr><th>Queries</th><th class="n">Clicks</th><th class="n">Impressions</th><th class="n">Clicks, prior window</th></tr></thead><tbody>
      <tr><td>Branded (${clean(bs.brand)})</td><td class="n">${num(bs.branded.clicks)}</td><td class="n">${num(bs.branded.impressions)}</td><td class="n">${num(bs.priorBrandedClicks)}</td></tr>
      <tr><td>Non-branded</td><td class="n">${num(bs.nonBranded.clicks)}</td><td class="n">${num(bs.nonBranded.impressions)}</td><td class="n">${num(bs.priorNonBrandedClicks)}</td></tr>
    </tbody></table><div class="src">Brand detection is a heuristic on the domain name; ${num(bs.brandedQueries)} queries matched.</div></div>`);
  }
  return parts.length ? `<section class="page first"><h2>01. Search performance</h2>${parts.join('')}</section>` : '';
}

function fixes(d: DashboardData): string {
  const f = d.findings;
  if (!f) return '';
  const top = f.top.slice(0, TOP_FINDINGS);
  const byCat = f.byCategory ?? [];
  const parts: string[] = [];
  if (top.length) {
    parts.push(`<div class="block"><h3>The ${top.length} highest-priority fixes</h3><table><thead><tr><th>Issue</th><th>Page</th><th>Severity</th><th class="n">Impact</th></tr></thead><tbody>${
      top.map(t => `<tr><td>${clean(checkTitle(t.check_id))}</td><td>${clean(pathOf(t.url_key))}</td><td><span class="sev ${esc(t.severity)}">${esc(SEV[t.severity] ?? t.severity)}</span></td><td class="n">${t.impact != null ? num(t.impact) : '-'}${t.size ? ` ${esc(t.size)}` : ''}</td></tr>`).join('')
    }</tbody></table><div class="src">Ordered by expected clicks recovered per hour of work. Impact is 0 to 100 against this audit's top finding; the letter is the effort (S to XL). ${num(f.total)} findings in total, audit of ${dateLabel(f.finishedAt)}.</div></div>`);
  }
  if (byCat.length) {
    parts.push(`<div class="block"><h3>Findings by area</h3><table><thead><tr><th>Area</th><th class="n">Critical</th><th class="n">High</th><th class="n">Medium</th><th class="n">Low</th><th class="n">New</th><th class="n">Resolved</th></tr></thead><tbody>${
      byCat.map(c => `<tr><td>${clean(AREA[c.category] ?? c.category)}${c.capped ? ' <span class="src">(at least)</span>' : ''}</td><td class="n">${num(c.crit)}</td><td class="n">${num(c.high)}</td><td class="n">${num(c.med)}</td><td class="n">${num(c.low)}</td><td class="n">${c.opened == null ? '-' : num(c.opened)}</td><td class="n">${c.resolved == null ? '-' : num(c.resolved)}</td></tr>`).join('')
    }</tbody></table><div class="src">Counts are affected pages per severity. New and resolved compare with the previous comparable audit; a dash means there isn't one.</div></div>`);
  }
  return parts.length ? `<section class="page"><h2>02. What to fix first</h2>${parts.join('')}</section>` : '';
}

function portfolioSection(p: PortfolioPayload | null, domain: string): string {
  if (!p || !p.rows.length) return '';
  const mine = p.rows.find(r => r.domain === domain) ?? null;
  // Each series' change carries its OWN months (Labs and backlink history lag the calendar), so the
  // window is printed beside the change rather than claimed once for the whole table.
  const chg = (m: { month: { from: string; to: string; mode: 'pct' | 'abs'; value: number } | null } | undefined): string => {
    const c = m?.month; if (!c) return '';
    return ` <span class="src">${c.value >= 0 ? '+' : ''}${c.mode === 'pct' ? `${Math.round(c.value)}%` : num(c.value)} (${monthLabel(c.to.slice(0, 7))} vs ${monthLabel(c.from.slice(0, 7))})</span>`;
  };
  const parts: string[] = [];
  if (mine) {
    const att = mine.attention.length ? `<div class="note"><b>Needs attention</b><ul class="att">${mine.attention.map(a => `<li>${clean(a)}</li>`).join('')}</ul></div>` : '';
    parts.push(`<div class="block"><h3>${clean(mine.domain)} in its market (${clean(mine.countryName)})</h3><table><thead><tr><th>Measure</th><th class="n">Latest</th><th>Source</th></tr></thead><tbody>
      ${mine.clicks28 ? `<tr><td>Clicks, last 28 days</td><td class="n">${num(mine.clicks28.value)}</td><td>Search Console (measured)</td></tr>` : ''}
      <tr><td>Organic traffic</td><td class="n">${num(mine.organicTraffic.value)}${chg(mine.organicTraffic)}</td><td>DataForSEO Labs (estimated)</td></tr>
      <tr><td>Organic keywords</td><td class="n">${num(mine.organicKeywords.value)}${chg(mine.organicKeywords)}</td><td>DataForSEO Labs</td></tr>
      <tr><td>Referring domains</td><td class="n">${num(mine.referringDomains.value)}${chg(mine.referringDomains)}</td><td>DataForSEO Backlinks</td></tr>
      <tr><td>Domain Rank (0 to 100)</td><td class="n">${num(mine.domainRank.value)}</td><td>DataForSEO Backlinks</td></tr>
      <tr><td>AI mentions</td><td class="n">${num(mine.aiMentions.value)}${chg(mine.aiMentions)}</td><td>DataForSEO LLM Mentions (AI Overviews and ChatGPT)</td></tr>
    </tbody></table><div class="src">Latest is the most recent value held; the change beside it compares the two months named, each series' own latest complete month with the one before. A dash means not fetched.</div></div>${att}`);
  }
  const rows = p.rows.slice(0, PRINT_PORTFOLIO_ROWS);
  const more = p.rows.length - rows.length;
  parts.push(`<div class="block"><h3>All domains</h3><table><thead><tr><th>Domain</th><th>Type</th><th class="n">Clicks 28d</th><th class="n">Organic traffic (est.)</th><th class="n">Referring domains</th><th class="n">AI mentions</th><th class="n">Alerts</th></tr></thead><tbody>${
    rows.map(r => `<tr${r.domain === domain ? ' class="hl"' : ''}><td>${clean(r.domain)} <span class="src">${esc(r.country)}</span></td><td>${r.kind === 'owned' ? 'Owned' : 'Watched'}</td><td class="n">${r.clicks28 ? num(r.clicks28.value) : '-'}</td><td class="n">${num(r.organicTraffic.value)}</td><td class="n">${num(r.referringDomains.value)}</td><td class="n">${num(r.aiMentions.value)}</td><td class="n">${r.attention.length || '-'}</td></tr>`).join('')
  }</tbody></table><div class="src">${num(p.counts.owned)} owned, ${num(p.counts.watched)} watched.${more > 0 ? ` Showing ${rows.length} of ${p.rows.length} domains; the dashboard lists them all.` : ''} Clicks are measured by Search Console; traffic, links and mentions are DataForSEO estimates for each row's country.</div></div>`);
  return `<section class="page"><h2>03. Portfolio</h2>${parts.join('')}</section>`;
}

function colophon(d: DashboardData, version: string, now: Date): string {
  const LABEL: Record<string, string> = { sync: 'Search Console', crawl: 'Crawl', audit: 'Audit', inspect: 'URL inspection', ranks: 'Ranks', sitemap: 'Sitemap' };
  const list = (d.freshness?.sources ?? []).filter(s => s.at && s.state === 'completed').map(s => `${LABEL[s.kind] ?? clean(s.kind)} ${dateLabel(s.at)}`).join(', ');
  return `<footer class="colophon">Generated ${dateLabel(now.toISOString())} by SEO Audit Console ${esc(version)} (houtini.com).${list ? ` Data as of: ${list}.` : ''} Deterministic findings cite the bytes or rows they come from; estimates are labelled as estimates.</footer>`;
}

/** The report as one HTML document. */
export function buildPrintReport(input: PrintReportInput): string {
  const { data: d, portfolio, domain, version } = input;
  const now = input.now ?? new Date();
  const row = portfolio?.rows.find(r => r.domain === domain) ?? null;
  const month = now.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).toUpperCase();
  const cover = `<header class="top"><span class="brand">Houtini<span style="color:var(--accent)">.</span></span><span class="mono" style="font-size:7.5pt;color:var(--muted);text-transform:uppercase;letter-spacing:.08em">SEO report</span></header>
    <div class="kick">SEO REPORT, ${esc(month)}</div>
    <h1>${clean(domain)}</h1>
    ${verdictLine(d)}
    <div class="meta">${clean(d.siteUrl)}${d.dateRange ? `, Search Console to ${dateLabel(d.dateRange.maxDate)}` : ''}</div>
    ${tiles(d, row)}`;
  const body = [performance(d), fixes(d), portfolioSection(portfolio, domain)].filter(Boolean).join('');
  const empty = body ? '' : '<p class="note">No Search Console, audit or portfolio data yet for this property. Sync it, crawl it and run an audit, then export again.</p>';
  return `<!DOCTYPE html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${clean(domain)} SEO report</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=Schibsted+Grotesk:wght@400;600;700&display=swap" rel="stylesheet">
<style>${CSS}</style></head><body><div class="wrap">${cover}${empty}${body}${colophon(d, version, now)}</div></body></html>`;
}
