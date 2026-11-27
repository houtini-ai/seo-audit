import type Database from 'better-sqlite3';
import type { DataForSeoClient, DfsResponse } from './DataForSeoClient.js';
import { PortfolioStore, LOCATION_ISO, LOCATION_LABEL } from './PortfolioStore.js';
import { DFS_PRICES } from './portfolioPlan.js';
import { classifyDfsError } from './PortfolioRefresh.js';
import { citationSource, hostMatchesDomain } from './serpHost.js';
import { serpDatetime } from './keywordTracking.js';

/**
 * The AI prompt panel (#79, "other AI platforms"). The portfolio's mentions data (DataForSEO LLM
 * Mentions) covers Google AI Overviews and ChatGPT only. For the rest, the user writes a short list
 * of prompts and a run asks each one of five engines, once, and stores the answer:
 *
 *   ChatGPT, Claude, Gemini, Perplexity  DataForSEO AI Optimization, LLM Responses (live), web search on
 *   Google AI Mode                       DataForSEO SERP API, google/ai_mode/live/advanced
 *
 * Each answer is then read for every portfolio domain: is it MENTIONED in the answer text, and is it
 * CITED as a source. Paid and on demand only: quoted first, never scheduled, never bulk. A run belongs
 * to a calendar month (UTC); a prompt x engine already answered this month is not asked again unless
 * the user says so (rerun).
 *
 * Honesty rules:
 *  - One answer is one sample of a non-deterministic model: it says what the engine said that day,
 *    not what every user sees. Results are counts out of the prompts run, never a score.
 *  - The API models are not the consumer apps: the model name is stored and shown with every answer.
 *  - "mentioned" has a stated rule (mentionOf); a spaced spelling of the name (which may just be a
 *    generic phrase) is reported separately and never counted as a mention.
 *  - A citation whose host can't be read is counted as unattributed, never guessed.
 *  - The answer text is stored (capped), and matching happens when it is READ, so a domain added to
 *    the portfolio later is matched against past answers too.
 */

export type AiEngine = 'chatgpt' | 'claude' | 'gemini' | 'perplexity' | 'ai_mode';
export const AI_ENGINE_IDS: AiEngine[] = ['chatgpt', 'claude', 'gemini', 'perplexity', 'ai_mode'];

export interface EngineSpec {
  label: string;
  /** DataForSEO platform path segment (LLM Responses) or null for AI Mode (SERP API). */
  platform: 'chat_gpt' | 'claude' | 'gemini' | 'perplexity' | null;
  /** The model asked (a base name: DataForSEO resolves it to the latest version, which is stored). */
  model: string | null;
  /** How the prompt's location is applied. */
  localisation: 'country' | 'location' | 'none';
  usd: number;
}

/** Models chosen 27 Nov 2026 from each Models endpoint: the cheaper current model of each family that
 * supports web search (citations need it). AI Mode has no model choice. */
export const AI_ENGINES: Record<AiEngine, EngineSpec> = {
  chatgpt: { label: 'ChatGPT', platform: 'chat_gpt', model: 'gpt-5.4-mini', localisation: 'country', usd: DFS_PRICES.aiPanelChatgpt },
  claude: { label: 'Claude', platform: 'claude', model: 'claude-haiku-5-5', localisation: 'country', usd: DFS_PRICES.aiPanelClaude },
  gemini: { label: 'Gemini', platform: 'gemini', model: 'gemini-3.6-flash', localisation: 'none', usd: DFS_PRICES.aiPanelGemini },
  perplexity: { label: 'Perplexity', platform: 'perplexity', model: 'sonar', localisation: 'country', usd: DFS_PRICES.aiPanelPerplexity },
  ai_mode: { label: 'Google AI Mode', platform: null, model: null, localisation: 'location', usd: DFS_PRICES.aiPanelAiMode },
};

/** Countries Claude's web_search_country_iso_code accepts (DataForSEO docs, 27 Nov 2026). */
const CLAUDE_COUNTRIES = new Set('AR AT AU BE BR CA CH CL CN DE DK ES FI FR GB HK ID IN IT JP KR MX MY NL NO NZ PH PL PT RU SA SE TR TW US ZA'.split(' '));

