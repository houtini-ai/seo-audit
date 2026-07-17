/**
 * Agent-readiness checker — is a site ready for AI agents to discover and use it? Models the
 * signals from Cloudflare's "Is Your Site Agent-Ready?" (isitagentready.com): Discoverability,
 * Content, Bot-Access-Control, Capabilities. Each check is a cheap HTTP probe of a fixed path or
 * header (deterministic — cite the bytes). Returns a 0–100 score, a level, and a per-check
 * checklist with copy-paste-ready fixes. The agentic-SEO/GEO frontier — almost no audit tool
 * does this. (Reference impl of the SERVING side: c:\dev\yubnub.)
 */

export type AgentCategory = 'Discoverability' | 'Content' | 'Bot access control' | 'Capabilities';
export interface AgentCheck { id: string; category: AgentCategory; label: string; present: boolean; detail: string; fix: string }
export interface AgentReadiness {
  siteUrl: string; origin: string; score: number; level: string;
  byCategory: { category: AgentCategory; passed: number; total: number }[];
  checks: AgentCheck[];
  commerceNote: string;
}

const UA = 'Mozilla/5.0 (compatible; SEOAuditConsole/1.0; +https://houtini.com)';
// The AI crawlers a site would name in robots.txt if it had AI-specific rules.
const AI_BOTS = /(GPTBot|OAI-SearchBot|ChatGPT-User|ClaudeBot|Claude-Web|anthropic-ai|Google-Extended|PerplexityBot|CCBot|Bytespider|Amazonbot|Applebot-Extended|cohere-ai|Meta-ExternalAgent|DuckAssistBot)/i;

interface Probe { ok: boolean; status: number; ct: string; text: string; link: string | null }
async function probe(url: string, accept = '*/*'): Promise<Probe> {
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept }, redirect: 'follow', signal: AbortSignal.timeout(8000) });
    const ct = (res.headers.get('content-type') ?? '').toLowerCase();
    const text = res.ok ? (await res.text()).slice(0, 20000) : '';
    return { ok: res.ok, status: res.status, ct, text, link: res.headers.get('link') };
  } catch { return { ok: false, status: 0, ct: '', text: '', link: null }; }
}

// `res.ok` alone is not "present": a SPA/CDN with a catch-all 200 route serves its HTML
// shell for /llms.txt, /agents.md and every /.well-known/* probe — the exact soft-404
// pattern the audit's own soft-404-shell check exists to catch. Validate the body shape.
const looksHtml = (p: Probe): boolean => /text\/html/.test(p.ct) || /^\s*(<!doctype\s|<html[\s>])/i.test(p.text);
const textReal = (p: Probe): boolean => p.ok && p.text.trim().length > 0 && !looksHtml(p);
const jsonReal = (p: Probe): boolean => {
  if (!p.ok || looksHtml(p)) return false;
  if (/json/.test(p.ct)) return true;
  try { JSON.parse(p.text); return true; } catch { return false; }
};
const xmlReal = (p: Probe): boolean => p.ok && (/xml/.test(p.ct) || /<\?xml|<(urlset|sitemapindex)[\s>]/i.test(p.text));

