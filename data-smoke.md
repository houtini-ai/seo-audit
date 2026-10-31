# Real-data smoke test

A runbook for driving one real, end-to-end pass of SEO Audit Console against a Search
Console property you own, and spot-checking it by eye. The automated suite (`npm test`) runs
entirely on synthetic data and local servers; this is the step that exercises the live Google
Search Console API, a real crawl of a real site, and the dashboard, which the suite cannot.

**Who runs this:** a local Claude Code session (or you) on a machine that has the credentials.
It is deliberately kept out of CI, because it needs real secrets, hits a live site, and (if you
opt in) spends DataForSEO money.

## Before you start

- **Node 22 or newer** and a clone of this repo, built: `npm ci && npm run build`.
- **A Search Console property you own**, verified in Google Search Console.
- **A Google Cloud service-account JSON key**, with the Search Console API enabled, and the
  service account's `client_email` added as a user on that property (Search Console → the
  property → Settings → Users and permissions → Add user). This is the step people miss.
- *Optional:* DataForSEO credentials, only if you want to exercise the paid tools. **Those cost
  money.** Leave them unset to keep this smoke free.

### Safety rules (read these)

- **Never commit a credential.** The key file, `.env`, and anything matching `*-credentials.json`
  / `gsc-*.json` are gitignored; keep it that way. Point at the key by path, don't paste it.
- **Use a property you actually own.** The crawl fetches your real site (politely, robots-aware).
- **Free by default.** Only `list_properties`, `sync_gsc`, `start_crawl`, `inspect_urls`,
  `run_audit`, `serve_dashboard` and CrUX are used below, all free. Do not run DataForSEO tools
  (`recon_targets`, `pull_backlinks`, `ranked_keywords`, `refresh_portfolio`, …) as part of the
  smoke unless you explicitly want to pay for a quoted call.
- **Use a scratch data dir**, so the smoke never touches a real working database:
  `export SAC_DATA_DIR="$(mktemp -d)"` (and delete it afterwards).

## Run it

Set the environment, pointing at your key and a throwaway data dir:

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/service-account.json
export SAC_DATA_DIR="$(mktemp -d)"
# optional, only if you intend to pay: export DATAFORSEO_USERNAME=... DATAFORSEO_PASSWORD=...
# optional, free field CWV:            export CRUX_API_KEY=...
```

Then drive the MCP server. Two ways:

### A. Through the MCP (the normal path)

Register this build with your MCP client (`node <repo>/dist/index.js`, with the env above), then
ask the local Claude, in order:

1. **`seo_audit_help`** - confirm the "Setup on this machine" block shows Search Console **on**
   with your service account's email. If it says off, fix the credentials before going on.
2. **`list_properties`** - your property must appear. An empty list means the service account is
   not yet a user on the property (the reply names the email to add).
3. **`refresh_property`** for your property - this syncs Search Console, crawls the site, inspects
   top URLs, and (if `CRUX_API_KEY` is set) pulls field CWV, as one async job. Poll
   **`check_sync_status`** until it reports completed. On a large site the crawl takes a while;
   that is expected, and the status shows its stage and page count.
4. **`run_audit`** for the property.
5. **`serve_dashboard`** (or `open_dashboard`) and open the returned `http://127.0.0.1:…` URL.

### B. Scripted (no MCP client)

From the repo, with the same env set, a minimal direct pass:

```bash
# list properties
node -e "import('./dist/core/GscClient.js').then(async m=>{const c=new m.GscClient(process.env.GOOGLE_APPLICATION_CREDENTIALS);console.log(await c.listProperties())})"
```

Then use the job kinds directly (sync → crawl → audit) or, more simply, run the MCP server and
send it `tools/call` requests over stdio. The MCP path (A) is the intended one; the script above
is just a quick credentials check.

## What "pass" looks like

Work down this list; anything that fails is a finding to report, not something to wave through.

- [ ] **Setup / auth:** `seo_audit_help` shows Search Console on; `list_properties` returns your
      property. (A 403 or empty list is a credentials/permission problem, not a smoke failure to
      ignore.)
- [ ] **Sync:** `check_sync_status` reaches `completed`; the job reports a non-zero row count, and
      the last synced date is within the last few days (Search Console lags ~2-3 days).
- [ ] **Crawl:** completes with a sensible page count for your site, `failed` low, and it reports
      what it skipped (robots-disallowed, off-host) rather than silently dropping pages.
- [ ] **Audit:** returns findings with finite, sorted priorities; the top findings make sense for
      your site; nothing is obviously absurd.
- [ ] **Dashboard:** opens; every tab renders; no console errors; phone width has no sideways
      scroll.

### Spot-check the numbers (these are what synthetic data could not fully confirm)

- [ ] **Average position** on the Summary and Search performance tabs is plausible for your site
      (impression-weighted), not wildly inflated by a few low-impression rows.
- [ ] **A finding's "payoff"/impact** is on the order of the page's real clicks, not tens of
      thousands of clicks for a page that earns hundreds - the stake is real clicks, not a
      curve-implied maximum.
- [ ] **Period-over-period:** if your synced history is shorter than ~8 weeks, the Summary reads
      "no prior" rather than "up from none" or a giant percentage.
- [ ] **Health score** reflects the findings - a site with critical/high issues on many pages is
      not shown as 100 / Excellent.
- [ ] **Missing data reads as missing** (a dash), never as zero (e.g. a position with no data).
- [ ] If you have more than one property (a Domain and a URL-prefix for the same host),
      **each keeps its own data**; one never shows the other's numbers.

## Report back

Note the property, the row/page/finding counts, the time each stage took, and anything on the
checklist that did not hold, with a screenshot of the dashboard tab where you saw it. Then delete
the scratch data dir (`rm -rf "$SAC_DATA_DIR"`). Don't paste credentials into the report.
