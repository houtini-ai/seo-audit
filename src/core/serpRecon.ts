import type { DfsResponse } from './DataForSeoClient.js';

/**
 * Parse a DataForSEO SERP-advanced response into the fields content recon needs:
 * where WE actually rank in organic, whether the AI Overview cites us and who it does
 * cite, and how much of the SERP is video/product (format signals). This is the single
 * fetch that powers the organic-rank x AIO-citation verdict matrix.
 */
export interface SerpReconResult {
  itemTypes: string[];
  ourOrganicRank: number | null;      // our rank_group in the organic block, null if not in top depth
  aioPresent: boolean;
  aioCitesUs: boolean;
  aioAsync: boolean;                   // AIO present but references need a follow-up call
  aioReferences: { rank: number | null; domain: string; url: string; title: string }[];
  videoPresent: boolean;
  organicAbove: { rank: number; domain: string; url: string; title: string }[]; // organic ranked above us (or all, if we're absent)
  videoItems: { url: string; title: string; source: string }[];
}

/** Registrable-ish host: lowercase, strip scheme/path/www. Good enough to match a domain field. */
export function hostOf(s: string | undefined | null): string {
  if (!s) return '';
  return String(s).replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/^www\./i, '').toLowerCase().trim();
}

export function parseSerpForRecon(resp: DfsResponse, ownDomain: string): SerpReconResult {
  const own = hostOf(ownDomain);
  const result = resp.tasks?.[0]?.result?.[0] ?? {};
  const items: any[] = result.items ?? [];
  const itemTypes: string[] = result.item_types ?? [...new Set(items.map(i => i.type))];

  let ourOrganicRank: number | null = null;
  const organic: { rank: number; domain: string; url: string; title: string }[] = [];
  let aioPresent = false, aioCitesUs = false, aioAsync = false, videoPresent = false;
  const aioReferences: SerpReconResult['aioReferences'] = [];
  const videoItems: SerpReconResult['videoItems'] = [];

  for (const it of items) {
    const t = it.type;
    if (t === 'organic') {
      const domain = hostOf(it.domain || it.url);
      const rank = Number(it.rank_group) || organic.length + 1;
      organic.push({ rank, domain, url: it.url ?? '', title: it.title ?? '' });
      if (own && domain === own && ourOrganicRank == null) ourOrganicRank = rank;
    } else if (t === 'ai_overview') {
      aioPresent = true;
      aioAsync = !!it.asynchronous_ai_overview;
      const refs = it.references ?? [];
      let i = 0;
      for (const ref of refs) {
        const domain = hostOf(ref.domain || ref.url);
        aioReferences.push({ rank: Number(ref.rank_absolute) || ++i, domain, url: ref.url ?? '', title: ref.title ?? '' });
        if (own && domain === own) aioCitesUs = true;
      }
    } else if (t === 'video' || t === 'short_videos') {
      videoPresent = true;
      for (const v of it.items ?? []) {
        if (v?.url) videoItems.push({ url: v.url, title: v.title ?? '', source: hostOf(v.url) });
      }
    }
  }

  // Organic ranked above us (the ones actually beating us); if we're absent, the whole top block.
  const organicAbove = ourOrganicRank == null
    ? organic.slice(0, 8)
    : organic.filter(o => o.rank < ourOrganicRank!);

  return { itemTypes, ourOrganicRank, aioPresent, aioCitesUs, aioAsync, aioReferences, videoPresent, organicAbove, videoItems };
}

/**
 * The deterministic verdict from organic rank x AIO citation (Richard's rule):
 * strong organic but NOT in the AIO = a data-accuracy/freshness problem — Google ranks
 * us but won't quote us.
 */
export type ReconVerdict = 'defend-and-deepen' | 'accuracy-or-freshness' | 'consolidate-weak-page' | 'competitive-gap';

export function reconVerdict(r: SerpReconResult): { verdict: ReconVerdict; note: string } {
  const strongOrganic = r.ourOrganicRank != null && r.ourOrganicRank <= 5;
  const shape = r.videoPresent ? ' The SERP carries a video pack, so some click loss is format, not content.' : '';
  if (!r.aioPresent) {
    return strongOrganic
      ? { verdict: 'defend-and-deepen', note: `No AI Overview on this SERP; you rank organic #${r.ourOrganicRank}. Defend and deepen.${shape}` }
      : { verdict: 'competitive-gap', note: `No AI Overview; you rank organic ${r.ourOrganicRank ?? 'outside top results'}. Close the competitive gap.${shape}` };
  }
  if (strongOrganic && r.aioCitesUs) {
    return { verdict: 'defend-and-deepen', note: `You rank organic #${r.ourOrganicRank} and the AI Overview already cites you. Deepen to become the primary source.${shape}` };
  }
  if (strongOrganic && !r.aioCitesUs) {
    return { verdict: 'accuracy-or-freshness', note: `You rank organic #${r.ourOrganicRank} but the AI Overview does NOT cite you — a data-accuracy or freshness signal. Make the facts current, correct and marked up so they are liftable.${shape}` };
  }
  if (!strongOrganic && r.aioCitesUs) {
    return { verdict: 'consolidate-weak-page', note: `The AI Overview cites you but your organic rank is weak (${r.ourOrganicRank ?? 'absent'}) — you have a quotable nugget on an under-powered page; consolidate and strengthen it.${shape}` };
  }
  return { verdict: 'competitive-gap', note: `Not cited in the AI Overview and organic rank is ${r.ourOrganicRank ?? 'absent'} — full coverage gap; run the deep competitor diff.${shape}` };
}
