// AI prompt panel (#79, other AI platforms). No network: the five engine responses are live captures
// (27 Nov 2026, scripts/fixtures/portfolio/ai_panel_*.json) served through the DataForSEO client's
// fetchImpl hook, and every database is in a temp dir.
// Run: npm run build:server && node scripts/probe-ai-panel.mjs
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync as rmRaw, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DataForSeoClient } from '../dist/core/DataForSeoClient.js';
import { AuditDatabase } from '../dist/core/AuditDatabase.js';
import { dbPathFor } from '../dist/core/paths.js';
import { PortfolioStore } from '../dist/core/PortfolioStore.js';
import { DFS_PRICES } from '../dist/core/portfolioPlan.js';
import { citationSource, isGroundingRedirect } from '../dist/core/serpHost.js';
import {
  parseLlmAnswer, parseAiModeAnswer, cleanAnswerText, mentionOf, matchDomain, domainNameLabel, spacedRuns,
  addPrompts, removePrompts, listPrompts, quotePanelRun, runPanel, readPanel, summarizePanel, engineStatus, cellState,
  localisationFor, MAX_AI_PROMPTS, AI_ENGINES, writeAnswer,
} from '../dist/core/aiPromptPanel.js';
import { getDomainOverview } from '../dist/core/portfolioData.js';
import { JOB_KINDS } from '../dist/core/jobKinds.js';