export const MAX_AI_PROMPTS = 25;
/** LLM Responses accept up to 500 characters (AI Mode 700): the shorter limit applies to every engine. */
export const MAX_AI_PROMPT_LENGTH = 500;
/** Stored answer text cap. Anything past it is not searched (text_truncated says so). */
export const MAX_ANSWER_CHARS = 16000;
/** Runs of at most this many calls happen inside the tool call. Zero: each takes 6-11 s typically but may take up to the 150 s timeout, so every run is a job (the ~60 s ceiling). */
export const SYNC_MAX_CALLS = 0;
/** A response fetched in the last day is reused from the cache (free) unless the user asked to re-run. */
const ANSWER_MAX_AGE_DAYS = 1;

/** Trim and single-space; case is kept (a prompt is text, not a query key). */
export function normalizePrompt(p: string): string {
  return String(p ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

export interface PanelPrompt { prompt: string; locationCode: number; languageCode: string; addedAt: string }

export function listPrompts(db: Database.Database, locationCode?: number): PanelPrompt[] {
  return (db.prepare(`SELECT prompt, location_code, language_code, added_at FROM ai_prompt ${locationCode != null ? 'WHERE location_code = ?' : ''} ORDER BY location_code, added_at, prompt`)
    .all(...(locationCode != null ? [locationCode] : [])) as any[])
    .map(r => ({ prompt: r.prompt, locationCode: r.location_code, languageCode: r.language_code, addedAt: r.added_at }));
}

export interface AddPromptsResult { added: string[]; alreadyInPanel: string[]; invalid: { prompt: string; reason: string }[]; overCap: string[]; total: number }

/** Add prompts at one location. The panel is capped at MAX_AI_PROMPTS; the overflow is returned, never dropped silently. */
export function addPrompts(store: PortfolioStore, prompts: string[], locationCode: number, languageCode = 'en'): AddPromptsResult {
  const out: AddPromptsResult = { added: [], alreadyInPanel: [], invalid: [], overCap: [], total: 0 };
  const exists = store.db.prepare(`SELECT 1 FROM ai_prompt WHERE lower(prompt) = lower(?) AND location_code = ?`);
  const ins = store.db.prepare(`INSERT INTO ai_prompt (prompt, location_code, language_code) VALUES (?, ?, ?)`);
  let total = (store.db.prepare(`SELECT COUNT(*) n FROM ai_prompt`).get() as { n: number }).n;
  const seen = new Set<string>();
  store.db.transaction(() => {
    for (const raw of prompts) {
      const p = normalizePrompt(raw);
      if (!p) { out.invalid.push({ prompt: String(raw), reason: 'empty' }); continue; }
      if (p.length > MAX_AI_PROMPT_LENGTH) { out.invalid.push({ prompt: p.slice(0, 60) + '...', reason: `longer than ${MAX_AI_PROMPT_LENGTH} characters` }); continue; }
      const k = p.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      if (exists.get(p, locationCode)) { out.alreadyInPanel.push(p); continue; }
      if (total >= MAX_AI_PROMPTS) { out.overCap.push(p); continue; }
      ins.run(p, locationCode, languageCode);
      out.added.push(p);
      total++;
    }
  })();
  out.total = total;
  return out;
}

/** Remove prompts (matched case-insensitively). Their answers stay on record. */
export function removePrompts(store: PortfolioStore, prompts: string[], locationCode?: number): { removed: string[]; notInPanel: string[] } {
  const out = { removed: [] as string[], notInPanel: [] as string[] };
  const del = store.db.prepare(`DELETE FROM ai_prompt WHERE lower(prompt) = lower(?) ${locationCode != null ? 'AND location_code = ?' : ''}`);
  for (const raw of prompts) {
    const p = normalizePrompt(raw);
    (del.run(...(locationCode != null ? [p, locationCode] : [p])).changes ? out.removed : out.notInPanel).push(p);
  }
  return out;
}

// ── Parsing ─────────────────────────────────────────────────────────────────────────────────────

export interface PanelCitation { host: string | null; url: string | null; title: string | null }
export interface PanelAnswer {
  /** The model DataForSEO reports (the resolved version), or 'google-ai-mode'. */
  model: string | null;
  /** The answer's own datetime (UTC), null when the response has none. */
  answeredAt: string | null;
  /** 'no-answer' = the engine returned nothing to read (AI Mode showed no answer, or empty text). */
  status: 'ok' | 'no-answer';
  /** The answer as prose: citation chips, link targets and URLs removed (see cleanAnswerText). */
  text: string;
  textTruncated: boolean;
  /** Distinct cited sources (by URL, else host). */
  citations: PanelCitation[];
  /** Citations whose host could not be read. */
  unattributed: number;
}

/**
 * The prose of an answer, for mention matching. Citations are NOT prose: ChatGPT puts each one in
 * the text as "([host](url))", AI Mode as "[[1]](url)", others as "[1]". Those are removed, then
 * images and links keep only their visible label, and bare URLs go. Without this every cited domain
 * would also read as "mentioned".
 */
export function cleanAnswerText(md: string): string {
  return String(md ?? '')
    .replace(/\[Highlight (?:start|end)\]/g, '')
    .replace(/\(\s*\[[^\]\n]*\]\([^)\s]*\)\s*\)/g, '')       // ChatGPT citation chip: ([host](url))
    .replace(/\[\[\d+\]\]\([^)\s]*\)/g, '')                   // AI Mode chip: [[1]](url)
    .replace(/\[\d+(?:,\s*\d+)*\]/g, '')                      // bare [1] / [1, 2]
    .replace(/!\[([^\]\n]*)\]\([^)\s]*\)/g, '$1')             // image: keep alt text (a product name is prose)
    .replace(/\[([^\]\n]*)\]\([^)\s]*\)/g, '$1')              // link: keep its label
    .replace(/https?:\/\/[^\s)\]]+/g, '')                      // bare URLs
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function finishAnswer(model: string | null, answeredAt: string | null, raw: string, cites: { url?: unknown; direct_url?: unknown; domain?: unknown; title?: unknown }[]): PanelAnswer {
  const full = cleanAnswerText(raw);
  const seen = new Set<string>();
  const citations: PanelCitation[] = [];
  let unattributed = 0;
  for (const c of cites) {
    const s = citationSource(c);
    const key = s.url ?? (s.host ? `host:${s.host}` : `raw:${String(c.url ?? c.title ?? '')}`);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!s.host) unattributed++;
    citations.push({ host: s.host, url: s.url, title: typeof c.title === 'string' ? c.title.slice(0, 200) : null });
  }
  return {
    model, answeredAt, status: full ? 'ok' : 'no-answer',
    text: full.slice(0, MAX_ANSWER_CHARS), textTruncated: full.length > MAX_ANSWER_CHARS, citations, unattributed,
  };
}

