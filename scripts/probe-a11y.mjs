// Fixture test for the static accessibility signals extractPage computes (axe-core subset).
//   npm run build:server && node scripts/probe-a11y.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractPage } from '../dist/core/extract.js';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, 'fixtures', 'a11y.html'), 'utf8');
const ex = extractPage(html, 'https://example.com/a', 'example.com', { hostForm: 'asis' });

let pass = 0, fail = 0;
const ok = (name, got, want) => { const c = got === want; c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${name}${c ? '' : `  got ${got}, want ${want}`}`); };

ok('links with no accessible name (icon-only only)', ex.a11yLinksNoName, 1);
ok('buttons with no accessible name (icon-only; submit self-names)', ex.a11yButtonsNoName, 1);
ok('form fields with no label (for=/wrapping excluded)', ex.a11yInputsNoLabel, 1);
ok('viewport pinch-zoom disabled (user-scalable=no)', ex.a11yViewportZoomDisabled, true);
ok('positive tabindex count (tabindex=0 not counted)', ex.a11yPositiveTabindex, 1);
ok('duplicate id groups', ex.a11yDuplicateIds, 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
