// SEO Console - the domain overview (a Semrush Domain Overview equivalent) for one portfolio domain.
// Layout from the Stitch round (design/portfolio/stitch/CRITIQUE.md), AI view ranked in SPEC.md v1.1.
// First draft by deepseek-v4-pro from a written brief; reviewed and corrected here. Honesty rules:
// estimated vs measured are always labelled; the partial month is hollow "to date"; unknown is never
// "no"; no AI visibility score.
import { esc, fmtNum, fmtCompact, fmtDate, fmtMonth } from './lib/h.js';
import { EChartWrapper, chartPalette, axisDefaults, tooltipDefaults, monoFont } from './lib/echart.js';

type Change = { from: string; to: string; mode: 'pct' | 'abs'; value: number; diff: number };
type Metric = { value: number | null; source: 'snapshot' | 'history' | null; asOf: string | null; month: Change | null; year: Change | null; spark: (number | null)[]; partial: number | null; empty?: string };
type CrawlState = { status: number | null; indexable: boolean | null; label: string };
type DomainSeries = {
  month: string; partial: boolean; organicEtv: number | null; paidEtv: number | null; organicCount: number | null;
  buckets: { pos_1_3: number | null; pos_4_10: number | null; pos_11_20: number | null; pos_21_50: number | null; pos_51_100: number | null };
  referringMainDomains: number | null; rank: number | null; newReferringMainDomains: number | null; lostReferringMainDomains: number | null;
  aiGoogle: { mentions: number | null; volume: number | null }; aiChatgpt: { mentions: number | null; volume: number | null };
  gscClicks: number | null;
};
type DomainOverview = {
  version: string;
  row: {
    domain: string; locationCode: number; country: string; countryName: string; kind: 'owned' | 'watched'; group: string | null; siteUrls: string[];
    clicks28: { value: number; prior: number; change: Change; window: { start: string; end: string } } | null;
    audit: { score: number; prior: number | null; at: string } | null;
    organicKeywords: Metric; organicTraffic: Metric; paidKeywords: Metric; paidTraffic: Metric; referringDomains: Metric; domainRank: Metric;
    aiMentions: Metric & { platforms: { google: number | null; chat_gpt: number | null }; chatgptUsOnly: boolean };
    attention: string[];
  };
  months: { lastComplete: string; previous: string; yearAgo: string; current: string };
  series: DomainSeries[];
  serpMix: { organic: number | null; paid: number | null; aiOverviewReference: number | null; featuredSnippet: number | null; localPack: number | null; capturedAt: string } | null;
  trafficShare: { basis: string; domains: { domain: string; etv: number; share: number }[] } | null;
  countries: { code: number; iso: string; name: string; etv: number; count: number; share: number }[];
  topPages: {
    traffic: { url: string; etv: number | null; keywords: number | null; crawl: CrawlState | null; clicks28: number | null }[];
    links: { url: string; referringDomains: number | null; backlinks: number | null; brokenBacklinks: number | null; crawl: CrawlState | null; clicks28: number | null }[];
    cited: { url: string; mentions: number | null; volume: number | null; crawl: CrawlState | null; clicks28: number | null }[];
  };
  citedSources: { domain: string; mentions: number | null; volume: number | null }[];
  rankCitation: { keyword: string; url: string; aioPresent: boolean | null; aioCitesUs: boolean | null; organicRank: number | null; gscPosition: number | null; impressions: number | null; researchedAt: string | null }[];
  gsc: { clicks28: number; impressions28: number; pagesWithClicks: number; window: { start: string; end: string } } | null;
  capturedAt: { weekly: string | null; monthly: string | null };
  notes: string[];
};

let charts: EChartWrapper[] = [];
let aiCharts: EChartWrapper[] = [];