/** One LLM Responses answer: message items' text sections joined (Claude splits a sentence across
 * sections, so they join with no separator), annotations from every section. Reasoning items are not
 * the answer and are skipped. Pure. */
export function parseLlmAnswer(resp: Pick<DfsResponse, 'tasks'>): PanelAnswer {
  const result = resp.tasks?.[0]?.result?.[0] ?? {};
  const parts: string[] = [];
  const cites: any[] = [];
  for (const it of (result.items ?? []) as any[]) {
    if (it?.type !== 'message') continue;
    parts.push(((it.sections ?? []) as any[]).filter(s => s?.type === 'text').map(s => String(s.text ?? '')).join(''));
    for (const s of (it.sections ?? []) as any[]) for (const a of (s?.annotations ?? []) as any[]) cites.push(a);
  }
  return finishAnswer(typeof result.model_name === 'string' ? result.model_name : null, serpDatetime(result.datetime), parts.filter(Boolean).join('\n\n'), cites);
}

/** One Google AI Mode answer: the ai_overview item's markdown; citations = the item's references
 * UNION each element's references (the same split as AI Overviews in recon). No ai_overview item =
 * no answer shown. Pure. */
export function parseAiModeAnswer(resp: Pick<DfsResponse, 'tasks'>): PanelAnswer {
  const result = resp.tasks?.[0]?.result?.[0] ?? {};
  const aio = ((result.items ?? []) as any[]).filter(i => i?.type === 'ai_overview');
  const cites: any[] = [];
  for (const it of aio) {
    for (const r of (it.references ?? []) as any[]) cites.push(r);
    for (const e of (it.items ?? []) as any[]) for (const r of (e?.references ?? []) as any[]) cites.push(r);
  }
  const md = aio.map(it => String(it.markdown ?? '')).join('\n\n');
  return finishAnswer('google-ai-mode', serpDatetime(result.datetime), md, cites);
}

// ── Matching ────────────────────────────────────────────────────────────────────────────────────

const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu', 'ltd', 'plc']);
/** The name label of a domain: the label before the public suffix ("simracingcockpit.gg" ->
 * "simracingcockpit", "example.com.au" -> "example", "shop.example.co.uk" -> "example"). */
