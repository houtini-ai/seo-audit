# Portfolio dashboard: execution plan

The spec is `SPEC.md` v1.1; its review section is authoritative. The branch is `feat/portfolio-dashboard`. The tasks are ordered so each slice compiles, has a probe, and is committed before the next one.

| # | Slice | Files | Done when |
|---|---|---|---|
| 1 | **Client** | `DataForSeoClient.ts` | Per-call `maxAgeDays`, `fetchImpl` hook and the portfolio methods are in. `rankedKeywordsMetrics` sends `item_types`. `backlinksHistory` gets `rank_scale`. Fixtures are saved. |
| 2 | **Target derivation** | `core/portfolioTarget.ts`; RankTracker uses it | One `targetForProperty(siteUrl)` that strips the scheme and `www.` and turns `sc-domain:` into the bare host. RankTracker's body is unchanged for non-www properties, so the cache stays shared. www properties change target, noted in the CHANGELOG. |
| 3 | **Store** | `core/PortfolioStore.ts`; `dataStorage.ts` (`CACHE_DB_NAMES` += `_portfolio.db`) | `_portfolio.db` schema with the `(domain, location_code)` keys. Owned rows are synced from `listLocalProperties` + `getDfsLocation`, and watched rows can be added and removed (cap 50, hostname validation). |
| 4 | **Prices + quote** | `core/portfolioPrices.ts` | `DFS_PRICES` holds the observed costs, the source and the date. `quotePortfolioRefresh(domains, tier, cacheState)` counts cache hits as $0, groups domains by location for bulk calls, and splits LLM calls per platform. |
| 5 | **Ingest** | `core/portfolioIngest.ts` | Pure response→rows mappers, each tested against a fixture:<br>• buckets (1-3 / 4-10 / 11-20 / 21-50 / 51-100)<br>• countries (sum languages, sort by ETV)<br>• SERP mix<br>• LLM per platform<br>• cited pages restricted to the domain's own host<br>• sources excluding the target |
| 6 | **Refresh job** | `core/PortfolioRefresh.ts`; `jobKinds.ts` `portfolio` | Tiers run family by family, with a budget check between families. `portfolio_fetch` records status and the error kind (`not-enabled` for 40204, etc.). The `portfolio_run` ledger is written. Owned domains also write `rank_history` from the same response. Scope `_portfolio.db`. |
| 7 | **Payload** | `core/portfolioData.ts` | `getPortfolioData` and `getDomainOverview`: last-complete-month change maths, the partial month flagged, empty-reason cells, attention rules, and cheap owned-property reads (`clickWindows`, the latest audit, freshness). |
| 8 | **Tools** | `server.ts` | `portfolio` (list/add/remove/set-location/group), `refresh_portfolio` (quote, then `confirm`), `schedule_portfolio_refresh` (preview, then `confirm`), and `get_portfolio` (App). |
| 9 | **Scheduler** | `core/portfolioSchedule.ts`; server + runner | Atomic claim and the `liveJobTypes` guard. Timer only when not external, `unref`'d. Next run computed from now. Budget skip rows. The consent quote is checked against a >25% drift. |
| 10 | **Web** | `webHandlers.ts`, `webServer.ts` | `/` → portfolio when there's more than one property, plus `/portfolio`. Handlers: `get_portfolio_data`, `get_domain_overview`, `portfolio_add_domain`, `portfolio_remove_domain`. |
| 11 | **UI** | `src/ui/portfolio.html`, `portfolio.ts`, `vite` entry | The table with shared-instance sparklines, tabs, group filter, CSV, the Month/Year toggle and the empty states. Then the domain overview sections in the spec's AI-view order. Stitch's critique (`stitch/CRITIQUE.md`) is applied. The chat button uses `sendMessage` when the host supports it. |
| 12 | **Tests** | `scripts/probe-portfolio.mjs` (into `npm test`) | Fixture-fed (no network). Covers the quote, partial-failure isolation, the ledger, the budget guard, the atomic claim (two claimers, one wins), the missed-run catch-up, the mappers, the attention rules, the payload shape and the partial month. |
| 13 | **Live check** | one real refresh on 2-3 owned domains | Actual spend matches the quote to within 10%, and a screenshot of the page is taken. |
| 14 | **Docs** | README section, `manual/portfolio.md`, CHANGELOG, CLAUDE.md, side fix "daily → monthly" | Done; nothing is published until Richard publishes. |

**Risk notes:**
- `historical_rank_overview` dominates cost. Owned domains reuse RankTracker's cache entry.
- LLM Mentions is the next biggest cost. It's monthly, and its database refreshes on a 60-day cycle anyway.