function ensureStyles(): void {
  if (document.getElementById('pf-domain-style')) return;
  const style = document.createElement('style');
  style.id = 'pf-domain-style';
  style.textContent = `
    .pf-domain{font-family:var(--font);color:var(--text-primary);min-height:100%;}
    .pf-domain *{box-sizing:border-box;}
    .pf-domain .pf-wrap{display:flex;flex-direction:column;gap:16px;padding-bottom:40px;}
    .pf-domain .pf-card{background:var(--bg-card);border:1px solid var(--border-standard);border-radius:var(--radius);padding:16px 18px;min-width:0;}
    .pf-domain .pf-card{overflow-x:auto;}
    .pf-domain .pf-search-grid>*,.pf-domain .pf-two-col>*,.pf-domain .pf-ai-grid-two>*,.pf-domain .pf-donut-wrap>*{min-width:0;}
    .pf-domain .pf-section-label{font-family:var(--font-mono);font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--text-muted);margin:0 0 12px;}
    .pf-domain .pf-card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px;}
    .pf-domain .pf-topline{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:13px;}
    .pf-domain .pf-back{background:none;border:0;padding:0;color:var(--accent);cursor:pointer;font-size:13px;text-decoration:underline;text-underline-offset:2px;}
    .pf-domain .pf-breadcrumb{color:var(--text-muted);}
    .pf-domain .pf-title-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:8px;}
    .pf-domain .pf-title{font-family:var(--font-mono);font-size:22px;line-height:1.2;margin:0;color:var(--text-primary);word-break:break-word;}
    .pf-domain .pf-badge{display:inline-flex;align-items:center;border-radius:var(--radius-pill);padding:2px 8px;font-size:11px;font-weight:500;font-family:var(--font-mono);}
    .pf-domain .pf-badge-owned{color:var(--intent-success);background:color-mix(in srgb, var(--intent-success) 12%, transparent);}
    .pf-domain .pf-badge-watched{color:var(--text-secondary);background:var(--bg-inset);}
    .pf-domain .pf-country{font-family:var(--font-mono);font-size:12px;color:var(--text-secondary);background:var(--bg-inset);border-radius:var(--radius-sm);padding:2px 8px;}
    .pf-domain .pf-group{color:var(--text-muted);font-size:12px;}
    .pf-domain .pf-header-spacer{flex:1;}
    .pf-domain .pf-meta{display:flex;align-items:center;gap:12px;flex-wrap:wrap;color:var(--text-secondary);font-size:12px;}
    .pf-domain .pf-meta a{color:var(--accent);text-decoration:none;}
    .pf-domain .pf-meta a:hover{text-decoration:underline;}
    .pf-domain .pf-attention{background:color-mix(in srgb, var(--intent-danger) 8%, transparent);border:1px solid color-mix(in srgb, var(--intent-danger) 25%, transparent);border-radius:var(--radius-sm);padding:8px 12px;margin-top:12px;}
    .pf-domain .pf-attention ul{list-style:none;margin:0;padding:0;}
    .pf-domain .pf-attention li{display:flex;align-items:center;gap:8px;color:var(--text-secondary);font-size:13px;padding:2px 0;}
    .pf-domain .pf-attention li::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--intent-danger);flex:0 0 auto;}
    .pf-domain .pf-search-grid{display:grid;grid-template-columns:2fr 1fr;gap:16px;}
    .pf-domain .pf-kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;}
    .pf-domain .pf-kpis.pf-gsc{grid-template-columns:1fr;}
    .pf-domain .pf-kpi-tile{background:var(--bg-inset);border:1px solid var(--border-subtle);border-radius:var(--radius-sm);padding:10px 12px;min-width:0;}
    .pf-domain .pf-kpi-label{font-size:12px;color:var(--text-secondary);margin-bottom:6px;}
    .pf-domain .pf-kpi-value{font-family:var(--font-mono);font-size:18px;line-height:1.15;color:var(--text-primary);font-variant-numeric:tabular-nums;display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
    .pf-domain .pf-kpi-caption{display:block;font-size:11px;color:var(--text-muted);margin-top:4px;}
    .pf-domain .pf-kpi-caption.pf-empty{font-style:italic;}
    .pf-domain .pf-null{color:var(--text-muted);}
    .pf-domain .pf-chip{display:inline-flex;align-items:center;padding:1px 7px;border-radius:var(--radius-pill);font-family:var(--font-mono);font-size:11px;font-weight:500;white-space:nowrap;}
    .pf-domain .pf-up{color:var(--intent-success);background:color-mix(in srgb, var(--intent-success) 12%, transparent);}
    .pf-domain .pf-down{color:var(--intent-danger);background:color-mix(in srgb, var(--intent-danger) 12%, transparent);}
    .pf-domain .pf-neutral{color:var(--text-muted);background:var(--bg-inset);}
    .pf-domain .pf-muted{color:var(--text-muted);font-size:13px;padding:12px 0;}
    .pf-domain .pf-traffic-share{margin-top:16px;border-top:1px solid var(--border-subtle);padding-top:14px;}
    .pf-domain .pf-share-label{font-size:13px;color:var(--text-secondary);margin-bottom:8px;}
    .pf-domain .pf-share-track{display:flex;height:10px;border-radius:var(--radius-pill);overflow:hidden;background:var(--bg-inset);border:1px solid var(--border-subtle);}
    .pf-domain .pf-share-seg{height:100%;min-width:2px;}
    .pf-domain .pf-share-seg.pf-own{outline:2px solid var(--text-primary);outline-offset:-2px;}
    .pf-domain .pf-share-legend{display:flex;flex-wrap:wrap;gap:12px;margin-top:8px;font-size:12px;color:var(--text-secondary);}
    .pf-domain .pf-share-legend-item{display:inline-flex;align-items:center;gap:6px;font-family:var(--font-mono);}
    .pf-domain .pf-dot{width:8px;height:8px;border-radius:50%;display:inline-block;}
    .pf-domain .pf-segmented{display:inline-flex;background:var(--bg-inset);border:1px solid var(--border-subtle);border-radius:var(--radius-pill);padding:2px;gap:2px;}
    .pf-domain .pf-seg-btn{appearance:none;border:0;background:transparent;color:var(--text-secondary);padding:5px 10px;border-radius:var(--radius-pill);font-size:12px;cursor:pointer;white-space:nowrap;}
    .pf-domain .pf-seg-btn.is-active{background:var(--bg-surface);color:var(--text-primary);box-shadow:0 0 0 1px var(--border-standard);}
    .pf-domain .pf-ai-kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px;}
    .pf-domain .pf-chart{height:260px;width:100%;}
    .pf-domain .pf-chart-sm{height:280px;width:100%;}
    .pf-domain .pf-chart-tall{height:300px;width:100%;}
    .pf-domain .pf-chart-pie{height:260px;width:100%;}
    .pf-domain .pf-ai-note{color:var(--text-muted);font-size:12px;margin-top:10px;line-height:1.5;}
    .pf-domain .pf-two-col{display:grid;grid-template-columns:1fr 1fr;gap:16px;}
    .pf-domain .pf-ai-grid-two{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:18px;}
    .pf-domain .pf-donut-wrap{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(200px,1fr);gap:16px;align-items:center;}
    .pf-domain .pf-table{width:100%;border-collapse:collapse;border-spacing:0;font-variant-numeric:tabular-nums;}
    .pf-domain .pf-table th{font-size:12px;color:var(--text-muted);font-weight:500;text-align:left;white-space:nowrap;padding:7px 10px;border-bottom:1px solid var(--border-subtle);}
    .pf-domain .pf-table td{padding:7px 10px;font-size:13px;color:var(--text-primary);border-bottom:1px solid var(--border-subtle);vertical-align:top;}
    .pf-domain .pf-table tr:last-child td{border-bottom:0;}
    .pf-domain .pf-table td.n,.pf-domain .pf-table th.n{text-align:right;font-family:var(--font-mono);}
    .pf-domain .pf-pill{display:inline-flex;align-items:center;border-radius:var(--radius-pill);padding:1px 8px;font-size:11px;white-space:nowrap;}
    .pf-domain .pf-pill.pf-yes{color:var(--intent-success);background:color-mix(in srgb, var(--intent-success) 12%, transparent);}
    .pf-domain .pf-pill.pf-no{color:var(--text-secondary);background:var(--bg-inset);}
    .pf-domain .pf-pill.pf-unknown{color:var(--text-muted);background:transparent;border:1px dashed var(--border-standard);}
    .pf-domain .pf-pill.pf-warn{color:var(--intent-warning);background:color-mix(in srgb, var(--intent-warning) 12%, transparent);}
    .pf-domain .pf-pill.pf-danger{color:var(--intent-danger);background:color-mix(in srgb, var(--intent-danger) 12%, transparent);}
    .pf-domain .pf-row-error td{background:color-mix(in srgb, var(--intent-danger) 7%, transparent);}
    .pf-domain .pf-row-note{color:var(--intent-danger);font-size:11px;margin-top:3px;}
    .pf-domain .pf-url{display:inline-block;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle;color:var(--accent);text-decoration:none;font-family:var(--font-mono);font-size:12px;}
    .pf-domain .pf-url:hover{text-decoration:underline;}
    .pf-domain .pf-inline-bar{height:6px;background:var(--bg-inset);border-radius:var(--radius-pill);overflow:hidden;min-width:70px;}
    .pf-domain .pf-inline-fill{height:100%;background:var(--accent);}
    .pf-domain .pf-caption{color:var(--text-muted);font-size:12px;margin-top:8px;}
    .pf-domain .pf-tabs{display:flex;gap:6px;border-bottom:1px solid var(--border-subtle);width:100%;flex-wrap:wrap;margin-bottom:12px;}
    .pf-domain .pf-tab{appearance:none;background:transparent;border:0;color:var(--text-secondary);padding:8px 10px;border-bottom:2px solid transparent;cursor:pointer;font-size:13px;}
    .pf-domain .pf-tab.is-active{color:var(--text-primary);border-color:var(--accent);}
    @media(max-width:1100px){
      .pf-domain .pf-search-grid,.pf-domain .pf-two-col,.pf-domain .pf-ai-grid-two,.pf-domain .pf-donut-wrap{grid-template-columns:1fr;}
      .pf-domain .pf-kpis,.pf-domain .pf-ai-kpis{grid-template-columns:repeat(2,1fr);}
    }
    @media(max-width:620px){ .pf-domain .pf-kpis,.pf-domain .pf-ai-kpis{grid-template-columns:1fr;} }
  `;
  document.head.appendChild(style);
}

