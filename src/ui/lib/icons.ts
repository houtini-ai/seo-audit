// The dashboard's entire icon vocabulary: ~8 inline Lucide-style glyphs
// (stroke-based, currentColor). No icon font, no sprite sheet.

const svg = (body: string, size = 14): string =>
  `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icons = {
  download: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'),
  chevron: svg('<polyline points="9 18 15 12 9 6"/>'),
  triangleUp: svg('<path d="M12 5 L20 19 L4 19 Z" fill="currentColor" stroke="none"/>', 10),
  triangleDown: svg('<path d="M12 19 L4 5 L20 5 Z" fill="currentColor" stroke="none"/>', 10),
  check: svg('<polyline points="20 6 9 17 4 12"/>'),
  alert: svg('<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
  x: svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
  info: svg('<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>'),
} as const;

export type IconName = keyof typeof icons;