export function domainNameLabel(domain: string): string {
  const labels = domain.toLowerCase().replace(/^www\./, '').split('.').filter(Boolean);
  if (labels.length < 2) return labels[0] ?? '';
  let rest = labels.slice(0, -1);
  if (rest.length >= 2 && labels[labels.length - 1].length === 2 && SECOND_LEVEL.has(rest[rest.length - 1])) rest = rest.slice(0, -1);
  return rest[rest.length - 1] ?? '';
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Every run of 2+ consecutive words in `text` that, joined, spells `token`, as written. Words are
 * letter/digit runs; the words of a run are separated only by spaces or hyphens (not a full stop or
 * a line break) and each has at least 2 characters (the brand.ts rule, so "vehicle" never spells "hic").
 */
export function spacedRuns(text: string, token: string): string[][] {
  const words = [...text.matchAll(/[A-Za-z0-9]+/g)].map(m => ({ w: m[0], lo: m[0].toLowerCase(), start: m.index!, end: m.index! + m[0].length }));
  const out: string[][] = [];
  for (let i = 0; i < words.length; i++) {
    if (words[i].lo.length < 2 || !token.startsWith(words[i].lo)) continue;
    let joined = words[i].lo;
    for (let j = i + 1; j < words.length; j++) {
      if (words[j].lo.length < 2 || !/^[ \t-]+$/.test(text.slice(words[j - 1].end, words[j].start))) break;
      joined += words[j].lo;
      if (!token.startsWith(joined)) break;
      if (joined === token) { out.push(words.slice(i, j + 1).map(x => x.w)); break; }
    }
  }
  return out;
}

export type MentionKind = 'domain' | 'name' | 'phrase';
/**
 * The mention rule (deterministic, on the cleaned prose):
 *  - 'domain': the domain itself, or a subdomain of it, appears as a whole host, any case
 *    ("simracingcockpit.gg", "www.SimRacingCockpit.gg"). Host boundaries are enforced, so "x.com"
 *    never matches "pimax.com".
 *  - 'name': the name label appears as one whole word, any case ("SimRacingCockpit", "Pimax"; a
 *    hyphenated label also as written: "Sim-Lab" for sim-lab.eu), OR spelled as separate words that
 *    are EACH capitalised like a name ("Next Level Racing", "Trak Racer"). Labels under 3
 *    letters/digits are never names.
 *  - 'phrase': only a spaced spelling that is not capitalised as a name ("sim racing cockpit"). For a
 *    domain made of ordinary words that is usually the topic, not the brand, so it is reported
 *    separately and NOT counted as a mention. (A Title Case heading can still read as a name: the
 *    rule cannot tell those apart, and says so in the output.)
 * Returns the strongest kind found, or null.
 */
export function mentionOf(text: string, domain: string): MentionKind | null {
  const d = domain.toLowerCase().replace(/^www\./, '');
  if (!d) return null;
  if (new RegExp(`(?<![a-z0-9.-])(?:[a-z0-9-]+\\.)*${esc(d)}(?![a-z0-9-]|\\.[a-z0-9])`, 'i').test(text)) return 'domain';
  const label = domainNameLabel(d);
  const token = label.replace(/[^a-z0-9]/g, '');
  if (token.length < 3) return null;
  // Whole word, and not part of a hostname: "example" inside "example.com.au" or "foo-example.com"
  // is another site, not this one's name. A full stop that ends a sentence still counts.
  const word = (w: string) => new RegExp(`(?<![\\p{L}\\p{N}.-])${esc(w)}(?![\\p{L}\\p{N}-]|\\.[\\p{L}\\p{N}])`, 'iu');
  if (word(token).test(text) || (label.includes('-') && word(label).test(text))) return 'name';
  const runs = spacedRuns(text, token);
  if (runs.some(r => r.every(w => /^[A-Z0-9]/.test(w)))) return 'name';
  return runs.length ? 'phrase' : null;
}

export interface DomainMatch { mention: MentionKind | null; cited: boolean; citedUrls: string[] }
export function matchDomain(a: Pick<PanelAnswer, 'text' | 'citations'>, domain: string): DomainMatch {
  const mine = a.citations.filter(c => hostMatchesDomain(c.host, domain));
  return { mention: a.text ? mentionOf(a.text, domain) : null, cited: mine.length > 0, citedUrls: [...new Set(mine.map(c => c.url ?? c.host!).filter(Boolean))] };
}
export const isMention = (k: MentionKind | null): boolean => k === 'domain' || k === 'name';

// ── Storage ─────────────────────────────────────────────────────────────────────────────────────

export const runMonthOf = (d: Date): string => d.toISOString().slice(0, 7);

export function writeAnswer(db: Database.Database, p: { prompt: string; locationCode: number; engine: AiEngine; runMonth: string; runId: number | null; localised: string }, a: PanelAnswer, meta: { cost: number; cached: boolean }, now = new Date()): string {
  const at = a.answeredAt ?? now.toISOString().slice(0, 19).replace('T', ' ');
  // A cache hit is the same answer (same answered_at): keep the row that recorded its month and cost.
  db.prepare(`INSERT OR ${meta.cached ? 'IGNORE' : 'REPLACE'} INTO ai_prompt_answer (prompt, location_code, engine, run_month, answered_at, run_id, model, status, answer_text, text_truncated, citations_json, unattributed, localised, cost, cached)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(p.prompt, p.locationCode, p.engine, p.runMonth, at, p.runId, a.model, a.status, a.text, a.textTruncated ? 1 : 0, JSON.stringify(a.citations), a.unattributed, p.localised, meta.cost, meta.cached ? 1 : 0);
  return at;
}

export interface StoredAnswer {
  runMonth: string; answeredAt: string; model: string | null; status: 'ok' | 'no-answer';
  text: string; textTruncated: boolean; citations: PanelCitation[]; unattributed: number; localised: string | null;
}
const rowToAnswer = (r: any): StoredAnswer => ({
  runMonth: r.run_month, answeredAt: r.answered_at, model: r.model, status: r.status, text: r.answer_text ?? '',
  textTruncated: !!r.text_truncated, citations: JSON.parse(r.citations_json || '[]'), unattributed: r.unattributed ?? 0, localised: r.localised,
});

/** Engine failures from the last run that tried them (portfolio_fetch, endpoint "ai-panel:<engine>"). */
export const ENGINE_FETCH_DOMAIN = '_ai_panel';
export function engineStatus(store: Pick<PortfolioStore, 'fetchState'>): Partial<Record<AiEngine, { status: string; error: string | null; at: string }>> {
  const out: Partial<Record<AiEngine, { status: string; error: string | null; at: string }>> = {};
  for (const [k, v] of store.fetchState()) {
    const m = /^_ai_panel\|0\|ai-panel:(\w+)$/.exec(k);
    if (m && (AI_ENGINE_IDS as string[]).includes(m[1])) out[m[1] as AiEngine] = { status: v.status, error: v.error, at: v.fetchedAt };
  }
  return out;
}

// ── Reading ─────────────────────────────────────────────────────────────────────────────────────

export interface PanelCell {
  engine: AiEngine;
  latest: StoredAnswer | null;
  previous: StoredAnswer | null;
}
export interface PanelRow extends PanelPrompt { cells: PanelCell[] }

/** Every panel prompt (optionally one location) with each engine's latest and previous answer. */
export function readPanel(db: Database.Database, opts: { locationCode?: number } = {}): PanelRow[] {
  const q = db.prepare(`SELECT * FROM ai_prompt_answer WHERE prompt = ? AND location_code = ? AND engine = ? ORDER BY answered_at DESC LIMIT 2`);
  return listPrompts(db, opts.locationCode).map(p => ({
    ...p,
    cells: AI_ENGINE_IDS.map(engine => {
      const [cur, prev] = q.all(p.prompt, p.locationCode, engine) as any[];
      return { engine, latest: cur ? rowToAnswer(cur) : null, previous: prev ? rowToAnswer(prev) : null };
    }),
  }));
}

export type CellState = 'cited-and-mentioned' | 'cited' | 'mentioned' | 'phrase-only' | 'neither' | 'no-answer' | 'not-run';
export function cellState(a: StoredAnswer | null, domain: string): { state: CellState; match: DomainMatch | null } {
  if (!a) return { state: 'not-run', match: null };
  if (a.status === 'no-answer') return { state: 'no-answer', match: null };
  const m = matchDomain(a, domain);
  const ment = isMention(m.mention);
  return { state: m.cited && ment ? 'cited-and-mentioned' : m.cited ? 'cited' : ment ? 'mentioned' : m.mention === 'phrase' ? 'phrase-only' : 'neither', match: m };
}
export const CELL_LABEL: Record<CellState, string> = {
  'cited-and-mentioned': 'cited and mentioned', cited: 'cited', mentioned: 'mentioned', 'phrase-only': 'name phrase only',
  neither: 'neither', 'no-answer': 'no answer', 'not-run': 'not run',
};

/** citeUnknown: answers that don't cite the domain among the citations we could attribute, but carry
 * citations whose site couldn't be read - so "not cited" is unknown there, not a no. */
export interface EngineTally { month: string | null; months: string[]; promptsRun: number; mentioned: number; cited: number; citeUnknown: number; phraseOnly: number; noAnswer: number }
export interface EngineSummary extends EngineTally {
  engine: AiEngine; label: string; model: string | null;
  previous: EngineTally | null;
  lastError: { status: string; error: string | null; at: string } | null;
}

function tally(answers: (StoredAnswer | null)[], domain: string): EngineTally {
  const got = answers.filter((a): a is StoredAnswer => !!a);
  const months = [...new Set(got.map(a => a.runMonth))].sort();
  let mentioned = 0, cited = 0, citeUnknown = 0, phraseOnly = 0, noAnswer = 0;
  for (const a of got) {
    const { state: s, match } = cellState(a, domain);
    if (s === 'no-answer') noAnswer++;
    if (s === 'cited-and-mentioned' || s === 'mentioned') mentioned++;
    if (s === 'cited-and-mentioned' || s === 'cited') cited++;
    else if (s !== 'no-answer' && a.unattributed > 0) citeUnknown++;
    // Only a spaced spelling in the prose, whether or not the domain was also cited.
    if (match?.mention === 'phrase') phraseOnly++;
  }
  return { month: months[months.length - 1] ?? null, months, promptsRun: got.length, mentioned, cited, citeUnknown, phraseOnly, noAnswer };
}

/** Per engine, for one domain: of the prompts with an answer, how many mention / cite it (latest
 * answers), and the same for the previous answers. */
export function summarizePanel(rows: PanelRow[], domain: string, errors: ReturnType<typeof engineStatus> = {}): EngineSummary[] {
  return AI_ENGINE_IDS.map(engine => {
    const cells = rows.map(r => r.cells.find(c => c.engine === engine)!);
    const latest = tally(cells.map(c => c.latest), domain);
    const prevCells = cells.map(c => c.previous);
    const models = [...new Set(cells.map(c => c.latest?.model).filter(Boolean))] as string[];
    const err = errors[engine];
    return {
      engine, label: AI_ENGINES[engine].label, model: models.join(', ') || AI_ENGINES[engine].model, ...latest,
      previous: prevCells.some(Boolean) ? tally(prevCells, domain) : null,
      lastError: err && err.status !== 'ok' ? err : null,
    };
  });
}

// ── Quote and run ───────────────────────────────────────────────────────────────────────────────

export interface PanelSelection { prompts?: string[]; locationCode?: number; engines?: AiEngine[]; rerun?: boolean }
export interface PanelCall { prompt: PanelPrompt; engine: AiEngine }
export interface PanelQuote {
  month: string;
  prompts: number;
  calls: number;
  usd: number;
  byEngine: { engine: AiEngine; label: string; model: string | null; calls: number; usdPerCall: number; usd: number }[];
  /** prompt x engine pairs already answered this month and left out (rerun:true asks them again). */
  alreadyThisMonth: { prompt: string; engine: AiEngine }[];
  notInPanel: string[];
  domains: string[];
  note: string;
}

function planCalls(store: PortfolioStore, sel: PanelSelection, now: Date): { calls: PanelCall[]; prompts: PanelPrompt[]; already: { prompt: string; engine: AiEngine }[]; notInPanel: string[] } {
  const all = listPrompts(store.db, sel.locationCode);
  let prompts = all, notInPanel: string[] = [];
  if (sel.prompts?.length) {
    const want = new Map(sel.prompts.map(p => [normalizePrompt(p).toLowerCase(), normalizePrompt(p)]));
    prompts = all.filter(p => want.has(p.prompt.toLowerCase()));
    const have = new Set(prompts.map(p => p.prompt.toLowerCase()));
    notInPanel = [...want].filter(([k]) => !have.has(k)).map(([, v]) => v);
  }
  const engines = sel.engines?.length ? AI_ENGINE_IDS.filter(e => sel.engines!.includes(e)) : AI_ENGINE_IDS;
  const month = runMonthOf(now);
  const done = store.db.prepare(`SELECT 1 FROM ai_prompt_answer WHERE prompt = ? AND location_code = ? AND engine = ? AND run_month = ? LIMIT 1`);
  const calls: PanelCall[] = [], already: { prompt: string; engine: AiEngine }[] = [];
  for (const engine of engines) {
    for (const p of prompts) {
      if (!sel.rerun && done.get(p.prompt, p.locationCode, engine, month)) { already.push({ prompt: p.prompt, engine }); continue; }
      calls.push({ prompt: p, engine });
    }
  }
  return { calls, prompts, already, notInPanel };
}

const r4 = (v: number): number => Math.round(v * 10000) / 10000;

export function quotePanelRun(store: PortfolioStore, sel: PanelSelection, now = new Date()): PanelQuote {
  store.syncOwned();
  const { calls, prompts, already, notInPanel } = planCalls(store, sel, now);
  const byEngine = AI_ENGINE_IDS.map(engine => {
    const n = calls.filter(c => c.engine === engine).length;
    return { engine, label: AI_ENGINES[engine].label, model: AI_ENGINES[engine].model, calls: n, usdPerCall: AI_ENGINES[engine].usd, usd: r4(n * AI_ENGINES[engine].usd) };
  }).filter(e => e.calls > 0);
  return {
    month: runMonthOf(now), prompts: prompts.length, calls: calls.length, usd: r4(byEngine.reduce((s, e) => s + e.usd, 0)), byEngine,
    alreadyThisMonth: already, notInPanel,
    domains: [...new Set(store.list().map(d => d.domain))].sort(),
    note: `Prices are the costs observed on live calls (27 Nov 2026): the LLM engines bill $0.0006 per task plus the model's own token cost, so a long answer costs more than the estimate; the run records what it really spent. One answer per prompt per engine, with web search on. An answer fetched in the last 24 hours is reused from the cache at no cost${sel.rerun ? ', except on a re-run, which asks again' : ''}.`,
  };
}

/** How the prompt's location reaches one engine, and how that is labelled. */
export function localisationFor(engine: AiEngine, locationCode: number): { params: Record<string, unknown>; label: string } {
  const iso = LOCATION_ISO[locationCode];
  const spec = AI_ENGINES[engine];
  if (spec.localisation === 'location') return { params: {}, label: `${LOCATION_LABEL[locationCode] ?? `location ${locationCode}`} (Google location)` };
  if (spec.localisation === 'country' && iso && (engine !== 'claude' || CLAUDE_COUNTRIES.has(iso))) return { params: { web_search_country_iso_code: iso }, label: `${iso} (web search country)` };
  return { params: {}, label: 'not localised' };
}

async function ask(dfs: DataForSeoClient, engine: AiEngine, p: PanelPrompt, maxAgeDays: number): Promise<{ answer: PanelAnswer; cost: number; cached: boolean; localised: string }> {
  const spec = AI_ENGINES[engine];
  const loc = localisationFor(engine, p.locationCode);
  if (!spec.platform) {
    const r = await dfs.serpAiMode(p.prompt, p.locationCode, p.languageCode, { maxAgeDays });
    return { answer: parseAiModeAnswer(r), cost: r.cost || 0, cached: r.cached, localised: loc.label };
  }
  const body: Record<string, unknown> = { user_prompt: p.prompt, model_name: spec.model, web_search: true, max_output_tokens: 2048, ...loc.params };
  const r = await dfs.llmResponsesLive(spec.platform, body, { maxAgeDays });
  return { answer: parseLlmAnswer(r), cost: r.cost || 0, cached: r.cached, localised: loc.label };
}

export interface PanelRunArgs extends PanelSelection {
  trigger?: 'manual';
  /** The job running this panel, recorded on its portfolio_run row. */
  jobId?: string;
  /** Monthly portfolio cap in USD this run must respect (null = no cap). */
  budgetUsd?: number | null;
}
export interface PanelRunResult {
  runId: number;
  month: string;
  answered: number;
  failed: { prompt: string; engine: AiEngine; error: string }[];
  skippedBudget: { prompt: string; engine: AiEngine }[];
  alreadyThisMonth: number;
  spent: number;
  cacheHits: number;
  quoted: number;
  note: string;
}

export async function runPanel(
  dataDir: string, dfs: DataForSeoClient, args: PanelRunArgs,
  update: (p: Record<string, unknown>) => void, signal: AbortSignal, now = new Date(),
): Promise<PanelRunResult> {
  const store = new PortfolioStore(dataDir);
  try {
    const quote = quotePanelRun(store, args, now);
    const { calls } = planCalls(store, args, now);
    const prior = store.spentThisMonth(now);
    const runId = Number(store.db.prepare(`INSERT INTO portfolio_run (started_at, tier, trigger, quoted_usd, status, job_id) VALUES (?, 'ai-panel', 'manual', ?, 'running', ?)`).run(now.toISOString(), quote.usd, args.jobId ?? null).lastInsertRowid);
    let spent = 0, n = 0, cacheHits = 0, answered = 0;
    const failed: PanelRunResult['failed'] = [];
    const skippedBudget: PanelRunResult['skippedBudget'] = [];
    const dead = new Map<AiEngine, string>();
    const ledger = () => store.db.prepare('UPDATE portfolio_run SET spent_usd = ?, calls = ?, cache_hits = ? WHERE id = ?').run(r4(spent), n, cacheHits, runId);
    for (let i = 0; i < calls.length; i++) {
      const { prompt: p, engine } = calls[i];
      if (signal.aborted) break;
      // An engine that is not enabled fails the same way every time: don't keep paying to find out.
      if (dead.has(engine)) { failed.push({ prompt: p.prompt, engine, error: `not tried: ${dead.get(engine)}` }); continue; }
      if (args.budgetUsd != null && prior + spent + AI_ENGINES[engine].usd > args.budgetUsd + 1e-9) { skippedBudget.push({ prompt: p.prompt, engine }); continue; }
      update({ runId, engine, prompt: p.prompt, done: i, total: calls.length, spentSoFar: r4(spent) });
      try {
        // The cache may serve an answer from the last day, but never one from before this month started:
        // a run on the 1st must not file November's answer as December's sample.
        const sinceMonthStart = (now.getTime() - Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)) / 86_400_000;
        const r = await ask(dfs, engine, p, args.rerun ? 0 : Math.min(ANSWER_MAX_AGE_DAYS, sinceMonthStart));
        n++; if (r.cached) cacheHits++; spent += r.cost; ledger();
        writeAnswer(store.db, { prompt: p.prompt, locationCode: p.locationCode, engine, runMonth: quote.month, runId, localised: r.localised }, r.answer, { cost: r.cost, cached: r.cached }, now);
        store.recordFetch(ENGINE_FETCH_DOMAIN, 0, `ai-panel:${engine}`, 'ok');
        answered++;
      } catch (e) {
        const { status, error } = classifyDfsError(e);
        failed.push({ prompt: p.prompt, engine, error: error.slice(0, 300) });
        store.recordFetch(ENGINE_FETCH_DOMAIN, 0, `ai-panel:${engine}`, status, error.slice(0, 300));
        if (status === 'not-enabled') dead.set(engine, `${AI_ENGINES[engine].label} is not enabled on this DataForSEO account`);
      }
    }
    ledger();
    const status = signal.aborted ? 'cancelled' : skippedBudget.length ? 'partial-budget' : failed.length ? (answered ? 'partial' : 'failed') : 'completed';
    const note = [
      `${answered} of ${calls.length} prompt x engine answer${calls.length === 1 ? '' : 's'} stored for ${quote.month}, ${n} calls (${cacheHits} from cache), spent $${r4(spent)} (quoted $${quote.usd})`,
      quote.alreadyThisMonth.length ? `${quote.alreadyThisMonth.length} already answered this month, not asked again` : '',
      failed.length ? `${failed.length} failed` : '',
      skippedBudget.length ? `${skippedBudget.length} skipped to stay within the $${args.budgetUsd} monthly budget` : '',
    ].filter(Boolean).join('; ');
    store.db.prepare(`UPDATE portfolio_run SET finished_at = ?, status = ?, note = ? WHERE id = ?`).run(new Date().toISOString(), status, note, runId);
    if (!signal.aborted && calls.length > 0 && answered === 0 && failed.length > 0 && !skippedBudget.length) {
      throw new Error(`AI prompt panel run failed: no answer was stored. First error: ${failed[0].error}`);
    }
    return { runId, month: quote.month, answered, failed, skippedBudget, alreadyThisMonth: quote.alreadyThisMonth.length, spent: r4(spent), cacheHits, quoted: quote.usd, note };
  } finally { store.close(); }
}