function pathFromUrl(url: string): string {
  try { const u = new URL(url); return u.pathname + u.search; } catch { return url; }
}

function deltaChip(c: Change | null): string {
  if (!c) return '';
  const cls = c.value > 0 ? 'pf-up' : c.value < 0 ? 'pf-down' : 'pf-neutral';
  const sign = c.value > 0 ? '+' : c.value < 0 ? '-' : '';
  const text = c.mode === 'pct' ? `${sign}${Math.abs(c.value).toFixed(1)}%` : `${sign}${fmtNum(Math.abs(Math.round(c.value)))}`;
  return `<span class="pf-chip ${cls}">${text}</span>`;
}

// Unknown is its own state: a citation we couldn't resolve is never reported as "no".
function yesNoUnknownPill(value: boolean | null): string {
  if (value === true) return '<span class="pf-pill pf-yes">yes</span>';
  if (value === false) return '<span class="pf-pill pf-no">no</span>';
  return '<span class="pf-pill pf-unknown" title="Not resolved: the AI Overview or its citations did not load">unknown</span>';
}

function crawlPillHtml(crawl: CrawlState | null, isOwned: boolean): string {
  if (!isOwned) return '<span class="pf-pill pf-unknown" title="watched domain: no crawl">-</span>';
  if (!crawl || crawl.status === null) return '<span class="pf-pill pf-no">not crawled</span>';
  const s = crawl.status;
  const cls = s === 200 && crawl.indexable === false ? 'pf-warn' : s >= 300 ? 'pf-danger' : s >= 200 && s < 300 ? 'pf-yes' : 'pf-no';
  return `<span class="pf-pill ${cls}">${esc(crawl.label || String(s))}</span>`;
}

