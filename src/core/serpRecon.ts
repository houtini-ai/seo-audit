import type { DfsResponse } from './DataForSeoClient.js';

/**
 * Parse a DataForSEO SERP-advanced response into the fields content recon needs:
 * where WE actually rank in organic, whether the AI Overview cites us and who it does
 * cite, and how much of the SERP is video/product (format signals). This is the single
 * fetch that powers the organic-rank x AIO-citation verdict matrix.
 */
export interface SerpReconResult {
  itemTypes: string[];
  ourOrganicRank: number | null;      // our rank_group in the organic block, null if not in the fetched depth
  serpDepth: number;                  // organic results requested — `ourOrganicRank: null` means "absent from the top N ORGANIC results", nothing more
  aioPresent: boolean;
  aioCitesUs: boolean | null;         // null = UNKNOWN (AIO present but unresolved — never read as "not cited")
  aioAsync: boolean;                  // Google loaded the AIO client-side; without load_async_ai_overview it comes back empty
  aioResolved: boolean;               // did we actually get AIO references to judge citation from?
  aioReferences: { rank: number | null; domain: string; url: string; title: string; nested: boolean }[];
  videoPresent: boolean;
  organicAbove: { rank: number; domain: string; url: string; title: string }[]; // organic ranked above us (or all, if we're absent)
  videoItems: { url: string; title: string; source: string }[];
}

/** Registrable-ish host: lowercase, strip scheme/path/www. Good enough to match a domain field. */
export function hostOf(s: string | undefined | null): string {
  if (!s) return '';
  return String(s).replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/^www\./i, '').toLowerCase().trim();
}

export function parseSerpForRecon(resp: DfsResponse, ownDomain: string, serpDepth = 20): SerpReconResult {
  const own = hostOf(ownDomain);
  const result = resp.tasks?.[0]?.result?.[0] ?? {};
  const items: any[] = result.items ?? [];
  const itemTypes: string[] = result.item_types ?? [...new Set(items.map(i => i.type))];

  let ourOrganicRank: number | null = null;
  const organic: { rank: number; domain: string; url: string; title: string }[] = [];
  let aioPresent = false, aioAsync = false, videoPresent = false;
  const aioReferences: SerpReconResult['aioReferences'] = [];
  const videoItems: SerpReconResult['videoItems'] = [];

  for (const it of items) {
    const t = it.type;
    if (t === 'organic') {
      const domain = hostOf(it.domain || it.url);
      const rank = Number(it.rank_group) || organic.length + 1;  // rank_group = position among ORGANIC results
      organic.push({ rank, domain, url: it.url ?? '', title: it.title ?? '' });
      if (own && domain === own && ourOrganicRank == null) ourOrganicRank = rank;
    } else if (t === 'ai_overview') {
      aioPresent = true;
      aioAsync = !!it.asynchronous_ai_overview;
      // Citations live in TWO places and the nested set is NOT a subset of the top-level one
      // (verified against cached responses: "ai website builder" had 1 top-level reference and
      // 3 further domains only present on the ai_overview_element chunks). Read both, dedupe.
      const seenRef = new Set<string>();
      let i = 0;
      const collect = (refs: any[], nested: boolean): void => {
        for (const ref of refs ?? []) {
          const url = ref?.url ?? '';
          if (!url || seenRef.has(url)) continue;
          seenRef.add(url);
          aioReferences.push({ rank: Number(ref.rank_absolute) || ++i, domain: hostOf(ref.domain || url), url, title: ref.title ?? '', nested });
        }
      };
      collect(it.references, false);
      for (const el of it.items ?? []) collect(el?.references, true);
    } else if (t === 'video' || t === 'short_videos') {
      videoPresent = true;
      for (const v of it.items ?? []) {
        if (v?.url) videoItems.push({ url: v.url, title: v.title ?? '', source: hostOf(v.source || v.domain || v.url) });
      }
    }
  }

  // Citation is only knowable when the AIO actually resolved. An async AIO with no references
  // is UNKNOWN, not "not cited" — 5 of 11 cached AIO SERPs came back that way, and reading them
  // as "not cited" manufactured accuracy-or-freshness verdicts out of a missing fetch.
  const aioResolved = aioPresent && aioReferences.length > 0;
  const aioCitesUs = !aioPresent ? false
    : aioResolved ? aioReferences.some(r => own && r.domain === own)
    : null;

  // Organic ranked above us (the ones actually beating us); if we're absent, the whole top block.
  const organicAbove = ourOrganicRank == null
    ? organic.slice(0, 8)
    : organic.filter(o => o.rank < ourOrganicRank!);

  return { itemTypes, ourOrganicRank, serpDepth, aioPresent, aioCitesUs, aioAsync, aioResolved, aioReferences, videoPresent, organicAbove, videoItems };
}

