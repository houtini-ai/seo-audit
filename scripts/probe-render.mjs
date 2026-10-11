// Fixture test for the Response-vs-Render diff logic (the testable core of the render tier — no
// browser needed). Builds a raw extract and a rendered extract from two HTML strings and asserts the
// diff finds the links/content that exist only after JS.
//   npm run build:server && node scripts/probe-render.mjs
import { extractPage } from '../dist/core/extract.js';
import { diffRawVsRendered, dependsOnJsFlag } from '../dist/core/renderAudit.js';
import { rendererAvailable } from '../dist/core/render.js';

const url = 'https://example.com/';
const base = 'example.com';
const opts = { hostForm: 'asis' };

// Raw: an empty SPA shell. Rendered: nav links + a body injected by JS.
const raw = extractPage('<html><head><title>App</title></head><body><div id="root"></div></body></html>', url, base, opts);
const rendered = extractPage(
  `<html><head><title>App</title></head><body><div id="root"><nav><a href="/a">A</a><a href="/b">B</a></nav><main><h1>Widgets</h1><p>${'word '.repeat(120)}</p></main></div></body></html>`,
  url, base, opts);

let pass = 0, fail = 0;
const ok = (name, cond, got) => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  got: ${got}`}`); };

const d = diffRawVsRendered(raw, rendered);
ok('2 internal links exist only after render', d.linksOnlyRendered === 2, d.linksOnlyRendered);
ok('rendered body word count >> raw', d.wordCountDelta >= 100, d.wordCountDelta);
ok('sampleNewLinks lists the rendered-only targets', d.sampleNewLinks.length === 2, d.sampleNewLinks.length);
ok('page is flagged JS-dependent', dependsOnJsFlag(d) === true, dependsOnJsFlag(d));

// Identical raw vs rendered -> no gap, not flagged.
const same = diffRawVsRendered(rendered, rendered);
ok('identical extracts -> 0 rendered-only links', same.linksOnlyRendered === 0, same.linksOnlyRendered);
ok('identical extracts -> not JS-dependent', dependsOnJsFlag(same) === false, dependsOnJsFlag(same));

// Title that only appears after render is flagged even with no new links.
const rawNoTitle = extractPage('<html><head></head><body></body></html>', url, base, opts);
const renTitle = extractPage(`<html><head><title>Hello</title></head><body><p>${'w '.repeat(120)}</p></body></html>`, url, base, opts);
ok('title appearing only on render is flagged', dependsOnJsFlag(diffRawVsRendered(rawNoTitle, renTitle)) === true);

ok('rendererAvailable() returns a boolean (graceful-degradation gate)', typeof (await rendererAvailable()) === 'boolean');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
