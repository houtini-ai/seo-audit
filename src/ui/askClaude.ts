// Rendering for the two kinds of "do this next" prompt (see src/core/prompts.ts):
//   - clickCta / clickText: point the user at an Actions-panel button by its label.
//   - askChip / askText: hand the user a natural-language prompt for Claude, with one-click Copy.
// The copy and scroll-to-button behaviour is wired once in dashboard.ts (wireAskClaude).

import { ACTION_LABELS, askClaudePrompt, promptTarget, type ActionKey } from '../core/prompts.js';

export { ACTION_LABELS, askClaudePrompt, promptTarget };
export type { ActionKey };

const escHtml = (s: string): string =>
  s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
const escAttr = (s: string): string => escHtml(s).replace(/'/g, '&#39;');

/** HTML: "<lead> Click <Run audit> in Actions." The label scrolls to and pulses the real button. */
export function clickCta(key: ActionKey, lead: string): string {
  const l = lead ? `${escHtml(lead)} ` : '';
  return `${l}Click <button type="button" class="cta-act" data-cta-act="${key}">${escHtml(ACTION_LABELS[key])}</button> in Actions.`;
}

/** Plain text (for canvas chart overlays, which can't hold a button). */
export function clickText(key: ActionKey, lead: string): string {
  return `${lead ? `${lead} ` : ''}Click ${ACTION_LABELS[key]} in Actions.`;
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
