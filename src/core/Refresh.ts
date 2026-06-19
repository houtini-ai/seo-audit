import { GscSync } from './GscSync.js';
import { Crawler } from './Crawler.js';
import { UrlInspector } from './UrlInspector.js';

export interface RefreshOptions {
  gsc?: boolean;       // sync GSC history (default true)
  crawl?: boolean;     // crawl the site (default true)
  inspect?: boolean;   // GSC URL Inspection pass (default true)
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
          { startDate: opts.startDate ?? isoDaysAgo(90), endDate: opts.endDate ?? isoDaysAgo(0) },
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
        out.inspect = await this.inspector.run(siteUrl, { limit: opts.inspectLimit }, p => update({ phase: 'inspect', ...p }), signal);
      }
    }

    update({ phase: 'done' });
    return out;
  }
}
