// Rendering for the two kinds of "do this next" prompt (see src/core/prompts.ts):
//   - clickCta / clickText: point the user at an Actions-panel button by its label.
//   - askChip / askText: hand the user a natural-language prompt for Claude, with one-click Copy.
// The copy and scroll-to-button behaviour is wired once in dashboard.ts (wireAskClaude).

import { ACTION_LABELS, ACTION_PROMPTS, askClaudePrompt, promptTarget, type ActionKey } from '../core/prompts.js';

export { ACTION_LABELS, askClaudePrompt, promptTarget };
export type { ActionKey };

/**
 * Where the page runs decides how a "do this next" for a free action reads:
 *   - 'actions': the browser dashboard with its Actions panel - name the button (it scrolls to it);
 *   - 'ask': no Actions panel but Claude is there (the in-chat widget, a read-only dashboard) - a
 *     prompt for Claude with one-click Copy;
 *   - 'none': an exported report - nothing can be run from it, so only the lead is shown.
 */
export type CtaMode = 'actions' | 'ask' | 'none';
let ctaMode: CtaMode = 'actions';
let ctaTarget = 'this site';
export function setCtaContext(mode: CtaMode, siteUrl?: string): void {
  ctaMode = mode;
  if (siteUrl) ctaTarget = promptTarget(siteUrl) || 'this site';
}
export const getCtaMode = (): CtaMode => ctaMode;

const escHtml = (s: string): string =>
  s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
const escAttr = (s: string): string => escHtml(s).replace(/'/g, '&#39;');

/** HTML: "<lead> Click <Run audit> in Actions." The label scrolls to and pulses the real button. */
export function clickCta(key: ActionKey, lead: string): string {
  const l = lead ? `${escHtml(lead)} ` : '';
  if (ctaMode === 'none') return l.trim();
  if (ctaMode === 'ask') {
    const prompt = ACTION_PROMPTS[key](ctaTarget);
    // Inline (no block chip): this sits inside <p> and <span> empty states.
    return `${l}Ask Claude: <span class="ask-prompt">${escHtml(prompt)}</span> <button type="button" class="ask-copy" data-ask-copy="${escAttr(prompt)}">Copy for Claude</button>`;
  }
  return `${l}Click <button type="button" class="cta-act" data-cta-act="${key}">${escHtml(ACTION_LABELS[key])}</button> in Actions.`;
}

/** Plain text (for canvas chart overlays, which can't hold a button). */
export function clickText(key: ActionKey, lead: string): string {
  if (ctaMode === 'none') return lead;
  if (ctaMode === 'ask') return `${lead ? `${lead} ` : ''}Ask Claude: ${ACTION_PROMPTS[key](ctaTarget)}`;
  return `${lead ? `${lead} ` : ''}Click ${ACTION_LABELS[key]} in Actions.`;
}

const ACTION_VERB: Record<ActionKey, string> = { audit: 'run the audit', crawl: 'crawl the site', sync: 'sync Search Console', inspect: 'run URL inspection', readiness: 'check agent readiness' };
const ACTION_NEED: Record<ActionKey, string> = { audit: 'an audit', crawl: 'a crawl', sync: 'a Search Console sync', inspect: 'URL inspection', readiness: 'an agent-readiness check' };

/** A mid-sentence phrase: "click Run audit in Actions" / "ask Claude to run the audit" / "needs an audit" (export). */
export function actionPhrase(key: ActionKey): string {
  if (ctaMode === 'none') return `needs ${ACTION_NEED[key]}`;
  if (ctaMode === 'ask') return `ask Claude to ${ACTION_VERB[key]}`;
  return `click ${ACTION_LABELS[key]} in Actions`;
}
/** A plain sentence start with a purpose: "Click Crawl in Actions to map equity flow". */
export function actionTo(key: ActionKey, purpose: string): string {
  const p = actionPhrase(key);
  return `${p.charAt(0).toUpperCase()}${p.slice(1)} ${purpose}`;
}

/** HTML chip: a natural-language prompt for Claude with a one-click Copy. */
export function askChip(prompt: string, lead = ''): string {
  return (
    '<div class="ask-claude">'
    + (lead ? `<span class="ask-lead">${escHtml(lead)}</span>` : '')
    + `<span class="ask-prompt">${escHtml(prompt)}</span>`
    + `<button type="button" class="ask-copy" data-ask-copy="${escAttr(prompt)}">Copy for Claude</button>`
    + '</div>'
  );
}

/** Plain text (for canvas chart overlays): the prompt sentence, no tool name. */
export function askText(prompt: string, lead = ''): string {
  return lead ? `${lead} ${prompt}` : prompt;
}

/** Just the Copy button (no surrounding chip) - for placing a prompt inline, e.g. per table row. */
export function askButton(prompt: string, label = 'Copy for Claude'): string {
  return `<button type="button" class="ask-copy" data-ask-copy="${escAttr(prompt)}">${escHtml(label)}</button>`;
}
