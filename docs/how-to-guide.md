# How to run a technical SEO audit with SEO Audit Console

This guide walks you through your first audit, start to finish, as a normal conversation with Claude. No code, no spreadsheets. By the end you'll have a prioritised list of what to fix, the fixes themselves, and a dashboard you can share. Then we'll go beyond the basics - finding new pages worth creating, checking your content against AI search, and keeping watch for changes.

SEO Audit Console is an MCP server (Model Context Protocol - the way Claude talks to outside tools). It reads your own Google Search Console data, crawls your site, and tells you which handful of things to fix this week, why, and how.

## What you'll be able to do

- See your biggest SEO opportunities ranked by likely payoff, not by a generic severity score.
- Get the actual fix for the top issues (a redirect rule, a block of structured data, a list of pages to link from) ready to paste.
- Spot pages where Google shows you but nobody clicks - and rewrite them.
- Find new pages worth creating, backed by real search demand you're not yet satisfying.
- Check whether your content actually answers the queries it ranks for - the way AI search reads it.
- Open a shareable dashboard, or export a report for a client.
- Check what changed on your site since last time.

## Before you start

You'll need:

- **Claude Desktop**, with SEO Audit Console installed and connected. If it isn't set up yet, follow the [README](../README.md) first - it's a one-time, ten-minute job.
- **A Google Search Console property you own** (for example `sc-domain:yoursite.com`). The tool only works on sites you control.
- **About 15 minutes** for your first run. A big site's first crawl can take a few minutes on its own, but you don't have to watch it.

Throughout this guide, swap `yoursite.com` for your real domain.

> One thing worth knowing before you start: everything below is just a prompt. There's no interface to learn. If you forget any of it, ask *"run seo_audit_help"* and you'll get the full menu with examples.

## Step 1: Check it's connected

In a new Claude chat, type:

> list properties

You should see a list of the Search Console properties Claude can reach. If yours is there, you're ready. If the list is empty or you get an error, jump to [If something goes wrong](#if-something-goes-wrong).

> 📸 **Screenshot:** the chat showing your property in the returned list.

## Step 2: Pull your data

Now bring in your Search Console history and crawl the site:

> Refresh sc-domain:yoursite.com

This runs four things in order: it syncs your Search Console history, crawls your pages politely (it respects your `robots.txt` and never downloads images), checks how Google has indexed them, and works out which pages hold the most internal link value. You'll see a live progress panel as it goes.

The first sync pulls your whole history, so it's the slow one. Every refresh after that only fetches what's new - usually seconds, not minutes. On a large site the crawl is the slow part, so feel free to go and make a coffee.

> 📸 **Screenshot:** the progress panel partway through, showing the crawl count climbing.

## Step 3: Run your first audit

Once the refresh has finished, ask:

> Run an SEO audit on yoursite.com

You'll get a report with the top opportunities first. Each one tells you three things: the traffic at stake, the fix, and the evidence behind it. Want the softer, judgement-based findings too (things like search-intent mismatches and weak answer passages)? Ask for them:

> Run an SEO audit on yoursite.com and include the judgement findings

> 📸 **Screenshot:** the top of the audit report, showing the first few ranked findings.

## Step 4: Read the top of the list

The list is sorted by **expected clicks per developer-hour**. In plain terms: how many clicks a fix is likely to win, divided by how long it takes to do. A small change that could recover thousands of clicks sits above a fiddly change that might recover a few - even if the fiddly one touches more pages.

So you can work straight down the list with confidence that the top items are the best use of your time. A typical top five mixes quick wins (a title rewrite on a page that ranks well but gets few clicks) with genuine problems (a broken internal link leaking value from your homepage).

Curious about one issue in particular? You can pull any single check with its full evidence:

> Show me every page with a duplicate title on yoursite.com

or ask *"list the checks"* to see the whole catalogue - there are over 80.

> 📸 **Screenshot:** one finding expanded, with the traffic-at-stake figure and the evidence visible.

## Step 5: Get a paste-ready fix

Pick an item from the list and ask for the fix. For example:

> Generate the fix for the broken link on /old-page

or

> Write the Product structured data for /widgets

You'll get back something you can hand straight to a developer or paste in yourself - a redirect rule (in `.htaccess`, nginx or Next.js flavour, whichever you use), a complete block of structured data built from your own page, or a ranked list of your strongest pages to add internal links from. The tool never changes your site; it only gives you the artifact to apply.

> 📸 **Screenshot:** a generated fix, for example a 301 redirect rule.

## Step 6: See it as a dashboard

If you'd rather look than read:

> Show me the dashboard for yoursite.com