/**
 * The deterministic verdict from organic rank x AIO citation (Richard's rule):
 * strong organic but NOT in the AIO = a data-accuracy/freshness problem — Google ranks
 * us but won't quote us.
 */
export type ReconVerdict = 'defend-and-deepen' | 'accuracy-or-freshness' | 'consolidate-weak-page' | 'competitive-gap' | 'page-cannot-rank';

/** How to say "we didn't find you" without implying a position we never measured. Rank 11 and
 * rank 80 both come back as null, so the honest phrasing has to carry the depth we fetched. */
export const rankPhrase = (r: SerpReconResult): string =>
  r.ourOrganicRank != null ? `#${r.ourOrganicRank}` : `absent from the top ${r.serpDepth} organic results (true position unknown, and unmeasured beyond ${r.serpDepth})`;

export function reconVerdict(r: SerpReconResult): { verdict: ReconVerdict; note: string } {
  const strongOrganic = r.ourOrganicRank != null && r.ourOrganicRank <= 5;
  const shape = r.videoPresent ? ' The SERP carries a video pack, so some click loss is format, not content.' : '';
  const pos = rankPhrase(r);
  if (!r.aioPresent) {
    return strongOrganic
      ? { verdict: 'defend-and-deepen', note: `No AI Overview on this SERP; you rank organic ${pos}. Defend and deepen.${shape}` }
      : { verdict: 'competitive-gap', note: `No AI Overview; you rank organic ${pos}. Close the competitive gap.${shape}` };
  }
  // AIO present but unresolved (async, no references pulled): citation is UNKNOWN. Classify on
  // organic strength alone and say so — never bill an unfetched AIO as "does not cite you".
  if (r.aioCitesUs == null) {
    const why = `An AI Overview is present but its citations were not resolved${r.aioAsync ? ' (Google loads it asynchronously)' : ''}, so whether it cites you is UNKNOWN — re-run with the async AI Overview loaded before treating this as an accuracy problem.`;
    return strongOrganic
      ? { verdict: 'defend-and-deepen', note: `You rank organic ${pos}. ${why}${shape}` }
      : { verdict: 'competitive-gap', note: `You rank organic ${pos}. ${why}${shape}` };
  }
  if (strongOrganic && r.aioCitesUs) {
    return { verdict: 'defend-and-deepen', note: `You rank organic ${pos} and the AI Overview already cites you. Deepen to become the primary source.${shape}` };
  }
  if (strongOrganic && !r.aioCitesUs) {
    return { verdict: 'accuracy-or-freshness', note: `You rank organic ${pos} but the AI Overview does NOT cite you (checked ${r.aioReferences.length} references) — a data-accuracy or freshness signal. Make the facts current, correct and marked up so they are liftable.${shape}` };
  }
  if (!strongOrganic && r.aioCitesUs) {
    return { verdict: 'consolidate-weak-page', note: `The AI Overview cites you but your organic rank is weak (${pos}) — you have a quotable nugget on an under-powered page; consolidate and strengthen it.${shape}` };
  }
  return { verdict: 'competitive-gap', note: `Not cited in the AI Overview (checked ${r.aioReferences.length} references) and organic rank is ${pos} — full coverage gap; run the deep competitor diff.${shape}` };
}