function originOf(siteUrl: string): string {
  const bare = siteUrl.replace(/^sc-domain:/, '');
  try { return new URL(/^https?:\/\//.test(bare) ? bare : `https://${bare}`).origin; } catch { return `https://${bare.replace(/\/.*$/, '')}`; }
}

export async function checkAgentReadiness(siteUrl: string): Promise<AgentReadiness> {
  const origin = originOf(siteUrl);
  const u = (p: string): string => origin + p;

  const [robots, sitemap, home, homeMd, llms, agentsMd, mcpCard, skills, apiCatalog, oauthPR, oauthAS, webBotAuth] = await Promise.all([
    probe(u('/robots.txt')), probe(u('/sitemap.xml')), probe(u('/')), probe(u('/'), 'text/markdown'),
    probe(u('/llms.txt')), probe(u('/agents.md')), probe(u('/.well-known/mcp/server-card.json')),
    probe(u('/.well-known/agent-skills/index.json')), probe(u('/.well-known/api-catalog')),
    probe(u('/.well-known/oauth-protected-resource')), probe(u('/.well-known/oauth-authorization-server')),
    probe(u('/.well-known/http-message-signatures-directory')),
  ]);

  const robotsReal = textReal(robots);
  const robotsTxt = robotsReal ? robots.text : '';
  const hasAiRules = robotsReal && AI_BOTS.test(robotsTxt);
  const hasContentSignals = robotsReal && /content-signal\s*:/i.test(robotsTxt);
  const hasSitemapDirective = robotsReal && /^\s*sitemap\s*:/im.test(robotsTxt);
  const mdNegotiated = homeMd.ok && /text\/markdown/.test(homeMd.ct);
  const sitemapReal = xmlReal(sitemap);
  const llmsReal = textReal(llms);
  const agentsMdReal = textReal(agentsMd);

  const checks: AgentCheck[] = [
    { id: 'robots-txt', category: 'Discoverability', present: robotsReal, label: 'robots.txt present', detail: robotsReal ? `200 (${robotsTxt.length} bytes)` : robots.ok ? 'returns HTML (catch-all route, not a real robots.txt)' : `not found (${robots.status})`, fix: 'Serve a /robots.txt — the base discovery file every crawler and agent checks first.' },
    { id: 'sitemap', category: 'Discoverability', present: sitemapReal || hasSitemapDirective, label: 'XML sitemap', detail: sitemapReal ? 'sitemap.xml found' : hasSitemapDirective ? 'declared in robots.txt' : sitemap.ok ? 'returns non-XML (catch-all route)' : 'none found', fix: 'Publish /sitemap.xml and reference it with a `Sitemap:` line in robots.txt.' },
    { id: 'link-headers', category: 'Discoverability', present: !!home.link, label: 'Link response headers (RFC 8288)', detail: home.link ? home.link.slice(0, 120) : 'no Link header on the homepage', fix: 'Emit Link: headers pointing agents to your API/docs/llms.txt (rel="describedby" etc.).' },
    { id: 'llms-txt', category: 'Content', present: llmsReal, label: 'llms.txt', detail: llmsReal ? `200 (${llms.text.length} bytes)` : llms.ok ? 'returns HTML (catch-all route, not a real llms.txt)' : `not found (${llms.status})`, fix: 'Add /llms.txt — a plain-text reading list pointing agents at your most useful pages/docs.' },
    { id: 'agents-md', category: 'Content', present: agentsMdReal, label: 'agents.md', detail: agentsMdReal ? `200 (${agentsMd.text.length} bytes)` : agentsMd.ok ? 'returns HTML (catch-all route, not a real agents.md)' : `not found (${agentsMd.status})`, fix: 'Add /agents.md describing how agents should use your site (allowed actions, endpoints, etiquette).' },
    { id: 'markdown-negotiation', category: 'Content', present: mdNegotiated, label: 'Markdown content negotiation', detail: mdNegotiated ? 'serves text/markdown on Accept' : 'returns HTML only', fix: 'Honour `Accept: text/markdown` (or an index.md fallback) so agents read clean content without parsing HTML.' },
    { id: 'ai-bot-rules', category: 'Bot access control', present: hasAiRules, label: 'AI-bot rules in robots.txt', detail: hasAiRules ? 'names AI crawlers (GPTBot/ClaudeBot/…)' : 'no AI-specific user-agents', fix: 'Add explicit allow/disallow rules for AI user-agents (GPTBot, ClaudeBot, Google-Extended, PerplexityBot, CCBot…).' },
    { id: 'content-signals', category: 'Bot access control', present: hasContentSignals, label: 'Content Signals', detail: hasContentSignals ? 'Content-Signal directives present' : 'none', fix: 'Add Cloudflare Content-Signal directives (ai-train / ai-input / search) to robots.txt to state how your content may be used.' },
    { id: 'web-bot-auth', category: 'Bot access control', present: jsonReal(webBotAuth), label: 'Web Bot Auth', detail: jsonReal(webBotAuth) ? 'signature directory present' : 'not found', fix: 'Publish /.well-known/http-message-signatures-directory so well-behaved agents can authenticate.' },
    { id: 'mcp-server-card', category: 'Capabilities', present: jsonReal(mcpCard), label: 'MCP server card', detail: jsonReal(mcpCard) ? 'server-card.json present' : 'not found', fix: 'Expose /.well-known/mcp/server-card.json so agents can discover your MCP server + tools.' },
    { id: 'agent-skills', category: 'Capabilities', present: jsonReal(skills), label: 'Agent Skills', detail: jsonReal(skills) ? 'agent-skills index present' : 'not found', fix: 'Declare capabilities at /.well-known/agent-skills/index.json (agentskills.io).' },
    { id: 'api-catalog', category: 'Capabilities', present: jsonReal(apiCatalog), label: 'API Catalog (RFC 9727)', detail: jsonReal(apiCatalog) ? 'api-catalog present' : 'not found', fix: 'Publish /.well-known/api-catalog listing your machine-usable APIs.' },
    { id: 'oauth-discovery', category: 'Capabilities', present: jsonReal(oauthPR) || jsonReal(oauthAS), label: 'OAuth discovery (RFC 8414/9728)', detail: (jsonReal(oauthPR) || jsonReal(oauthAS)) ? 'oauth metadata present' : 'not found', fix: 'If agents need authenticated actions, expose OAuth metadata at /.well-known/oauth-protected-resource (RFC 9728).' },
  ];

  const cats: AgentCategory[] = ['Discoverability', 'Content', 'Bot access control', 'Capabilities'];
  const byCategory = cats.map(category => {
    const cc = checks.filter(c => c.category === category);
    return { category, passed: cc.filter(c => c.present).length, total: cc.length };
  });
  const passed = checks.filter(c => c.present).length;
  const score = Math.round((passed / checks.length) * 100);
  const level = score >= 80 ? 'Agent-native' : score >= 50 ? 'Agent-friendly' : score >= 20 ? 'Some agent signals' : 'Basic web presence';

  return {
    siteUrl, origin, score, level, byCategory, checks,
    commerceNote: 'Commerce protocols (x402, ACP, UCP, MPP) are emerging and not reliably detectable from a passive probe — review manually if you transact with agents.',
  };
}

/** Human-readable markdown report (for the tool result). */
export function buildAgentReadinessMarkdown(r: AgentReadiness): string {
  const icon = (b: boolean): string => b ? '✅' : '⬜';
  const out: string[] = [
    `# Agent readiness — ${r.siteUrl.replace(/^sc-domain:/, '')}`,
    `**${r.score}/100 · ${r.level}** — how ready your site is for AI agents to discover and use it.`,
    `\n${r.byCategory.map(c => `${c.category} ${c.passed}/${c.total}`).join(' · ')}\n`,
  ];
  let cat = '';
  for (const c of r.checks) {
    if (c.category !== cat) { cat = c.category; out.push(`\n## ${cat}`); }
    out.push(`- ${icon(c.present)} **${c.label}** — ${c.detail}`);
    if (!c.present) out.push(`    - Fix: ${c.fix}`);
  }
  out.push('', `> ${r.commerceNote}`);
  return out.join('\n');
}
