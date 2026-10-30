// SEO Console - the in-chat portfolio widget (get_portfolio). The table and overview live in
// portfolio-view.ts, shared with the browser dashboard's "All domains" view.
import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';
import { mountPortfolio, loadPortfolio, openDomain, refreshPortfolioView, backToTable } from './portfolio-view.js';

const app = new App({ name: 'SEO Console - Portfolio', version: '0.1.0' });
const fixture = (window as any).__PORTFOLIO_FIXTURE__ as unknown;
const overviewFixture = (window as any).__DOMAIN_FIXTURE__ as unknown;

function applyHostContext(ctx: any): void {
  if (!ctx) return;
  if (ctx.theme) { applyDocumentTheme(ctx.theme); document.documentElement.classList.toggle('dark', ctx.theme === 'dark'); }
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
}

async function init(): Promise<void> {
  const root = document.getElementById('app')!;
  const host = {
    root, web: false,
    callServer: (name: string, args: Record<string, unknown>) => app.callServerTool({ name, arguments: args }),
    canMessage: () => !fixture && !!(app.getHostCapabilities?.() as any)?.message,
    sendMessage: (text: string) => app.sendMessage({ role: 'user', content: [{ type: 'text', text }] }) as Promise<{ isError?: boolean } | undefined>,
  };
  if (fixture) {
    if ((window as any).__PORTFOLIO_THEME__ === 'dark') document.documentElement.classList.add('dark');
    mountPortfolio(host, { fixture, overviewFixture });
    return;
  }
  mountPortfolio(host, { defer: true });
  document.getElementById('nav-domains')?.addEventListener('click', () => backToTable());
  // get_portfolio's result names an optional domain to open.
  app.ontoolresult = (r: { structuredContent?: { domain?: string | null } }) => {
    const d = r.structuredContent?.domain;
    void loadPortfolio().then(() => { if (d) void openDomain(d); });
  };
  app.onhostcontextchanged = (ctx: any) => { applyHostContext(ctx); refreshPortfolioView(); };
  try {
    await app.connect();
    applyHostContext(app.getHostContext());
  } catch (e) {
    root.innerHTML = `<div class="state error-state">${String(e instanceof Error ? e.message : e).replace(/</g, '&lt;')}</div>`;
  }
}

void init();
