// One source of truth for how the dashboard asks the user to perform an action.
//
// Every "you need more data" dead-end in the dashboard is one of two things:
//   A) an action that has a button in the Actions panel (audit, crawl, GSC sync, URL
//      inspection, agent readiness) — tell the user which button to click, by its label;
//   B) an action that only Claude can do (paid DataForSEO, judgement, portfolio flows) —
//      hand the user a ready-to-paste, natural-language prompt, never an internal tool name.
//
// The UI renders these (src/ui/askClaude.ts); the strings live here so the wording never drifts
// and the server payload (dashboardData.ts) can reference the same labels.

/** The Actions-panel buttons, by their internal key, with the label the user actually sees. */
export const ACTION_LABELS = {
  audit: 'Run audit',
  crawl: 'Crawl',
  sync: 'Sync GSC',
  inspect: 'Inspect',
  agent: 'Agent',
} as const;

export type ActionKey = keyof typeof ACTION_LABELS;

/** The nicest way to name a property inside a prompt: the bare host, no scheme/prefix/www. */
export function promptTarget(siteUrl: string): string {
  return siteUrl
    .replace(/^sc-domain:/i, '')
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/+$/, '');
}

/**
 * Natural-language prompts to paste into Claude for work the dashboard can't do itself.
 * No tool names: each reads like a request a person would type. `p` is a property reference
 * (pass promptTarget(siteUrl) for the bare host, which reads best).
 */
export const askClaudePrompt = {
  backlinks: (p: string) => `Pull the backlink profile for ${p} and flag any links pointing at dead pages.`,
  linkIntersect: (p: string) => `Find link prospects for ${p}: domains that link to my competitors but not to me.`,
  market: (p: string) => `Size the market for ${p}: total search demand and the share I hold.`,
  competitors: (p: string) => `Show what my competitors rank for that ${p} doesn't, and the nearest page to cover each gap.`,
  ranks: (p: string) => `Track rankings for ${p} and show the rank distribution over time.`,
  recon: (p: string) => `Find the best content opportunities for ${p} and the existing pages to improve.`,
  articleBrief: (topic: string, p: string) => `Research what a great article on "${topic}" should cover for ${p}: study the pages currently ranking for it and give me an outline - the subtopics, questions and entities to include, and how to beat them.`,
  crux: (p: string) => `Pull field Core Web Vitals (CrUX) for ${p}.`,
  relatedTerms: (kw: string) => `Pull related search terms and monthly search volumes for "${kw}".`,
  contentResearch: (kw: string) => `Research "${kw}" for me: the top-ranking videos, the recent news, and the Google Trends interest.`,
  segments: (p: string) => `Add device and country breakdowns to ${p}'s Search Console data.`,
  fix: (p: string) => `Give me a ready-to-apply fix for the top finding on ${p}.`,
  portfolioRefresh: () => `Refresh my portfolio — quote the cost first, then go ahead.`,
  portfolioSchedule: () => `Set up a monthly portfolio refresh on a schedule.`,
} as const;
