# SEO Recon: why a page is losing, and what to do about it

Most audit tools tell you *what* is wrong on a page. Recon answers a harder question: **why is this page losing, and is that even a content problem?** It takes your declining pages, pulls the live Google SERP for each, reads whether the **AI Overview** cites you, checks what your own crawl says about the URL, and returns a verdict with the honest bit attached - because *"you rank but the AI Overview won't quote you"* is a data-accuracy problem, not a reason to rewrite the page.

It's the most data-intensive thing this MCP does, so it's on-demand and it costs a little (live SERP calls). You point it at a property, it does the legwork, and you get back a prioritised to-do board you can annotate and re-measure after you ship the fix.

> **Needs a DataForSEO key** (the live SERP is a paid call, ~$0.004 per page). The competitor-fetching step also uses Firecrawl and Supadata if you have them - but it degrades gracefully without. See [getting-started.md](getting-started.md#environment-variables).

## The one prompt

> Run content recon on simracingcockpit.gg

That's it. Recon auto-selects your worst declining / striking-distance pages (high impressions, currently sitting at position 3-15, one top query each) and works through them. It's an **async job** - it returns a job id immediately and you poll it, because each page is a live page-fetch plus a serialised SERP call. On a handful of pages that's under a minute; on a big batch, longer.

You can also aim it:

> Run content recon on the top 10 pages for simracingcockpit.gg, location United Kingdom

> Run content recon on these two URLs: simracingcockpit.gg/best-sim-racing-wheels and simracingcockpit.gg/gaming-monitors-guide

Pass `location` to match where your impressions actually come from - organic rank is location-sensitive, and a UK site read from a US data centre gives you the wrong SERP. Pass explicit `urls` to skip auto-selection and interrogate exactly the pages you care about.

## How it works

For each target page, recon does four things and reconciles them:

1. **Fetches your live page** with the crawler's extractor - headings, JSON-LD types, whether it carries Product/Review markup, its `dateModified`.
2. **Pulls the live Google SERP** for the page's top query (DataForSEO SERP-advanced, depth 20 organic). From that it reads **where you actually rank in organic**, **whether the AI Overview cites you and who it does cite**, and **how much of the SERP is video** (a format signal).
3. **Checks the crawl's reality.** Search Console keeps reporting impressions for a URL long after it's been canonicalised away or set `noindex`. If the crawl says the page can't rank, that overrides the SERP/GSC read - no point planning content for a page Google won't serve.
4. **Judges cannibalisation across the whole query cluster**, not one query at a time - because the real overlap hides across the topic family under different phrasings.

Then it classifies the page with the **organic-rank × AI-Overview-citation matrix**.

### The verdict matrix

This is the heart of it. Where you rank organically, crossed with whether the AI Overview quotes you:

| Verdict | What it means | The move |
|---|---|---|
| **defend-and-deepen** | Strong organic (top 5) and the AIO already cites you, or there's no AIO | You're winning. Deepen to become the primary source. |
| **accuracy-or-freshness** | You rank top 5 organically but the AIO does **not** cite you | The sharpest, most actionable class. Google ranks you but won't *quote* you - a data-accuracy or freshness signal. Make the facts current, correct and marked up so they're machine-liftable. Not a rewrite. |
| **consolidate-weak-page** | The AIO cites you but your organic rank is weak | You've got a quotable nugget on an under-powered page. Consolidate and strengthen it. |
| **competitive-gap** | Not cited, weak or absent from organic | A full coverage gap. Run the deep competitor diff. |
| **page-cannot-rank** | The crawl says the URL is noindex / canonicalised away | Its GSC history is legacy - the SERP read belongs to another page. Resolve the duplicate first; content work here is wasted. |

The `accuracy-or-freshness` verdict is the one you can't get anywhere else, and it's usually the highest-value finding recon produces: a page that already earns the ranking but is being passed over by the AI answer, which is a small, surgical fix rather than a content project.

### The honesty rules (baked in)

Recon will not claim a measurement it didn't take. This matters because a confident-but-wrong verdict is worse than no verdict:

- **Every Search Console figure carries its 28-day window** - a 28-day number read against an all-time baseline looks exactly like a decline when it isn't.
- **`organicRank: null` means "absent from the top 20 organic results"** - never a made-up position. Rank 11 and rank 80 both come back as null, and the phrasing says so.
- **An AI Overview whose citations couldn't be resolved reports `aioCitesUs: null` (UNKNOWN)**, never "not cited". Google loads some AI Overviews asynchronously; recon requests the async load, but if it still doesn't resolve, that's honestly reported as unknown rather than manufactured into an accuracy problem.

## The data you get back

Per page, the job result gives you:

- **The verdict and its note** - the plain-English *why*, e.g. *"You rank organic #4 but the AI Overview does NOT cite you (checked 7 references) - a data-accuracy or freshness signal."*
- **Your organic rank** (live), your **GSC average position** and whether it **slipped** vs the prior 28 days, and your **impressions** (with the window).
- **AI Overview state** - present or not, cites you or not (or unknown), and whether it was loaded asynchronously.
- **Video-pack presence** - because if the SERP is video-led, some of your click loss is format, not content.
- **The opportunity** - not raw impressions, but *impressions × the CTR gap between where you rank and a realistic target, damped by the verdict*. So a broken page with headroom outranks a #4 defend-and-deepen page that's already near its ceiling, which is roughly the right working order. It names its position source (live SERP vs GSC average) so you know what the estimate is built on.
- **The cannibalisation cluster** - how many of your URLs compete across the topic, and on how many queries they actually collide.
- **The competitor set** - the organic results ranked above you, the AI Overview's cited domains, and the ranking videos. This is your diff list.
- **A readable markdown summary** of the whole run.

### Optional: pull the competitors as content

Add `scrapeCompetitors: true` and recon also **fetches the ranking competitors as text**, routed by host so each source is fetched the right way:

- **YouTube / video** → Supadata transcript (needs `SUPADATA_API_KEY`) - and video usually *is* what wins these SERPs.
- **Reddit** → its `.json` endpoint.
- **Everything else** → Firecrawl (needs `FIRECRAWL_API_KEY`), with a free browser-profile HTTP fetch as fallback.

`competitorLimit` (default 5) caps how many are fetched, and **whatever isn't fetched is listed as skipped, never dropped silently** - so you always know the full competitor set even if you only pulled the top five. Cloudflare-challenge sites (PCMag and friends) still can't be fetched from a server and come back as a per-URL error - the SERP still tells you they rank; if one matters, paste its copy in and it'll get diffed alongside the rest.

## The to-do ledger: recon → research → track

Recon doesn't just report - it seeds a **trackable to-do board** per page, and there's a loop:

1. **`recon_targets`** classifies each page and writes the **deterministic** to-dos it can prove without judgement - missing item-level schema on a commercial page, a stale `dateModified`, a cannibalisation cluster to consolidate, a format gap where the SERP wants video. Each to-do snapshots the page's rank/citation **baseline** so the fix's effect is measurable later.

2. **`save_recon_todo`** is how the *research* writeback happens. After you (or Claude) diff the fetched competitors and video transcripts against your own content, you write the **judgement** to-dos back - the content gaps and originality findings - against the page. They sort on the same opportunity scale as the deterministic ones.

3. **`recon_todos`** is the board itself. With no id, it lists the to-dos grouped by page with each page's verdict - the pick-a-page-to-work-on surface, and the hand-off to a content workflow. With an id, you update one to-do: move its status (`open → researching → drafted → shipped → dismissed`) and append dated annotations as you work.

   The payoff: on `status: shipped` with `remeasure: true`, recon **re-fetches the SERP and records the outcome** - so you can see, in black and white, whether the fix moved you from *AIO-uncited* to *cited*, or up the organic ranks. That's the before/after the whole exercise was built to prove.

> Show me the recon to-dos for simracingcockpit.gg

> Mark recon to-do #14 as shipped and re-measure

## What it costs

The SERP call is ~$0.004 per page, plus a small refundable surcharge for loading async AI Overviews. A 10-page recon is a few cents. The competitor-fetching step's cost depends on your Firecrawl / Supadata plans; without those keys, recon still runs on the SERP + your own page and simply doesn't pull competitor bodies. Every DataForSEO response is cached, so re-running within the cache window is free.

## When to reach for it

Recon is the deep dive, not the daily driver. Run the audit and the dashboard for the broad picture; reach for recon when you've got a **specific page that's slipping** and you want to know whether the answer is *refresh the facts*, *consolidate a duplicate*, *close a coverage gap*, or *nothing - it's a video SERP and that's format*. It's the difference between "this page is down 12%" and "this page is down because the AI Overview stopped quoting it in March, here's the fix, and here's how we'll know it worked."

See also: [competitive.md](competitive.md) for the wider DataForSEO workflows recon sits inside, and [tools.md](tools.md) for the full input reference on `recon_targets`, `save_recon_todo` and `recon_todos`.
