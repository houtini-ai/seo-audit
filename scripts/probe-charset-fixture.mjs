// Fixture test for the crawler's charset decode + whitespace normalisation (the mojibake / double-
// space bug). Exercises decodeHtmlBody across charsets and extractPage's title/meta/h1/word-count.
//   npm run build:server && node scripts/probe-charset-fixture.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { decodeHtmlBody, extractPage, collapseWs } from '../dist/core/extract.js';

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (name, cond, got) => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  got: ${JSON.stringify(got)}`}`); };
const hasMojibake = s => /[â\u0080-\u009f]/.test(s); // 'â' + C1 controls = UTF-8-read-as-Latin-1 tell

// --- decodeHtmlBody: honour the declared charset, decode once, never mojibake ---
// NB: decodeHtmlBody turns BYTES into a string; HTML entities (&ndash;) are decoded later by
// cheerio in extractPage. So assert the RAW multibyte characters in the fixture body, not the
// entity-derived en dash.
const utf8 = Buffer.from(readFileSync(join(here, 'fixtures', 'charset-utf8.html'))); // real UTF-8 bytes
const rawCharsPresent = s => s.includes('é') && s.includes('×') && s.includes('—') && s.includes('°'); // é × — °

ok('utf-8 bytes + Content-Type charset=utf-8 -> raw é × — ° intact',
  rawCharsPresent(decodeHtmlBody(utf8, 'text/html; charset=utf-8')));
ok('utf-8 bytes, no header, <meta charset=utf-8> sniffed -> raw chars intact',
  rawCharsPresent(decodeHtmlBody(utf8, null)));
ok('utf-8 bytes decoded as utf-8 produce NO mojibake',
  !hasMojibake(decodeHtmlBody(utf8, 'text/html; charset=utf-8')));

// Latin-1 branch: 0xE9 is 'é' in ISO-8859-1 but an invalid lone byte in UTF-8. (UTF-8 and the
// ISO-8859-1 label are always available regardless of the Node ICU build; windows-1252's C1 range
// is ICU-dependent, so it isn't asserted here.)
const latin1 = Buffer.from([0x3c, 0x74, 0x69, 0x74, 0x6c, 0x65, 0x3e, 0xe9, 0x3c, 0x2f, 0x74, 0x69, 0x74, 0x6c, 0x65, 0x3e]); // <title>é</title>
ok('iso-8859-1 header -> 0xE9 decodes to e-acute (charset honoured, not forced UTF-8)',
  decodeHtmlBody(latin1, 'text/html; charset=iso-8859-1') === '<title>é</title>',
  decodeHtmlBody(latin1, 'text/html; charset=iso-8859-1'));
ok('that same Latin-1 byte, mis-forced as utf-8, would NOT survive (proves the fix matters)',
  decodeHtmlBody(latin1, 'text/html; charset=utf-8') !== '<title>é</title>');
ok('unknown/invalid charset label -> falls back to utf-8, no throw',
  rawCharsPresent(decodeHtmlBody(utf8, 'text/html; charset=totally-bogus')));

// --- extractPage: whitespace-normalised fields, correct measurements, no mojibake ---
const html = decodeHtmlBody(utf8, 'text/html; charset=utf-8');
const ex = extractPage(html, 'https://www.ehi.com.au/products/x', 'www.ehi.com.au', { hostForm: 'asis' });

const EXPECT_TITLE = 'Easyroll Standard Pallet Truck 2500kg – EHI.com.au';
ok('title whitespace-normalised, single space, real en dash', ex.title === EXPECT_TITLE, ex.title);
ok('title has no embedded newline', !/\n/.test(ex.title ?? ''));
ok('title has no double space', !/  /.test(ex.title ?? ''));
ok('title is free of mojibake', !hasMojibake(ex.title ?? ''));
ok('titleLength matches the normalised string (not inflated)', ex.titleLength === EXPECT_TITLE.length && ex.titleLength === 50, ex.titleLength);

ok('h1 whitespace-normalised', ex.h1 === 'Pallet Truck 2500kg', ex.h1);

ok('meta: &amp;->& , &deg;->deg , &mdash;->em-dash decoded', ex.metaDescription.includes(' & ') && ex.metaDescription.includes('90°') && ex.metaDescription.includes('—'), ex.metaDescription);
ok('meta: &rsquo; -> right single quote', ex.metaDescription.includes('Proval’s'), ex.metaDescription);
ok('meta: &nbsp; collapsed to a normal space', ex.metaDescription.includes('2500 kg') && !/ /.test(ex.metaDescription), ex.metaDescription);
ok('meta is free of mojibake', !hasMojibake(ex.metaDescription));

// word count = h1 ("Pallet Truck 2500kg", 3 words) + the paragraph (16 words) = 19. Mojibake would
// split multi-byte chars and inflate this; assert the real total.
const pWords = collapseWs('Café résumé — a 20° slope on a 5×2 grid, with “smart quotes” and it’s fine.').split(' ').length;
const expectWords = 3 + pWords;
ok('word count correct, not inflated by mojibake', ex.wordCount === expectWords, `${ex.wordCount} (expected ${expectWords})`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
