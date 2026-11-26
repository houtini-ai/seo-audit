import { GscSync, FULL_DIMENSIONS } from './GscSync.js';
import { Crawler } from './Crawler.js';
import { UrlInspector } from './UrlInspector.js';
import { RankTracker } from './RankTracker.js';
import type { CruxSync } from './CruxSync.js';

export interface RefreshOptions {
  gsc?: boolean;       // sync GSC history (default true)
  crawl?: boolean;     // crawl the site (default true)
  inspect?: boolean;   // GSC URL Inspection pass (default true)
  ranks?: boolean;     // DataForSEO over-time sequence (default true if available)
  crux?: boolean;      // CrUX field data (default true when CRUX_API_KEY is set; at most weekly per target)
  segments?: boolean;  // also sync device/country breakdowns (heavier; off by default — lite sync)
  full?: boolean;      // force a full re-pull of the GSC window (default: incremental resume)
  location?: string | number; // DataForSEO target location (name or code)
  startDate?: string;
  endDate?: string;
  maxPages?: number;
  inspectLimit?: number;
}

const isoDaysAgo = (d: number): string => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);

/**
 * Orchestrates a full property refresh — GSC sync → crawl → URL inspection — as a
 * single job. Each phase is skippable, so the same entry point serves both
 * "sync everything" and "just update X". Inspection runs last so it can target
 * top pages by freshly-synced clicks (else crawl in-degree).
 */
export class Refresh {
  constructor(
    private readonly sync: GscSync | null,
    private readonly crawler: Crawler,
    private readonly inspector: UrlInspector | null,
    private readonly rankTracker: RankTracker | null,
    private readonly cruxSync: CruxSync | null = null,
  ) {}

  async run(
    siteUrl: string,
    opts: RefreshOptions,
    update: (p: Record<string, unknown>) => void,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = { siteUrl, phases: [] as string[] };
    const phases = out.phases as string[];

    if (opts.gsc !== false) {
      if (!this.sync) { out.gscSkipped = 'no GSC credentials'; }
      else {
        update({ phase: 'gsc' });
        phases.push('gsc');
        out.gsc = await this.sync.run(
          siteUrl,
          {
            startDate: opts.startDate ?? isoDaysAgo(90),
            endDate: opts.endDate ?? isoDaysAgo(0),
            ...(opts.segments ? { dimensions: FULL_DIMENSIONS } : {}),
            ...(opts.full ? { fullResync: true } : {}),
          },
          p => update({ phase: 'gsc', ...p }),
          signal,
        );
      }
    }
    if (signal.aborted) return out;

    if (opts.crawl !== false) {
      update({ phase: 'crawl' });
      phases.push('crawl');
      out.crawl = await this.crawler.run(siteUrl, { maxPages: opts.maxPages }, p => update({ phase: 'crawl', ...p }), signal);
    }
    if (signal.aborted) return out;

    if (opts.inspect !== false) {
      if (!this.inspector) { out.inspectSkipped = 'no GSC credentials'; }
      else {
        update({ phase: 'inspect' });
        phases.push('inspect');
        // The inspector throws when nothing could be inspected (quota spent, no permission): reported
        // here, never fatal, so the phases after it still run.
        try {
          out.inspect = await this.inspector.run(siteUrl, { limit: opts.inspectLimit }, p => update({ phase: 'inspect', ...p }), signal);
        } catch (err) {
          out.inspectError = err instanceof Error ? err.message : String(err);
        }
      }
    }
    if (signal.aborted) return out;

    if (opts.ranks !== false) {
      if (!this.rankTracker) { out.ranksSkipped = 'no DataForSEO credentials'; }
      else {
        update({ phase: 'ranks' });
        phases.push('ranks');
        // Reported, never fatal (like CrUX below): GSC, the crawl and inspection are already written,
        // and an empty DataForSEO balance must not fail the refresh or skip the CrUX phase.
        try {
          out.ranks = await this.rankTracker.run(siteUrl, { location: opts.location }, p => update({ phase: 'ranks', ...p }), signal);
        } catch (err) {
          out.ranksError = err instanceof Error ? err.message : String(err);
        }
      }
    }
    if (signal.aborted) return out;

    // CrUX last: it reads the freshly synced GSC clicks to pick its top URLs. Its own re-ask
    // windows (7 days per target) keep a routine refresh to a handful of calls. A CrUX failure
    // is reported, never fatal: the rest of the refresh has already been written.
    if (opts.crux !== false) {
      if (!this.cruxSync) { out.cruxSkipped = 'no CRUX_API_KEY'; }
      else {
        update({ phase: 'crux' });
        phases.push('crux');
        try {
          out.crux = await this.cruxSync.run(siteUrl, {}, p => update({ phase: 'crux', ...p }), signal);
        } catch (err) {
          out.cruxError = err instanceof Error ? err.message : String(err);
        }
      }
    }

    update({ phase: 'done' });
    return out;
  }
}