let pass = 0, fail = 0;
const clients = [];
const rmSync = (d) => { for (const c of clients.splice(0)) { try { c.cache.close(); } catch { /* closed */ } } try { rmRaw(d, { recursive: true, force: true }); } catch { /* temp dir */ } };
const check = (name, cond, detail) => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name} :: ${detail}`); } };

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'portfolio');
const load = (name) => JSON.parse(readFileSync(path.join(FIX, `${name}.json`), 'utf8'));
const FX = { chatgpt: load('ai_panel_chat_gpt'), claude: load('ai_panel_claude'), gemini: load('ai_panel_gemini'), perplexity: load('ai_panel_perplexity'), ai_mode: load('ai_panel_ai_mode') };
const ANSWER = {
  chatgpt: parseLlmAnswer(FX.chatgpt), claude: parseLlmAnswer(FX.claude), gemini: parseLlmAnswer(FX.gemini),
  perplexity: parseLlmAnswer(FX.perplexity), ai_mode: parseAiModeAnswer(FX.ai_mode),
};
const FIXTURE_TOTAL = Math.round(Object.values(FX).reduce((s, f) => s + f.cost, 0) * 1e6) / 1e6;

/** fetchImpl serving the fixtures by endpoint; `state.fail` maps an engine path segment to a DataForSEO error. */
function makeFetch(state) {
  return async (url, init) => {
    const p = new URL(url).pathname;
    state.log.push({ p, body: JSON.parse(init.body)[0] });
    const seg = /ai_optimization\/(\w+)\/llm_responses/.exec(p)?.[1] ?? (p.includes('/ai_mode/') ? 'ai_mode' : null);
    if (state.fail?.[seg]) return { ok: true, status: 200, json: async () => ({ status_code: 20000, cost: 0, tasks: [{ status_code: state.fail[seg].code, status_message: state.fail[seg].message, result: null }] }) };
    const fx = { chat_gpt: FX.chatgpt, claude: FX.claude, gemini: FX.gemini, perplexity: FX.perplexity, ai_mode: FX.ai_mode }[seg];
    if (!fx) throw new Error(`no fixture for ${p}`);
    return { ok: true, status: 200, json: async () => ({ status_code: 20000, cost: fx.cost, tasks: fx.tasks }) };
  };
}
const client = (dir, state, cacheName = 'dataforseo-cache.db') => {
  const c = new DataForSeoClient('u', 'p', path.join(dir, cacheName), 20, { fetchImpl: makeFetch(state) });
  clients.push(c);
  return c;
};
function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'sac-ai-panel-'));
  const site = 'sc-domain:simracingcockpit.gg';
  const db = new AuditDatabase(dbPathFor(dir, site));
  db.upsertProperty(site, 'asis');
  db.setDfsLocation(site, 2840);
  db.db.prepare(`UPDATE property_meta SET last_synced_at = datetime('now') WHERE site_url = ?`).run(site);
  db.close();
  return { dir, site };
}
const NOV = new Date('2026-11-27T08:00:00Z');
const DEC = new Date('2026-12-03T08:00:00Z');
const PROMPT = 'What are the best sim racing cockpits to buy in 2026?';
const segOf = (p) => (p.includes('/ai_mode/') ? 'ai_mode' : /ai_optimization\/(\w+)\//.exec(p)?.[1]);

// ── 1. Citation hosts: redirects are never the source ────────────────────────────────────────────
{
  const g = FX.gemini.tasks[0].result[0].items[0].sections[0].annotations[0];
  check('fixture: Gemini annotation url is a grounding redirect', isGroundingRedirect(g.url), g.url);
  const gs = citationSource(g);
  check('Gemini source read from direct_url', gs.host === 'mysimrig.nl' && gs.via === 'direct_url' && !isGroundingRedirect(gs.url), JSON.stringify(gs));
  const gt = citationSource({ url: g.url, title: 'setupking.de' });
  check('Gemini without direct_url: the title domain, URL left null (never the redirect)', gt.host === 'setupking.de' && gt.via === 'title' && gt.url === null, JSON.stringify(gt));
  check('a redirect with a non-domain title stays unattributed', citationSource({ url: g.url, title: 'Some article title' }).host === null, '');
  const c = citationSource(FX.chatgpt.tasks[0].result[0].items.find(i => i.type === 'message').sections[0].annotations[0]);
  check('ChatGPT utm_source=openai removed from the stored URL', c.host === 'simracingsetup.com' && !/utm_source/.test(c.url), JSON.stringify(c));
  const goto = citationSource({ url: 'https://google.com/goto?url=x', domain: 'google.com', title: 'x' });
  check('a google.com/goto wrapper is never attributed to google.com', goto.host === null, JSON.stringify(goto));
  const gotoBc = citationSource({ url: 'https://www.google.com/url?q=x', domain: 'www.trakracer.com' });
  check('a goto wrapper with a real domain field uses the domain', gotoBc.host === 'trakracer.com' && gotoBc.via === 'domain' && gotoBc.url === null, JSON.stringify(gotoBc));
}

// ── 2. Parsing the five live answers ─────────────────────────────────────────────────────────────
{
  const a = ANSWER;
  check('ChatGPT: resolved model + UTC datetime + 6 distinct citations, reasoning items skipped', a.chatgpt.model === 'gpt-5.4-mini-2026-03-17' && a.chatgpt.answeredAt === '2026-11-27 07:50:22' && a.chatgpt.citations.length === 6 && !/Searching for cockpit/.test(a.chatgpt.text), `${a.chatgpt.model} ${a.chatgpt.answeredAt} ${a.chatgpt.citations.length}`);
  check('ChatGPT: citation chips and URLs are not in the prose', !/\(\[|\]\(|https?:\/\/|utm_source/.test(a.chatgpt.text), a.chatgpt.text.slice(0, 200));
  check('Claude: 19 sections joined into one answer, 4 distinct sources', a.claude.model === 'claude-haiku-5-5' && /Sim-Lab P1X Pro/.test(a.claude.text) && a.claude.citations.length === 4, `${a.claude.citations.length}`);
  check('Gemini: 37 annotations deduped to 9 sources, none unattributed', a.gemini.citations.length === 9 && a.gemini.unattributed === 0 && a.gemini.citations.every(c => c.host), JSON.stringify(a.gemini.citations.map(c => c.host)));
  check('Perplexity: 10 sources', a.perplexity.model === 'sonar' && a.perplexity.citations.length === 10, String(a.perplexity.citations.length));
  check('AI Mode: answer from the ai_overview markdown; [[1]] chips and shopping links are not citations', a.ai_mode.model === 'google-ai-mode' && a.ai_mode.citations.length === 1 && a.ai_mode.citations[0].host === 'simracingsetup.com' && !/\[\[1\]\]|google\.com\/search/.test(a.ai_mode.text), JSON.stringify(a.ai_mode.citations));
  check('AI Mode: element-level references are unioned with the top-level ones', parseAiModeAnswer({ tasks: [{ result: [{ items: [{ type: 'ai_overview', markdown: 'x', references: [{ domain: 'a.com', url: 'https://a.com/1' }], items: [{ references: [{ domain: 'b.com', url: 'https://b.com/2' }, { domain: 'a.com', url: 'https://a.com/1' }] }] }] }] }] }).citations.map(c => c.host).join() === 'a.com,b.com', '');
  check('AI Mode with no ai_overview item = no answer', parseAiModeAnswer({ tasks: [{ result: [{ items: [{ type: 'organic' }] }] }] }).status === 'no-answer', '');
  const md = 'See [Trak Racer](https://x.y/z) and ![Sim-Lab P1X](https://img) ([a.com](https://a.com))';
  check('cleanAnswerText keeps link and image labels, drops citation chips', cleanAnswerText(md) === 'See Trak Racer and Sim-Lab P1X', cleanAnswerText(md));
}

// ── 3. The mention and citation rules ────────────────────────────────────────────────────────────
{
  check('x.com is never matched inside pimax.com', mentionOf('Try pimax.com for headsets', 'x.com') === null && mentionOf('Posted on x.com today', 'x.com') === 'domain', '');
  check('a subdomain mention counts as the domain', mentionOf('Visit shop.example.co.uk now', 'example.co.uk') === 'domain', '');
  check('a domain inside a longer host does not count', mentionOf('see notexample.com', 'example.com') === null && mentionOf('see example.com.evil.net', 'example.com') !== 'domain', '');
  check('name label skips the public suffix', domainNameLabel('example.com.au') === 'example' && domainNameLabel('shop.example.co.uk') === 'example' && domainNameLabel('simracingcockpit.gg') === 'simracingcockpit', '');
  check('one-word name in any case', mentionOf('the PIMAX Crystal', 'pimax.com') === 'name' && mentionOf('SimRacingCockpit says', 'simracingcockpit.gg') === 'name', '');
  check('a name inside a longer word is not a mention ("vehicle" vs hic)', mentionOf('every vehicle', 'hic.com.au') === null, '');
  check('hyphenated label as written', mentionOf('the Sim-Lab GT1', 'sim-lab.eu') === 'name', '');
  check('separate words capitalised as a name count', mentionOf('the Next Level Racing GTTrack', 'nextlevelracing.com') === 'name', '');
  check('a lower-case spaced spelling is phrase only', mentionOf('the best sim racing cockpit for you', 'simracingcockpit.gg') === 'phrase', '');
  check('a spaced spelling broken by a full stop is not a run', spacedRuns('next level. racing', 'nextlevelracing').length === 0, '');
  const m = (e, d) => matchDomain(ANSWER[e], d);
  check('live: Gemini cites simracingcockpit.gg but only says the phrase', m('gemini', 'simracingcockpit.gg').cited && m('gemini', 'simracingcockpit.gg').mention === 'phrase', JSON.stringify(m('gemini', 'simracingcockpit.gg')));
  check('live: ChatGPT cites pitwallgear.com only in a citation chip, so NOT mentioned', m('chatgpt', 'pitwallgear.com').cited && m('chatgpt', 'pitwallgear.com').mention === null, JSON.stringify(m('chatgpt', 'pitwallgear.com')));
  check('live: ChatGPT names Next Level Racing and Sim-Lab without citing them', m('chatgpt', 'nextlevelracing.com').mention === 'name' && !m('chatgpt', 'nextlevelracing.com').cited && m('chatgpt', 'sim-lab.eu').mention === 'name', '');
  check('live: AI Mode cites simracingsetup.com (exact host)', m('ai_mode', 'simracingsetup.com').cited && m('ai_mode', 'simracingsetup.com').citedUrls[0].startsWith('https://simracingsetup.com/'), JSON.stringify(m('ai_mode', 'simracingsetup.com')));
  check('live: citation host is never a substring match (setup.com vs simracingsetup.com)', !m('ai_mode', 'setup.com').cited, '');
}

// ── 4. Prices and localisation ───────────────────────────────────────────────────────────────────
{
  const near = (a, b) => Math.abs(a - b) < 0.0001;
  check('engine prices are the observed fixture costs', near(FX.chatgpt.cost, DFS_PRICES.aiPanelChatgpt) && near(FX.claude.cost, DFS_PRICES.aiPanelClaude) && near(FX.gemini.cost, DFS_PRICES.aiPanelGemini) && near(FX.perplexity.cost, DFS_PRICES.aiPanelPerplexity) && FX.ai_mode.cost === DFS_PRICES.aiPanelAiMode, '');
  check('localisation: ChatGPT country, Gemini none, AI Mode location', localisationFor('chatgpt', 2826).params.web_search_country_iso_code === 'GB' && localisationFor('gemini', 2826).label === 'not localised' && /Google location/.test(localisationFor('ai_mode', 2826).label), '');
  check('Claude: a country it does not accept is left out, not sent', localisationFor('claude', 2372).label === 'not localised' && localisationFor('claude', 2036).params.web_search_country_iso_code === 'AU', '');
}

// ── 5. The prompt list ───────────────────────────────────────────────────────────────────────────
{
  const { dir } = setup();
  const st = new PortfolioStore(dir);
  const r1 = addPrompts(st, [' What is  the best cockpit? ', 'what is the best cockpit?', '', 'x'.repeat(501)], 2840);
  check('whitespace normalised, case-insensitive duplicates collapse, empty and over-long named', r1.added.join() === 'What is the best cockpit?' && r1.invalid.length === 2, JSON.stringify(r1));
  check('the same prompt again reads as already in the panel', addPrompts(st, ['WHAT IS THE BEST COCKPIT?'], 2840).alreadyInPanel.length === 1, '');
  const many = Array.from({ length: MAX_AI_PROMPTS + 3 }, (_, i) => `prompt ${i}`);
  const r2 = addPrompts(st, many, 2840);
  check(`capped at ${MAX_AI_PROMPTS}; the overflow is named`, r2.total === MAX_AI_PROMPTS && r2.overCap.length === 4 && r2.added.length === MAX_AI_PROMPTS - 1, JSON.stringify({ t: r2.total, o: r2.overCap.length }));
  const rm = removePrompts(st, ['prompt 0', 'never added'], 2840);
  check('remove reports what was not in the panel', rm.removed.join() === 'prompt 0' && rm.notInPanel.join() === 'never added', JSON.stringify(rm));
  check('list reads the panel', listPrompts(st.db).length === MAX_AI_PROMPTS - 1, '');
  st.close();
  rmSync(dir);
}

// ── 6. Quote, run, the month rule, history, overview ─────────────────────────────────────────────
{
  const { dir } = setup();
  const st = new PortfolioStore(dir);
  st.syncOwned();
  st.addWatched('simracingsetup.com', { locationCode: 2840, group: 'competitors' });
  st.addWatched('nextlevelracing.com', { locationCode: 2826 }); // another country: still read (mentions are not per location)
  addPrompts(st, [PROMPT, 'Which sim racing wheel should I buy?'], 2840);
  const q = quotePanelRun(st, {}, NOV);
  const sum = Object.values(AI_ENGINES).reduce((s, e) => s + e.usd, 0);
  check('quote = prompts x engines at the observed prices, broken down by engine', q.calls === 10 && q.byEngine.length === 5 && Math.abs(q.usd - 2 * sum) < 0.0002 && q.month === '2026-11', JSON.stringify({ calls: q.calls, usd: q.usd }));
  check('the quote names every portfolio domain an answer is read for', q.domains.join() === 'nextlevelracing.com,simracingcockpit.gg,simracingsetup.com', q.domains.join());
  const q1 = quotePanelRun(st, { prompts: [PROMPT.toUpperCase(), 'not in panel'], engines: ['gemini', 'ai_mode'] }, NOV);
  check('selection: prompts matched case-insensitively, engine subset, unknown prompt named', q1.calls === 2 && q1.notInPanel.join() === 'not in panel' && q1.byEngine.map(e => e.engine).join() === 'gemini,ai_mode', JSON.stringify(q1));
  st.close();

  const state = { log: [] };
  const r = await runPanel(dir, client(dir, state), { prompts: [PROMPT] }, () => {}, new AbortController().signal, NOV);
  const by = Object.fromEntries(state.log.map(l => [segOf(l.p), l.body]));
  check('five calls, one per engine', state.log.length === 5 && r.answered === 5, JSON.stringify(r));
  check('LLM bodies: the chosen model, web_search on, the prompt as user_prompt', by.chat_gpt.model_name === 'gpt-5.4-mini' && by.claude.model_name === 'claude-haiku-5-5' && by.gemini.model_name === 'gemini-3.6-flash' && by.perplexity.model_name === 'sonar' && [by.chat_gpt, by.claude, by.gemini, by.perplexity].every(b => b.web_search === true && b.user_prompt === PROMPT), JSON.stringify(by));
  check('location: US for ChatGPT/Claude/Perplexity, none for Gemini, location_code for AI Mode', by.chat_gpt.web_search_country_iso_code === 'US' && by.claude.web_search_country_iso_code === 'US' && by.perplexity.web_search_country_iso_code === 'US' && !('web_search_country_iso_code' in by.gemini) && by.ai_mode.location_code === 2840 && by.ai_mode.keyword === PROMPT, JSON.stringify(by.ai_mode));
  check('spend = the sum of the response costs', Math.abs(r.spent - FIXTURE_TOTAL) < 0.0001 && r.month === '2026-11', `${r.spent} vs ${FIXTURE_TOTAL}`);
  const rs = new PortfolioStore(dir);
  const run = rs.db.prepare(`SELECT tier, status, spent_usd FROM portfolio_run`).get();
  check('the run is a ledger row (tier ai-panel) counted in spentThisMonth', run.tier === 'ai-panel' && run.status === 'completed' && Math.abs(rs.spentThisMonth(NOV) - FIXTURE_TOTAL) < 0.0001, JSON.stringify(run));
  const q2 = quotePanelRun(rs, { prompts: [PROMPT] }, NOV);
  check('same month: pairs already answered are left out and named', q2.calls === 0 && q2.alreadyThisMonth.length === 5, JSON.stringify(q2.alreadyThisMonth.length));
  check('rerun:true quotes them again', quotePanelRun(rs, { prompts: [PROMPT], rerun: true }, NOV).calls === 5, '');
  check('next month they are due again', quotePanelRun(rs, { prompts: [PROMPT] }, DEC).calls === 5, '');
  const rows = readPanel(rs.db);
  const s = Object.fromEntries(summarizePanel(rows, 'simracingcockpit.gg', engineStatus(rs)).map(e => [e.engine, e]));
  check('owned domain: cited by Gemini (1 of 1), mentioned nowhere, phrase only counted apart', s.gemini.cited === 1 && s.gemini.promptsRun === 1 && s.gemini.mentioned === 0 && s.gemini.phraseOnly === 1 && s.chatgpt.cited === 0, JSON.stringify(s.gemini));
  check('the unrun prompt shows as not run, not as absent', s.chatgpt.promptsRun === 1 && cellState(rows.find(x => x.prompt !== PROMPT).cells[0].latest, 'simracingcockpit.gg').state === 'not-run', '');
  const w = Object.fromEntries(summarizePanel(rows, 'nextlevelracing.com').map(e => [e.engine, e]));
  check('a domain watched in another country is still read: Next Level Racing named by all 5', Object.values(w).every(e => e.mentioned === 1 && e.cited === 0), JSON.stringify(Object.values(w).map(e => e.mentioned)));
  check('model stored as resolved by DataForSEO', s.chatgpt.model === 'gpt-5.4-mini-2026-03-17', s.chatgpt.model);
  rs.close();

  // A domain added AFTER the run is matched against the stored answer text.
  const st2 = new PortfolioStore(dir);
  st2.addWatched('playseat.com', { locationCode: 2840 });
  const late = Object.fromEntries(summarizePanel(readPanel(st2.db), 'playseat.com').map(e => [e.engine, e]));
  check('a domain added later is matched against past answers', late.chatgpt.mentioned === 1 && late.claude.mentioned === 1, JSON.stringify(late.chatgpt));
  st2.close();

  const ov = getDomainOverview(dir, 'simracingcockpit.gg', 2840);
  const gem = ov.aiPanel.engines.find(e => e.engine === 'gemini');
  check('overview carries the panel for the domain', ov.aiPanel.prompts === 2 && gem.cited === 1 && ov.aiPanel.rows.find(x => x.prompt === PROMPT).cells.find(c => c.engine === 'gemini').state === 'cited', JSON.stringify(gem));
  check('the "not measured" note is gone for the measured platforms', !ov.notes.some(n => /not measured/.test(n)) && ov.notes.some(n => /AI prompt panel \(.*Gemini: mentioned in 0 of 1 prompts, cited in 1, 2026-11/.test(n)), ov.notes.join(' | '));
  rmSync(dir);
}

// ── 7. The note stays when nothing is measured; a partial panel keeps it for the rest ────────────
{
  const { dir } = setup();
  const ov = getDomainOverview(dir, 'simracingcockpit.gg', 2840);
  check('no panel: the original wording stays', ov.notes.some(n => /^AI Mode, Gemini and Perplexity are not measured by this data source/.test(n)) && ov.aiPanel.prompts === 0, ov.notes.join(' | '));
  const st = new PortfolioStore(dir);
  addPrompts(st, [PROMPT], 2840);
  st.close();
  await runPanel(dir, client(dir, { log: [] }), { engines: ['gemini'] }, () => {}, new AbortController().signal, NOV);
  const ov2 = getDomainOverview(dir, 'simracingcockpit.gg', 2840);
  check('Gemini measured: the note names only AI Mode and Perplexity', ov2.notes.some(n => /^AI Mode and Perplexity are not measured/.test(n)), ov2.notes.join(' | '));
  rmSync(dir);
}

// ── 8. A failing engine fails alone; budget; wiring ──────────────────────────────────────────────
{
  const { dir } = setup();
  const st = new PortfolioStore(dir);
  st.syncOwned();
  addPrompts(st, [PROMPT, 'second prompt'], 2840);
  st.close();
  const state = { log: [], fail: { gemini: { code: 40204, message: 'Access denied. Visit Plans and Subscriptions to activate your subscription.' } } };
  const r = await runPanel(dir, client(dir, state), { engines: ['gemini', 'perplexity'] }, () => {}, new AbortController().signal, NOV);
  check('not-enabled engine: one call, the rest of it not tried; the other engine answers', state.log.filter(l => l.p.includes('/gemini/')).length === 1 && r.failed.length === 2 && /not tried/.test(r.failed[1].error) && r.answered === 2, JSON.stringify(r.failed));
  const rs = new PortfolioStore(dir);
  const es = engineStatus(rs);
  check('the engine failure is recorded with its reason', es.gemini?.status === 'not-enabled' && /40204/.test(es.gemini.error) && es.perplexity?.status === 'ok', JSON.stringify(es));
  check('the run is partial, not completed', rs.db.prepare(`SELECT status FROM portfolio_run`).get().status === 'partial', '');
  rs.close();
  const state2 = { log: [] };
  const r2 = await runPanel(dir, client(dir, state2, 'c2.db'), { engines: ['chatgpt'], budgetUsd: 0.01 }, () => {}, new AbortController().signal, NOV);
  check('over the monthly cap: no call, the pairs are named as skipped', state2.log.length === 0 && r2.skippedBudget.length === 2, JSON.stringify(r2));
  rmSync(dir);
}
check('the ai_panel job kind is registered', typeof JOB_KINDS.ai_panel === 'function', '');

// ── Code-review regressions (1.0.8) ─────────────────────────────────────────────────────────────
check('name match: a label inside another hostname is not a mention', mentionOf('example.com.au is other', 'example.com') === null && mentionOf('foo-example.com rocks', 'example.com') === null && mentionOf('I like Example.', 'example.com') === 'name', '');
{
  const dir = mkdtempSync(path.join(tmpdir(), 'sac-aip-reg-'));
  const st = new PortfolioStore(dir);
  const base = { ...ANSWER.chatgpt, answeredAt: '2026-11-30 20:00:00' };
  const key = { prompt: 'p', locationCode: 2840, engine: 'chatgpt', runMonth: '2026-11', runId: 1, localised: 'US' };
  writeAnswer(st.db, key, base, { cost: 0.0066, cached: false });
  writeAnswer(st.db, { ...key, runMonth: '2026-12', runId: 2 }, base, { cost: 0, cached: true });
  const row = st.db.prepare(`SELECT run_month m, cost c, cached k FROM ai_prompt_answer WHERE prompt = 'p'`).all();
  check('a cache hit never overwrites the paid answer (its month and cost survive)', row.length === 1 && row[0].m === '2026-11' && row[0].c === 0.0066 && row[0].k === 0, JSON.stringify(row));
  const unk = { ...ANSWER.chatgpt, citations: [], unattributed: 1, text: 'nothing relevant here' };
  const s = summarizePanel([{ prompt: 'p', locationCode: 2840, cells: Object.keys(AI_ENGINES).map(engine => ({ engine, latest: engine === 'chatgpt' ? { ...unk, runMonth: '2026-11', answeredAt: 'x', localised: null } : null, previous: null })) }], 'simracingcockpit.gg')
    .find(e => e.engine === 'chatgpt');
  check('an unreadable citation counts as citation unknown, not "not cited"', s.cited === 0 && s.citeUnknown === 1, JSON.stringify(s));
  st.close(); rmSync(dir);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