This opens an interactive dashboard right in the chat - your clicks and rankings over time, your top pages and queries, the findings as a chart, and my favourite: a scatter of internal link value against actual traffic, which shows you at a glance where your site's structure and your site's reality disagree.

> 📸 **Screenshot:** the dashboard open in the chat.

## Step 7: Find new pages worth creating

The audit fixes what you have. This finds what you're missing:

> Suggest new pages for yoursite.com

It looks for search demand you don't yet satisfy - real queries from your Search Console data where you show up on page two or lower and no single page of yours owns the topic - and proposes pages to cover them. It won't suggest a page you already have, and it tells you which existing page to link each new one from.

While you're thinking about structure, this one's useful too:

> List the page templates on yoursite.com

It groups your pages into templates (product pages, blog posts, category pages and so on). Why care? Because most technical issues live at the template level - fix the template once and you've fixed every page built from it.

## Step 8: Check your content against AI search

This is the newer frontier, and in my experience it's where the surprising findings come from. Search - Google's AI results, ChatGPT, Perplexity - increasingly works by pulling the passage that best answers a question. So the question worth asking is: does any passage on your page actually answer the query you rank for?

> Score the passages on yoursite.com

The first run downloads a small scoring model (about 25MB, one time, runs entirely on your machine - your content goes nowhere). It then reads each ranking page against its top query and flags pages that rank on a topic they never densely answer. A product listing ranking for "how to choose a racing wheel" with no buying advice on it, say. Those pages are your rewrite list - run the audit again with judgement findings included and they'll appear there, prioritised with everything else.

And when you're ready to fix one, you don't have to start from a blank page:

> Draft the missing content for /sim-racing-wheels

Claude gets a grounded brief built from the page itself - what the query needs, how the page already writes, and which existing passages contain the facts - and drafts the missing answer in your site's voice. It's told to invent nothing, so what comes back is a starting draft you edit, not fiction you fact-check.

And for the bigger picture - is your site ready for AI *agents* at all:

> Check agent readiness for yoursite.com

You'll get a 0-100 score across discoverability, content, bot access and capabilities (`llms.txt`, `agents.md`, AI-bot rules in robots.txt and so on), with copy-paste fixes for anything missing.

## Step 9: Keyword research (optional - needs DataForSEO)

Everything so far used only your own Search Console data. If you've connected a DataForSEO account (see the README - it's optional and pay-as-you-go), you can go outward too:

> What's the search volume for "standing desk"? · Give me related terms · Classify the intent of these queries

And competitively:

> Who are the competitors for yoursite.com? · What do they rank for that I don't?

That last one is the content gap - queries your competitors rank for where you don't appear at all. Combined with Step 7, it's a fairly complete picture of what to write next: demand you're near (suggest_pages) plus demand you're missing entirely (the gap).

You can also pull your backlink profile - which usefully checks each linked page is still alive, because a backlink pointing at a 404 is value you've already earned and are throwing away:

> Pull the backlinks for yoursite.com

## Step 10: Share the report

To send the audit to someone, or keep a copy:

> Export the report for yoursite.com

You'll get a single, self-contained HTML file. Open it in any browser or send it on - the person you send it to needs nothing installed.

> 📸 **Screenshot:** the exported report open in a browser.

## Keep an eye on changes (for later)

Once you've run a refresh on two different days, you can ask what changed:

> Detect changes on yoursite.com

It compares your two most recent crawls and flags anything that moved - a page that started returning "not found", a title that changed, a canonical tag that flipped, structured data that disappeared. The serious changes are marked clearly so you can act on the ones that matter. This is how you catch a problem within a day instead of finding out weeks later in your traffic.

My suggested routine, for what it's worth: refresh weekly, detect changes right after, run the full audit monthly, and re-run it after any fix goes live to watch the finding drop off the list. That last part is oddly satisfying.

## If something goes wrong

- **"list properties" is empty or errors.** Claude isn't connected to the tool yet, or the service account hasn't been added to your property. Check the setup steps in the [README](../README.md), then fully restart Claude Desktop (quit it from the system tray, not just close the window).
- **The audit says there's no data.** Run the refresh in Step 2 first, and let it finish before you run the audit.
- **A large site feels slow.** That's the crawl, and it's normal. It backs off when your server is busy, so it stays gentle. You can carry on once the progress panel says it's done.
- **A keyword or backlink tool says it needs credentials.** Those are the optional DataForSEO tools - everything in Steps 1-8 works without them. The backlinks tool also needs the Backlinks subscription specifically, which is separate from DataForSEO's other APIs; the tool will tell you if that's the issue.

## What to do next

Fix your top three items, then run the audit again to watch them drop off the list. If you ever want the full menu of what the tool can do, just ask:

> run seo_audit_help

That lists every feature with an example you can copy.
