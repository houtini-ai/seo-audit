import type { AuditResult } from './engine.js';

/**
 * Concise executive markdown summary of an audit run. Shared by the `run_audit` tool (returned
 * as the model-facing text) and the local shakedown/CLI path so both emit identical reports.
 */
export const SEV_ICON: Record<string, string> = { crit: '🔴', high: '🟠', med: '🟡', low: '⚪', info: '·' };
export const CAT_NAME: Record<string, string> = {
  integrity: 'Integrity', crawlability: 'Crawlability', indexation: 'Indexation', onpage: 'On-page',
  content: 'Content', schema: 'Structured data', security: 'Security', 'war-stories': 'Edge cases',
  performance: 'Performance (CWV)', merged: 'Search performance', agentic: 'AI readiness',
};

export function buildAuditMarkdown(r: AuditResult & { elapsedMs?: number }, siteUrl: string): string {
  const p = (s: string): any => { try { return JSON.parse(s || '{}'); } catch { return {}; } };
  const sev = r.bySeverity ?? {};
  const out: string[] = [
    `# SEO audit — ${siteUrl.replace(/^sc-domain:/, '')}`,
    `**${r.total} findings** · 🔴 ${sev.crit ?? 0} critical · 🟠 ${sev.high ?? 0} high · 🟡 ${sev.med ?? 0} medium · ⚪ ${sev.low ?? 0} low`,
  ];
  if (!r.integrityOk) out.push('> ⚠ Crawl integrity not verified — treat findings as provisional.');
  // Impact = priority normalised to the run's top finding (preserves magnitude: the #1 issue is
  // 100, a 10x-smaller one is 10). Shown as a size + index instead of a clicks "forecast" — the
  // raw expected-clicks figure reads as a promise, which it isn't. Real measured traffic stays.
  const maxPrio = Math.max(1, ...(r.top ?? []).map((f: any) => f.priority || 0));
  const sizeOf = (idx: number): string => idx >= 50 ? 'XL' : idx >= 20 ? 'L' : idx >= 5 ? 'M' : 'S';
  out.push('', '## Top priorities (impact vs effort)');
  (r.top ?? []).slice(0, 12).forEach((f: any, i: number) => {
    const rec = p(f.recommendation), traf = p(f.traffic_at_risk), eff = p(f.effort);
    const pth = (f.url_key || '—').replace(/^https?:\/\/[^/]+/, '') || '/';
    const tr = (traf.clicks || traf.impressions) ? ` · ${traf.clicks || 0} clicks / ${traf.impressions || 0} impr` : '';
    const idx = Math.round((f.priority || 0) / maxPrio * 100);
    const effort = eff.hours != null ? ` · ~${eff.hours}h` : '';
    out.push(`${i + 1}. ${SEV_ICON[f.severity] ?? '·'} **${rec.title || f.check_id}** — \`${pth}\` · impact ${sizeOf(idx)} (${idx}/100)${effort}${tr}`);
    if (rec.text) out.push(`   ${rec.text}`);
  });
  const byCat: Record<string, string[]> = {};
  for (const c of r.byCheck ?? []) (byCat[c.category] ??= []).push(`${c.checkId ?? (c as any).check_id} (${c.count})`);
  out.push('', '## All issues by category');
  for (const [cat, checks] of Object.entries(byCat)) out.push(`- **${CAT_NAME[cat] ?? cat}** — ${checks.join(', ')}`);
  const idx = r.indexability ?? {};
  const notIndexable = Object.entries(idx).filter(([k]) => k !== 'indexable');
  if (notIndexable.length) {
    out.push('', '## Indexability (crawled URLs)', `- ✅ indexable: ${idx.indexable ?? 0}`);
    for (const [reason, n] of notIndexable) out.push(`- ✗ ${reason}: ${n}`);
  }
  if (r.elapsedMs != null) out.push('', `_Audit computed in ${(r.elapsedMs / 1000).toFixed(1)}s._`);
  out.push('', `_\`export_report siteUrl:"${siteUrl}"\` → a shareable interactive HTML dashboard._`);
  return out.join('\n');
}