export function renderDomainOverview(root: HTMLElement, o: any, opts: { onBack: () => void }): void {
  charts.forEach(c => c.dispose()); charts = [];
  aiCharts.forEach(c => c.dispose()); aiCharts = [];
  ensureStyles();

  const data = o as DomainOverview;
  const pal = chartPalette();
  const isOwned = data.row.kind === 'owned';
  const isWeb = !!(window as any).__SAC_WEB__;
  const capturedAt = data.capturedAt.weekly ?? data.capturedAt.monthly;
  const capturedStr = capturedAt ? fmtDate(capturedAt) : 'never';
  const chatLabel = data.row.locationCode === 2840 ? 'ChatGPT' : 'ChatGPT (US)';

  const addChart = (el: HTMLElement | null, list: EChartWrapper[]): EChartWrapper | null => {
    if (!el) return null;
    const c = new EChartWrapper(el); list.push(c); return c;
  };

  const metricTile = (label: string, m: Metric, valueFmt: (v: number) => string, captionExtra?: string): string => {
    const valHtml = m.value === null ? '<span class="pf-null">-</span>' : esc(valueFmt(m.value));
    let caption = '';
    if (m.value === null) caption = `<span class="pf-kpi-caption pf-empty">${esc(m.empty ?? 'no data')}</span>`;
    else if (m.month) caption = `<span class="pf-kpi-caption">${esc(`${fmtMonth(m.month.to)} vs ${fmtMonth(m.month.from)}`)}${captionExtra ? `. ${esc(captionExtra)}` : ''}</span>`;
    else if (captionExtra) caption = `<span class="pf-kpi-caption">${esc(captionExtra)}</span>`;
    return `<div class="pf-kpi-tile"><div class="pf-kpi-label">${esc(label)}</div><div class="pf-kpi-value">${valHtml} ${m.value === null ? '' : deltaChip(m.month)}</div>${caption}</div>`;
  };
  const simpleKpi = (label: string, value: number | null, chip: string, caption: string): string =>
    `<div class="pf-kpi-tile"><div class="pf-kpi-label">${esc(label)}</div><div class="pf-kpi-value">${value === null ? '<span class="pf-null">-</span>' : esc(fmtCompact(value))} ${chip}</div><div class="pf-kpi-caption">${esc(caption)}</div></div>`;

  const attentionHtml = data.row.attention.length
    ? `<div class="pf-attention"><ul>${data.row.attention.map(a => `<li>${esc(a)}</li>`).join('')}</ul></div>` : '';
  const dashLink = isOwned && isWeb && data.row.siteUrls.length
    ? `<a href="/dashboard?siteUrl=${encodeURIComponent(data.row.siteUrls[0])}">Open property dashboard</a>` : '';

  const searchKpis = [
    metricTile('Domain Rank', data.row.domainRank, v => `${Math.round(v)} / 100`, 'DataForSEO, not an Authority Score'),
    metricTile('Organic traffic (estimated)', data.row.organicTraffic, v => fmtCompact(Math.round(v))),
    metricTile('Organic keywords', data.row.organicKeywords, fmtCompact),
    metricTile('Referring domains', data.row.referringDomains, fmtCompact),
    metricTile('Paid traffic (estimated)', data.row.paidTraffic, v => fmtCompact(Math.round(v))),
    metricTile('Paid keywords', data.row.paidKeywords, fmtCompact),
  ].join('');

  let gscHtml: string;
  if (!isOwned) gscHtml = '<div class="pf-muted">Search Console data exists only for owned sites.</div>';
  else if (!data.gsc) gscHtml = '<div class="pf-muted">No Search Console data yet for this site.</div>';
  else {
    const g = data.gsc;
    const cap = `${fmtDate(g.window.start)} to ${fmtDate(g.window.end)}`;
    gscHtml = `<div class="pf-kpis pf-gsc">
      ${simpleKpi('Clicks, 28 days', g.clicks28, deltaChip(data.row.clicks28?.change ?? null), cap)}
      ${simpleKpi('Impressions, 28 days', g.impressions28, '', cap)}
      ${simpleKpi('Pages with clicks', g.pagesWithClicks, '', cap)}
    </div><div class="pf-caption">Measured by Google, all countries</div>`;
  }

  let shareHtml = '';
  if (data.trafficShare) {
    const src = data.trafficShare;
    const own = src.domains.find(x => x.domain === data.row.domain) ?? null;
    const ordered = own ? [own, ...src.domains.filter(x => x.domain !== data.row.domain)] : src.domains;
    const colour = (i: number) => pal.categorical[i % pal.categorical.length];
    shareHtml = `<div class="pf-traffic-share">
      <div class="pf-share-label">Traffic share ${esc(src.basis)}: <strong>${own ? `${own.share.toFixed(1)}%` : 'not listed'}</strong></div>
      <div class="pf-share-track">${ordered.map((x, i) => `<div class="pf-share-seg ${x.domain === data.row.domain ? 'pf-own' : ''}" title="${esc(x.domain)} ${x.share.toFixed(1)}%" style="width:${Math.max(0, x.share)}%;background:${colour(i)}"></div>`).join('')}</div>
      <div class="pf-share-legend">${ordered.map((x, i) => `<span class="pf-share-legend-item"><span class="pf-dot" style="background:${colour(i)}"></span>${esc(x.domain)} ${x.share.toFixed(1)}%</span>`).join('')}</div>
    </div>`;
  }

  root.innerHTML = `
    <div class="pf-domain"><div class="pf-wrap">
      <header class="pf-card">
        <div class="pf-topline"><button class="pf-back" type="button" id="pf-back">Back to domains</button><span class="pf-breadcrumb">Domains / ${esc(data.row.domain)}</span></div>
        <div class="pf-title-row">
          <h1 class="pf-title">${esc(data.row.domain)}</h1>
          <span class="pf-country" title="${esc(data.row.countryName)}">${esc(data.row.country)}</span>
          ${isOwned ? '<span class="pf-badge pf-badge-owned">GSC</span>' : '<span class="pf-badge pf-badge-watched">Watched</span>'}
          ${data.row.group ? `<span class="pf-group">${esc(data.row.group)}</span>` : ''}
          <span class="pf-header-spacer"></span>
          <div class="pf-meta"><span>Data captured ${esc(capturedStr)}</span>${dashLink}</div>
        </div>
        ${attentionHtml}
      </header>
      <section class="pf-card">
        <div class="pf-search-grid">
          <div><div class="pf-section-label">Search (estimated, ${esc(data.row.countryName)})</div><div class="pf-kpis">${searchKpis}</div></div>
          <div><div class="pf-section-label">Search Console (measured)</div>${gscHtml}</div>
        </div>
        ${shareHtml}
      </section>
      <section class="pf-card">
        <div class="pf-card-head">
          <div class="pf-section-label" style="margin:0">AI search</div>
          <div class="pf-segmented" id="pf-seg-ai" role="group" aria-label="AI platform">
            <button class="pf-seg-btn is-active" type="button" data-ai="google">AI Overviews</button>
            <button class="pf-seg-btn" type="button" data-ai="chatgpt">${esc(chatLabel)}</button>
          </div>
        </div>
        <div id="pf-ai-body"></div>
      </section>
      <section class="pf-card"><div class="pf-section-label">Traffic trend</div><div id="pf-traffic-trend" class="pf-chart-tall"></div></section>
      <section class="pf-card"><div class="pf-two-col">
        <div><div class="pf-section-label">Keyword positions (estimated)</div><div id="pf-positions-chart" class="pf-chart"></div></div>
        <div><div class="pf-section-label">Search results mix</div>
          <div class="pf-donut-wrap"><div id="pf-serpmix-chart" class="pf-chart-pie"></div><div id="pf-serpmix-legend"></div></div>
          <div class="pf-caption">${data.serpMix ? `Keywords by result type, captured ${esc(fmtDate(data.serpMix.capturedAt))}` : ''}</div>
        </div>
      </div></section>
      <section class="pf-card"><div class="pf-section-label">Countries</div><div id="pf-countries-body"></div></section>
      <section class="pf-card"><div class="pf-section-label">Backlinks</div><div id="pf-backlinks-chart" class="pf-chart"></div><div class="pf-caption">Monthly, from DataForSEO backlinks history</div></section>
      <section class="pf-card">
        <div class="pf-tabs" id="pf-top-tabs" role="tablist">
          <button class="pf-tab is-active" type="button" data-tab="traffic">By traffic (estimated)</button>
          <button class="pf-tab" type="button" data-tab="links">By links</button>
          <button class="pf-tab" type="button" data-tab="cited">Cited in AI Overviews</button>
        </div>
        <div id="pf-top-pages-body"></div>
      </section>
    </div></div>`;

  const rootEl = root.querySelector<HTMLElement>('.pf-domain');
  if (!rootEl) return;

  const clicksCell = (clicks: number | null): string =>
    !isOwned ? '<td class="n" title="watched domain: no Search Console">-</td>' : `<td class="n">${clicks === null ? '-' : fmtNum(clicks)}</td>`;
  const pageCell = (url: string): string => `<a class="pf-url" href="${esc(url)}" target="_blank" rel="noopener" title="${esc(url)}">${esc(pathFromUrl(url))}</a>`;
  const n = (v: number | null): string => (v === null ? '-' : fmtNum(v));

  const renderCountries = (): void => {
    const body = rootEl.querySelector<HTMLElement>('#pf-countries-body');
    if (!body) return;
    if (!data.countries.length) { body.innerHTML = '<div class="pf-muted">No country breakdown yet.</div>'; return; }
    body.innerHTML = `<table class="pf-table"><thead><tr><th>Country</th><th class="n">Organic traffic (estimated)</th><th class="n">Keywords</th><th>Share</th></tr></thead>
      <tbody>${data.countries.slice(0, 8).map(c => `<tr><td>${esc(c.name)}</td><td class="n">${fmtCompact(Math.round(c.etv))}</td><td class="n">${fmtNum(c.count)}</td>
        <td><div style="display:flex;align-items:center;gap:8px;"><div class="pf-inline-bar" style="flex:1"><div class="pf-inline-fill" style="width:${Math.max(0, Math.min(100, c.share))}%"></div></div><span style="font-family:var(--font-mono);font-size:12px">${c.share.toFixed(1)}%</span></div></td></tr>`).join('')}</tbody></table>`;
  };

  const renderTopPages = (tab: string): void => {
    const body = rootEl.querySelector<HTMLElement>('#pf-top-pages-body');
    if (!body) return;
    if (tab === 'traffic') {
      const rows = data.topPages.traffic;
      body.innerHTML = !rows.length ? '<div class="pf-muted">No top pages by traffic yet.</div>' : `<table class="pf-table">
        <thead><tr><th>Page</th><th class="n">Organic traffic (estimated)</th><th class="n">Keywords</th><th>Our crawl status</th><th class="n">Clicks, 28 days</th></tr></thead>
        <tbody>${rows.map(r => `<tr><td>${pageCell(r.url)}</td><td class="n">${r.etv === null ? '-' : fmtCompact(Math.round(r.etv))}</td><td class="n">${n(r.keywords)}</td><td>${crawlPillHtml(r.crawl, isOwned)}</td>${clicksCell(r.clicks28)}</tr>`).join('')}</tbody></table>`;
      return;
    }
    if (tab === 'links') {
      const rows = data.topPages.links;
      body.innerHTML = !rows.length ? '<div class="pf-muted">No top pages by links yet.</div>' : `<table class="pf-table">
        <thead><tr><th>Page</th><th class="n">Referring domains</th><th class="n">Backlinks</th><th class="n">Broken backlinks</th><th>Our crawl status</th><th class="n">Clicks, 28 days</th></tr></thead>
        <tbody>${rows.map(r => {
          const bad = isOwned && r.crawl?.status != null && r.crawl.status >= 400;
          return `<tr class="${bad ? 'pf-row-error' : ''}"><td>${pageCell(r.url)}${bad ? `<div class="pf-row-note">Linked page returns ${r.crawl!.status} in our crawl</div>` : ''}</td>
            <td class="n">${n(r.referringDomains)}</td><td class="n">${n(r.backlinks)}</td><td class="n">${n(r.brokenBacklinks)}</td><td>${crawlPillHtml(r.crawl, isOwned)}</td>${clicksCell(r.clicks28)}</tr>`;
        }).join('')}</tbody></table>`;
      return;
    }
    const rows = data.topPages.cited;
    body.innerHTML = !rows.length ? '<div class="pf-muted">No pages cited in AI Overviews yet.</div>' : `<table class="pf-table">
      <thead><tr><th>Page</th><th class="n">Mentions</th><th>Our crawl status</th><th class="n">Clicks, 28 days</th></tr></thead>
      <tbody>${rows.map(r => `<tr><td>${pageCell(r.url)}</td><td class="n">${n(r.mentions)}</td><td>${crawlPillHtml(r.crawl, isOwned)}</td>${clicksCell(r.clicks28)}</tr>`).join('')}</tbody></table>`;
  };

  const renderAiSection = (platform: 'google' | 'chatgpt'): void => {
    const body = rootEl.querySelector<HTMLElement>('#pf-ai-body');
    if (!body) return;
    aiCharts.forEach(c => c.dispose()); aiCharts = [];
    const isGoogle = platform === 'google';
    const getM = (s: DomainSeries): number | null => (isGoogle ? s.aiGoogle.mentions : s.aiChatgpt.mentions);
    const getV = (s: DomainSeries): number | null => (isGoogle ? s.aiGoogle.volume : s.aiChatgpt.volume);
    const latest = (get: (s: DomainSeries) => number | null): { cur: DomainSeries; prev: DomainSeries | null } | null => {
      const complete = data.series.filter(s => !s.partial && get(s) !== null);
      if (!complete.length) return null;
      return { cur: complete[complete.length - 1], prev: complete.length > 1 ? complete[complete.length - 2] : null };
    };
    const chipFor = (cur: number, prev: number): string => (prev < 10
      ? deltaChip({ from: '', to: '', mode: 'abs', value: cur - prev, diff: cur - prev })
      : deltaChip({ from: '', to: '', mode: 'pct', value: ((cur - prev) / prev) * 100, diff: cur - prev }));
    const tile = (label: string, get: (s: DomainSeries) => number | null): string => {
      const l = latest(get);
      if (!l) return simpleKpi(label, null, '', 'No history yet');
      const cur = get(l.cur) as number;
      return simpleKpi(label, cur, l.prev ? chipFor(cur, get(l.prev) as number) : '', l.prev ? `${fmtMonth(l.cur.month)} vs ${fmtMonth(l.prev.month)}` : fmtMonth(l.cur.month));
    };

    const rc = data.rankCitation;
    const rankHtml = !isOwned || !rc.length
      ? '<div class="pf-muted">Content recon data exists for owned sites after recon_targets runs.</div>'
      : `<table class="pf-table"><thead><tr><th>Keyword</th><th>AI Overview shown</th><th>Our page cited</th><th class="n">Organic rank</th><th class="n">Impressions, 28 days</th></tr></thead>
        <tbody>${rc.slice(0, 12).map(r => `<tr><td>${esc(r.keyword)}</td><td>${yesNoUnknownPill(r.aioPresent)}</td><td>${yesNoUnknownPill(r.aioCitesUs)}</td>
          <td class="n">${r.organicRank === null ? '<span class="pf-null">not in top results</span>' : fmtNum(r.organicRank)}</td><td class="n">${n(r.impressions)}</td></tr>`).join('')}</tbody></table>`;
    const maxSrc = Math.max(...data.citedSources.map(s => s.mentions ?? 0), 1);
    const sourcesHtml = !data.citedSources.length ? '<div class="pf-muted">No co-cited sources yet.</div>'
      : `<table class="pf-table"><thead><tr><th>Domain</th><th class="n">Mentions</th><th>Relative</th></tr></thead>
        <tbody>${data.citedSources.slice(0, 10).map(s => `<tr><td>${esc(s.domain)}</td><td class="n">${n(s.mentions)}</td>
          <td><div class="pf-inline-bar"><div class="pf-inline-fill" style="width:${Math.max(0, Math.min(100, ((s.mentions ?? 0) / maxSrc) * 100))}%"></div></div></td></tr>`).join('')}</tbody></table>`;
    const citedHtml = !data.topPages.cited.length ? '<div class="pf-muted">No pages cited in AI Overviews yet.</div>'
      : `<table class="pf-table"><thead><tr><th>Page</th><th class="n">Mentions</th><th class="n">Clicks, 28 days</th><th>Our crawl status</th></tr></thead>
        <tbody>${data.topPages.cited.slice(0, 10).map(r => `<tr><td>${pageCell(r.url)}</td><td class="n">${n(r.mentions)}</td>${clicksCell(r.clicks28)}<td>${crawlPillHtml(r.crawl, isOwned)}</td></tr>`).join('')}</tbody></table>`;

    body.innerHTML = `
      <div class="pf-ai-kpis">
        ${tile('Mentions', getM)}
        ${tile('AI search volume', getV)}
        ${simpleKpi('Cited pages', data.topPages.cited.length, '', 'AI Overviews, own pages')}
      </div>
      <div id="pf-ai-combo" class="pf-chart"></div>
      <div class="pf-ai-note">${data.notes.map(x => esc(x)).join(' ')}</div>
      <div class="pf-ai-grid-two">
        <div><div class="pf-section-label">Keywords: rank and citation</div>${rankHtml}</div>
        <div><div class="pf-section-label">Rank and citation</div><div id="pf-ai-scatter" class="pf-chart-sm"></div></div>
      </div>
      <div class="pf-ai-grid-two">
        <div><div class="pf-section-label">Top cited pages</div>${citedHtml}</div>
        <div><div class="pf-section-label">Sources cited alongside</div>${sourcesHtml}<div class="pf-caption">Sources, not competitors.</div></div>
      </div>`;

    const combo = addChart(body.querySelector<HTMLElement>('#pf-ai-combo'), aiCharts);
    if (combo) {
      if (!data.series.some(s => getM(s) !== null || getV(s) !== null)) {
        combo.setEmpty('No AI mention history yet. Ask in chat to refresh the portfolio.', pal);
      } else {
        const months = data.series.map(s => (s.partial ? `${fmtMonth(s.month)} (to date)` : fmtMonth(s.month)));
        combo.setOption({
          tooltip: tooltipDefaults(pal, 'axis'),
          legend: { top: 0, left: 0, itemGap: 14, textStyle: { color: pal.text, fontFamily: monoFont(), fontSize: 11 } },
          grid: { left: 52, right: 60, top: 58, bottom: 28 },
          xAxis: { type: 'category', data: months, ...(axisDefaults(pal) as any) },
          yAxis: [
            { type: 'value', name: 'mentions', ...(axisDefaults(pal, { numeric: true }) as any) },
            { type: 'value', name: 'AI search volume', ...(axisDefaults(pal, { numeric: true }) as any), splitLine: { show: false } },
          ],
          series: [
            {
              name: 'Mentions', type: 'bar', barMaxWidth: 22, itemStyle: { color: pal.accent },
              data: data.series.map(s => {
                const v = getM(s);
                if (v === null) return null;
                return s.partial ? { value: v, itemStyle: { color: 'transparent', borderColor: pal.accent, borderType: 'dashed', borderWidth: 1 } } : v;
              }),
            },
            {
              name: 'AI search volume', type: 'line', yAxisIndex: 1, connectNulls: false,
              lineStyle: { color: pal.categorical[1], width: 2 }, itemStyle: { color: pal.categorical[1] },
              data: data.series.map(s => { const v = getV(s); return v === null ? null : s.partial ? { value: v, symbol: 'emptyCircle', symbolSize: 7 } : v; }),
            },
          ],
        } as any);
      }
    }

    const scatter = addChart(body.querySelector<HTMLElement>('#pf-ai-scatter'), aiCharts);
    if (scatter) {
      const rows = rc.filter(r => r.organicRank !== null && r.organicRank >= 1 && r.organicRank <= 100);
      if (!isOwned || !rows.length) {
        scatter.setEmpty(isOwned ? 'No rank and citation data yet.' : 'Rank and citation data exists for owned sites.', pal);
      } else {
        scatter.setOption({
          tooltip: { ...(tooltipDefaults(pal, 'item') as any), formatter: (p: any) => `${esc(p.data.keyword)}<br/>Rank ${p.data.rank}<br/>Cited: ${esc(p.data.cited)}<br/>Impressions: ${fmtNum(p.data.impressions)}` },
          grid: { left: 60, right: 20, top: 30, bottom: 36 },
          xAxis: { type: 'value', min: 1, max: 100, inverse: true, name: 'organic rank', nameLocation: 'middle', nameGap: 24, ...(axisDefaults(pal, { numeric: true }) as any) },
          yAxis: { type: 'value', min: -0.2, max: 1.2, interval: 0.5, ...(axisDefaults(pal) as any),
            axisLabel: { color: pal.axisText, fontFamily: monoFont(), fontSize: 10.5, formatter: (v: number) => (v === 0 ? 'not cited' : v === 0.5 ? 'unknown' : v === 1 ? 'cited' : '') } },
          series: [{
            type: 'scatter', itemStyle: { color: pal.accent, opacity: 0.75 },
            data: rows.map((r, i) => {
              const base = r.aioCitesUs === true ? 1 : r.aioCitesUs === false ? 0 : 0.5;
              return {
                value: [r.organicRank as number, base + ((i % 5) - 2) * 0.04],
                keyword: r.keyword, rank: r.organicRank, impressions: r.impressions ?? 0,
                cited: r.aioCitesUs === true ? 'yes' : r.aioCitesUs === false ? 'no' : 'unknown',
                symbolSize: Math.min(28, Math.max(6, 6 + Math.sqrt(r.impressions ?? 0) * 0.6)),
              };
            }),
          }],
          graphic: [
            { type: 'text', left: 70, top: 6, style: { text: 'Cited, not ranking', fill: pal.muted, fontFamily: monoFont(), fontSize: 11 } },
            { type: 'text', right: 26, top: 6, style: { text: 'Ranks and cited', fill: pal.muted, fontFamily: monoFont(), fontSize: 11 } },
            { type: 'text', left: 70, bottom: 40, style: { text: 'Neither', fill: pal.muted, fontFamily: monoFont(), fontSize: 11 } },
            { type: 'text', right: 26, bottom: 40, style: { text: 'Ranks, not cited', fill: pal.muted, fontFamily: monoFont(), fontSize: 11 } },
          ],
        } as any);
      }
    }
  };

  const trafficTrend = (): void => {
    const chart = addChart(rootEl.querySelector<HTMLElement>('#pf-traffic-trend'), charts);
    if (!chart) return;
    const rows = data.series;
    if (!rows.some(s => s.organicEtv !== null || s.paidEtv !== null || s.gscClicks !== null)) { chart.setEmpty('No traffic history yet. Ask in chat to refresh the portfolio.', pal); return; }
    const pts = (get: (s: DomainSeries) => number | null) => rows.map(s => { const v = get(s); return v === null ? null : s.partial ? { value: v, symbol: 'emptyCircle', symbolSize: 7 } : v; });
    const series: any[] = [
      { name: 'Organic traffic (estimated)', type: 'line', showSymbol: false, data: pts(s => s.organicEtv), lineStyle: { color: pal.accent, width: 2 }, itemStyle: { color: pal.accent } },
      { name: 'Paid traffic (estimated)', type: 'line', showSymbol: false, data: pts(s => s.paidEtv), lineStyle: { color: pal.categorical[3], width: 1.25 }, itemStyle: { color: pal.categorical[3] } },
    ];
    const hasGsc = rows.some(s => s.gscClicks !== null);
    if (hasGsc) series.push({ name: 'Search Console clicks (measured)', type: 'line', yAxisIndex: 1, showSymbol: false, data: pts(s => s.gscClicks), lineStyle: { color: pal.categorical[1], width: 1.5, type: 'dashed' }, itemStyle: { color: pal.categorical[1] } });
    chart.setOption({
      tooltip: tooltipDefaults(pal, 'axis'),
      legend: { top: 0, left: 0, itemGap: 14, textStyle: { color: pal.text, fontFamily: monoFont(), fontSize: 11 } },
      grid: { left: 56, right: hasGsc ? 64 : 24, top: 62, bottom: 28 },
      xAxis: { type: 'category', data: rows.map(s => (s.partial ? `${fmtMonth(s.month)} (to date)` : fmtMonth(s.month))), ...(axisDefaults(pal) as any) },
      yAxis: [
        { type: 'value', name: 'visits (estimated)', ...(axisDefaults(pal, { numeric: true }) as any) },
        ...(hasGsc ? [{ type: 'value', name: 'clicks (measured)', ...(axisDefaults(pal, { numeric: true }) as any), splitLine: { show: false } }] : []),
      ],
      series,
    } as any);
  };

  const positions = (): void => {
    const chart = addChart(rootEl.querySelector<HTMLElement>('#pf-positions-chart'), charts);
    if (!chart) return;
    const rows = data.series.filter(s => !s.partial && s.buckets.pos_1_3 !== null);
    if (!rows.length) { chart.setEmpty('No keyword position history yet.', pal); return; }
    const bands = [
      { name: 'Positions 1-3', key: 'pos_1_3' }, { name: 'Positions 4-10', key: 'pos_4_10' }, { name: 'Positions 11-20', key: 'pos_11_20' },
      { name: 'Positions 21-50', key: 'pos_21_50' }, { name: 'Positions 51-100', key: 'pos_51_100' },
    ] as const;
    chart.setOption({
      tooltip: tooltipDefaults(pal, 'axis'),
      legend: { top: 0, textStyle: { color: pal.text, fontFamily: monoFont(), fontSize: 11 } },
      grid: { left: 52, right: 20, top: 62, bottom: 28 },
      xAxis: { type: 'category', data: rows.map(r => fmtMonth(r.month)), ...(axisDefaults(pal) as any) },
      yAxis: { type: 'value', name: 'keywords', ...(axisDefaults(pal, { numeric: true }) as any) },
      series: bands.map((b, i) => ({
        name: b.name, type: 'line', stack: 'positions', symbol: 'none',
        areaStyle: { color: pal.categorical[i], opacity: 0.6 }, lineStyle: { color: pal.categorical[i], width: 1 }, itemStyle: { color: pal.categorical[i] },
        data: rows.map(r => r.buckets[b.key]),
      })),
    } as any);
  };

  const serpMix = (): void => {
    const chart = addChart(rootEl.querySelector<HTMLElement>('#pf-serpmix-chart'), charts);
    if (!chart) return;
    const mix = data.serpMix;
    if (!mix) { chart.setEmpty('No search results mix yet.', pal); return; }
    const entries = [
      { name: 'Organic', value: mix.organic }, { name: 'AI Overview references', value: mix.aiOverviewReference },
      { name: 'Featured snippets', value: mix.featuredSnippet }, { name: 'Local pack', value: mix.localPack }, { name: 'Paid', value: mix.paid },
    ];
    const total = entries.reduce((s, e) => s + (e.value ?? 0), 0);
    const legendEl = rootEl.querySelector<HTMLElement>('#pf-serpmix-legend');
    if (legendEl) {
      legendEl.innerHTML = `<table class="pf-table"><thead><tr><th>Result type</th><th class="n">Keywords</th><th class="n">Share</th></tr></thead>
        <tbody>${entries.map(e => `<tr><td>${esc(e.name)}</td><td class="n">${e.value === null ? '<span class="pf-null" title="not reported">-</span>' : fmtNum(e.value)}</td><td class="n">${e.value === null || !total ? '-' : `${((e.value / total) * 100).toFixed(1)}%`}</td></tr>`).join('')}</tbody></table>`;
    }
    const ring = entries.filter(e => e.value !== null && e.value > 0);
    if (!ring.length) { chart.setEmpty('No search results mix yet.', pal); return; }
    chart.setOption({
      tooltip: tooltipDefaults(pal, 'item'),
      series: [{
        type: 'pie', radius: ['50%', '72%'], center: ['50%', '50%'], avoidLabelOverlap: true,
        itemStyle: { borderColor: pal.surface, borderWidth: 2 }, label: { show: false },
        data: ring.map((e, i) => ({ name: e.name, value: e.value as number, itemStyle: { color: pal.categorical[i] } })),
      }],
    } as any);
  };

  const backlinks = (): void => {
    const chart = addChart(rootEl.querySelector<HTMLElement>('#pf-backlinks-chart'), charts);
    if (!chart) return;
    const rows = data.series.filter(s => !s.partial && (s.newReferringMainDomains !== null || s.lostReferringMainDomains !== null || s.referringMainDomains !== null));
    if (!rows.length) { chart.setEmpty('No backlinks history yet.', pal); return; }
    chart.setOption({
      tooltip: { ...(tooltipDefaults(pal, 'axis') as any), valueFormatter: (v: number) => (v == null ? '-' : fmtNum(Math.abs(v))) },
      legend: { top: 0, left: 0, itemGap: 14, textStyle: { color: pal.text, fontFamily: monoFont(), fontSize: 11 } },
      grid: { left: 52, right: 64, top: 62, bottom: 28 },
      xAxis: { type: 'category', data: rows.map(s => fmtMonth(s.month)), ...(axisDefaults(pal) as any) },
      yAxis: [
        { type: 'value', name: 'new and lost', ...(axisDefaults(pal, { numeric: true }) as any) },
        { type: 'value', name: 'total', ...(axisDefaults(pal, { numeric: true }) as any), splitLine: { show: false } },
      ],
      series: [
        { name: 'New referring domains', type: 'bar', stack: 'nl', barMaxWidth: 18, data: rows.map(s => s.newReferringMainDomains), itemStyle: { color: pal.success } },
        { name: 'Lost referring domains', type: 'bar', stack: 'nl', barMaxWidth: 18, data: rows.map(s => (s.lostReferringMainDomains === null ? null : -s.lostReferringMainDomains)), itemStyle: { color: pal.danger } },
        { name: 'Referring domains (total)', type: 'line', yAxisIndex: 1, showSymbol: false, data: rows.map(s => s.referringMainDomains), lineStyle: { color: pal.categorical[2], width: 2 }, itemStyle: { color: pal.categorical[2] } },
      ],
    } as any);
  };

  renderCountries();
  renderTopPages('traffic');
  renderAiSection('google');
  trafficTrend();
  positions();
  serpMix();
  backlinks();

  rootEl.querySelector<HTMLButtonElement>('#pf-back')?.addEventListener('click', () => opts.onBack());
  const seg = rootEl.querySelector<HTMLElement>('#pf-seg-ai');
  seg?.addEventListener('click', ev => {
    const t = (ev.target as HTMLElement).closest<HTMLElement>('[data-ai]');
    if (!t) return;
    seg.querySelectorAll('.pf-seg-btn').forEach(b => b.classList.toggle('is-active', b === t));
    renderAiSection(t.dataset.ai as 'google' | 'chatgpt');
  });
  const tabs = rootEl.querySelector<HTMLElement>('#pf-top-tabs');
  tabs?.addEventListener('click', ev => {
    const t = (ev.target as HTMLElement).closest<HTMLElement>('[data-tab]');
    if (!t) return;
    tabs.querySelectorAll('.pf-tab').forEach(b => b.classList.toggle('is-active', b === t));
    renderTopPages(t.dataset.tab || 'traffic');
  });
}
