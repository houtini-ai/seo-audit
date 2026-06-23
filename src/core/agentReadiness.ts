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

  const robotsTxt = robots.text;
  const hasAiRules = robots.ok && AI_BOTS.test(robotsTxt);
  const hasContentSignals = robots.ok && /content-signal\s*:/i.test(robotsTxt);
  const hasSitemapDirective = robots.ok && /^\s*sitemap\s*:/im.test(robotsTxt);
  const mdNegotiated = homeMd.ok && /text\/markdown/.test(homeMd.ct);

  const checks: AgentCheck[] = [
    { id: 'robots-txt', category: 'Discoverability', present: robots.ok, label: 'robots.txt present', detail: robots.ok ? `200 (${robotsTxt.length} bytes)` : `not found (${robots.status})`, fix: 'Serve a /robots.txt — the base discovery file every crawler and agent checks first.' },
    { id: 'sitemap', category: 'Discoverability', present: sitemap.ok || hasSitemapDirective, label: 'XML sitemap', detail: sitemap.ok ? 'sitemap.xml found' : hasSitemapDirective ? 'declared in robots.txt' : 'none found', fix: 'Publish /sitemap.xml and reference it with a `Sitemap:` line in robots.txt.' },
    { id: 'link-headers', category: 'Discoverability', present: !!home.link, label: 'Link response headers (RFC 8288)', detail: home.link ? home.link.slice(0, 120) : 'no Link header on the homepage', fix: 'Emit Link: headers pointing agents to your API/docs/llms.txt (rel="describedby" etc.).' },
    { id: 'llms-txt', category: 'Content', present: llms.ok, label: 'llms.txt', detail: llms.ok ? `200 (${llms.text.length} bytes)` : `not found (${llms.status})`, fix: 'Add /llms.txt — a plain-text reading list pointing agents at your most useful pages/docs.' },
    { id: 'agents-md', category: 'Content', present: agentsMd.ok, label: 'agents.md', detail: agentsMd.ok ? `200 (${agentsMd.text.length} bytes)` : `not found (${agentsMd.status})`, fix: 'Add /agents.md describing how agents should use your site (allowed actions, endpoints, etiquette).' },
    { id: 'markdown-negotiation', category: 'Content', present: mdNegotiated, label: 'Markdown content negotiation', detail: mdNegotiated ? 'serves text/markdown on Accept' : 'returns HTML only', fix: 'Honour `Accept: text/markdown` (or an index.md fallback) so agents read clean content without parsing HTML.' },
    { id: 'ai-bot-rules', category: 'Bot access control', present: hasAiRules, label: 'AI-bot rules in robots.txt', detail: hasAiRules ? 'names AI crawlers (GPTBot/ClaudeBot/…)' : 'no AI-specific user-agents', fix: 'Add explicit allow/disallow rules for AI user-agents (GPTBot, ClaudeBot, Google-Extended, PerplexityBot, CCBot…).' },
    { id: 'content-signals', category: 'Bot access control', present: hasContentSignals, label: 'Content Signals', detail: hasContentSignals ? 'Content-Signal directives present' : 'none', fix: 'Add Cloudflare Content-Signal directives (ai-train / ai-input / search) to robots.txt to state how your content may be used.' },
    { id: 'web-bot-auth', category: 'Bot access control', present: webBotAuth.ok, label: 'Web Bot Auth', detail: webBotAuth.ok ? 'signature directory present' : 'not found', fix: 'Publish /.well-known/http-message-signatures-directory so well-behaved agents can authenticate.' },
    { id: 'mcp-server-card', category: 'Capabilities', present: mcpCard.ok, label: 'MCP server card', detail: mcpCard.ok ? 'server-card.json present' : 'not found', fix: 'Expose /.well-known/mcp/server-card.json so agents can discover your MCP server + tools.' },
    { id: 'agent-skills', category: 'Capabilities', present: skills.ok, label: 'Agent Skills', detail: skills.ok ? 'agent-skills index present' : 'not found', fix: 'Declare capabilities at /.well-known/agent-skills/index.json (agentskills.io).' },
    { id: 'api-catalog', category: 'Capabilities', present: apiCatalog.ok, label: 'API Catalog (RFC 9727)', detail: apiCatalog.ok ? 'api-catalog present' : 'not found', fix: 'Publish /.well-known/api-catalog listing your machine-usable APIs.' },
    { id: 'oauth-discovery', category: 'Capabilities', present: oauthPR.ok || oauthAS.ok, label: 'OAuth discovery (RFC 8414/9728)', detail: (oauthPR.ok || oauthAS.ok) ? 'oauth metadata present' : 'not found', fix: 'If agents need authenticated actions, expose OAuth metadata at /.well-known/oauth-protected-resource (RFC 9728).' },
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
