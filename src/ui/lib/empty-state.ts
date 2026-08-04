// EmptyState — the consistent "no data yet" message, with the command that fixes it.
import { esc } from './h.js';
import { icons } from './icons.js';

export const emptyState = (message: string, command?: string): string =>
  `<div class="empty-state">${icons.info}<span>${esc(message)}${command ? ` <code>${esc(command)}</code>` : ''}</span></div>`;
