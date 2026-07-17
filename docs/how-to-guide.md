# How to run a technical SEO audit with SEO Audit Console

This guide walks you through your first audit, start to finish, as a normal conversation with Claude. No code, no spreadsheets. By the end you'll have a prioritised list of what to fix, the fixes themselves, and a dashboard you can share.

SEO Audit Console is an MCP server (Model Context Protocol - the way Claude talks to outside tools). It reads your own Google Search Console data, crawls your site, and tells you which handful of things to fix this week, why, and how.

## What you'll be able to do

- See your biggest SEO opportunities ranked by likely payoff, not by a generic severity score.
- Get the actual fix for the top issues (a redirect rule, a block of structured data) ready to paste.
- Spot pages where Google shows you but nobody clicks - and rewrite them.
- Open a shareable dashboard, or export a report for a client.
- Check what changed on your site since last time.

## Before you start

You'll need:

- **Claude Desktop**, with SEO Audit Console installed and connected. If it isn't set up yet, follow the [README](../README.md) first - it's a one-time, ten-minute job.
- **A Google Search Console property you own** (for example `sc-domain:yoursite.com`). The tool only works on sites you control.
- **About 15 minutes** for your first run. A big site's first crawl can take a few minutes on its own, but you don't have to watch it.

Throughout this guide, swap `yoursite.com` for your real domain.

## Step 1: Check it's connected

In a new Claude chat, type:

> list properties

You should see a list of the Search Console properties Claude can reach. If yours is there, you're ready. If the list is empty or you get an error, jump to [If something goes wrong](#if-something-goes-wrong).

> 📸 **Screenshot:** the chat showing your property in the returned list.

## Step 2: Pull your data

Now bring in your Search Console history and crawl the site:

> Refresh sc-domain:yoursite.com

This runs four things in order: it syncs your Search Console history, crawls your pages politely (it respects your `robots.txt` and never downloads images), checks how Google has indexed them, and works out which pages hold the most internal link value. You'll see a live progress panel as it goes.

You only need to do this once per session. On a small site it's quick; on a large one the crawl is the slow part, so feel free to go and make a coffee.

> 📸 **Screenshot:** the progress panel partway through, showing the crawl count climbing.

## Step 3: Run your first audit

Once the refresh has finished, ask:

> Run an SEO audit on yoursite.com

You'll get a report with the top opportunities first. Each one tells you three things: the traffic at stake, the fix, and the evidence behind it. Want the softer, judgement-based findings too (things like search-intent mismatches)? Ask for them:

> Run an SEO audit on yoursite.com and include the judgement findings

> 📸 **Screenshot:** the top of the audit report, showing the first few ranked findings.

## Step 4: Read the top of the list

The list is sorted by **expected clicks per developer-hour**. In plain terms: how many clicks a fix is likely to win, divided by how long it takes to do. A small change that could recover thousands of clicks sits above a fiddly change that might recover a few - even if the fiddly one touches more pages.

So you can work straight down the list with confidence that the top items are the best use of your time. A typical top five mixes quick wins (a title rewrite on a page that ranks well but gets few clicks) with genuine problems (a broken internal link leaking value from your homepage).

> 📸 **Screenshot:** one finding expanded, with the traffic-at-stake figure and the evidence visible.

## Step 5: Get a paste-ready fix

Pick an item from the list and ask for the fix. For example:

> Generate the fix for the broken link on /old-page

or

> Write the Product structured data for /widgets

You'll get back something you can hand straight to a developer or paste in yourself - a redirect rule, or a complete block of structured data built from your own page. The tool never changes your site; it only gives you the artifact to apply.

> 📸 **Screenshot:** a generated fix, for example a 301 redirect rule.

## Step 6: See it as a dashboard

If you'd rather look than read:

> Show me the dashboard for yoursite.com

This opens an interactive dashboard right in the chat - your clicks and rankings over time, your top pages and queries, and the findings as a chart. It's the same data, easier to scan.

> 📸 **Screenshot:** the dashboard open in the chat.

## Step 7: Find new pages worth creating

The audit fixes what you have. This finds what you're missing:

> Suggest new pages for yoursite.com

It looks for search demand you don't yet satisfy - real queries from your Search Console data - and proposes pages to cover them. It won't suggest a page you already have.

## Step 8: Share the report

To send the audit to someone, or keep a copy:

> Export the report for yoursite.com

You'll get a single, self-contained HTML file. Open it in any browser or send it on - the person you send it to needs nothing installed.

> 📸 **Screenshot:** the exported report open in a browser.

## Keep an eye on changes (for later)

Once you've run a refresh on two different days, you can ask what changed:

> Detect changes on yoursite.com

It compares your two most recent crawls and flags anything that moved - a page that started returning "not found", a title that changed, a canonical tag that flipped, structured data that disappeared. The serious changes are marked clearly so you can act on the ones that matter. This is how you catch a problem within a day instead of finding out weeks later in your traffic.

## If something goes wrong

- **"list properties" is empty or errors.** Claude isn't connected to the tool yet, or the service account hasn't been added to your property. Check the setup steps in the [README](../README.md), then fully restart Claude Desktop (quit it from the system tray, not just close the window).
- **The audit says there's no data.** Run the refresh in Step 2 first, and let it finish before you run the audit.
- **A large site feels slow.** That's the crawl, and it's normal. It backs off when your server is busy, so it stays gentle. You can carry on once the progress panel says it's done.

## What to do next

Fix your top three items, then run the audit again to watch them drop off the list. If you ever want the full menu of what the tool can do, just ask:

> run seo_audit_help

That lists every feature with an example you can copy.

> **More to explore:** the audit already flags phrases you rank for but never mention in your copy, and you can ask *"check agent readiness for yoursite.com"* to score how ready your site is for AI agents (`llms.txt`, `agents.md`, AI-bot rules). Template-level structured-data opportunities are coming next — see the [README roadmap](../README.md#whats-coming).
