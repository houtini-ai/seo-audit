import type Database from 'better-sqlite3';

/**
 * SERP-feature footprint - "how much of my market is being eaten by SERP features?"
 *
 * Built from ONE cached DataForSEO Labs ranked_keywords pull (top-down, never SERP loops):
 * each row carries keyword_data.serp_info.serp_item_types (the features PRESENT on that
 * keyword's SERP) plus our rank. Aggregated volume-weighted, split by whether we rank
 * page 1 on that keyword.
 *
 * Honesty: feature PRESENCE is deterministic (D - it's in the Labs index). Whether the
 * feature helps or hurts US is a judgement proxy (N) - "we rank page 1" is the nearest
 * cheap signal to ownership; true feature ownership needs per-keyword SERP calls.
 */

export interface FootprintRow {
  feature: string;          // raw serp_item_types value, e.g. 'ai_overview'
  label: string;            // human label, e.g. 'AI Overview'
  keywords: number;         // keywords in the sample whose SERP shows the feature
  volume: number;           // total monthly search volume of those keywords
  volumeSharePct: number;   // volume as % of the whole sample's volume
  page1Keywords: number;    // of those, keywords where WE rank in the top 10
  page1Volume: number;
  page1SharePct: number;    // page1Volume as % of the feature's volume
}

export interface SerpFootprint {
  target: string;
  location: string | null;
  sampleKeywords: number;
  sampleVolume: number;
  features: FootprintRow[];
  fetchedAt?: string;
}

const FEATURE_LABELS: Record<string, string> = {
  ai_overview: 'AI Overview',
  featured_snippet: 'Featured snippet',
  people_also_ask: 'People also ask',
  local_pack: 'Local pack',
  shopping: 'Shopping',
  popular_products: 'Popular products',
  video: 'Video',
  images: 'Images',
  knowledge_graph: 'Knowledge panel',
  top_stories: 'Top stories',
  related_searches: 'Related searches',
  people_also_search: 'People also search for',
  organic: 'Organic results',
  paid: 'Paid ads',
  carousel: 'Carousel',
  map: 'Map',
  twitter: 'X (Twitter)',
  discussions_and_forums: 'Discussions & forums',
  short_videos: 'Short videos',
  refine_products: 'Product refinements',
  found_on_web: 'Found on the web',
  perspectives: 'Perspectives',
  product_considerations: 'Product considerations',
  ai_mode: 'AI Mode',
};

// Ubiquitous furniture that says nothing about the market - excluded from the chart.
const NOISE = new Set(['organic', 'related_searches', 'people_also_search', 'paid', 'images']);

export interface SampleKeyword {
  keyword: string;
  position: number | null;
  searchVolume: number | null;
  serpFeatures: string[] | null;
}

export function computeSerpFootprint(target: string, location: string | null, sample: SampleKeyword[]): SerpFootprint {
  const totVolume = sample.reduce((s, k) => s + (k.searchVolume ?? 0), 0);
  const byFeature = new Map<string, { keywords: number; volume: number; p1k: number; p1v: number }>();
  for (const k of sample) {
    const vol = k.searchVolume ?? 0;
    const page1 = k.position != null && k.position <= 10;
    for (const f of k.serpFeatures ?? []) {
      const b = byFeature.get(f) ?? { keywords: 0, volume: 0, p1k: 0, p1v: 0 };
      b.keywords++; b.volume += vol;
      if (page1) { b.p1k++; b.p1v += vol; }
      byFeature.set(f, b);
    }
  }
  const features: FootprintRow[] = [...byFeature.entries()]
    .filter(([f]) => !NOISE.has(f))
    .map(([f, b]) => ({
      feature: f,
      label: FEATURE_LABELS[f] ?? f.replace(/_/g, ' '),
      keywords: b.keywords,
      volume: Math.round(b.volume),
      volumeSharePct: totVolume ? Math.round((b.volume / totVolume) * 1000) / 10 : 0,
      page1Keywords: b.p1k,
      page1Volume: Math.round(b.p1v),
      page1SharePct: b.volume ? Math.round((b.p1v / b.volume) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 12);
  return { target, location, sampleKeywords: sample.length, sampleVolume: Math.round(totVolume), features };
}

export function ensureFootprintTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS serp_footprint (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target TEXT NOT NULL,
      location TEXT,
      sample_keywords INTEGER NOT NULL,
      sample_volume REAL NOT NULL,
      features TEXT NOT NULL,          -- JSON FootprintRow[]
      fetched_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

export function persistSerpFootprint(db: Database.Database, fp: SerpFootprint): void {
  ensureFootprintTable(db);
  db.prepare(`INSERT INTO serp_footprint (target, location, sample_keywords, sample_volume, features) VALUES (?, ?, ?, ?, ?)`)
    .run(fp.target, fp.location, fp.sampleKeywords, fp.sampleVolume, JSON.stringify(fp.features));
}

export function latestSerpFootprint(db: Database.Database): SerpFootprint | null {
  ensureFootprintTable(db);
  const row = db.prepare(`SELECT target, location, sample_keywords, sample_volume, features, fetched_at FROM serp_footprint ORDER BY id DESC LIMIT 1`).get() as
    | { target: string; location: string | null; sample_keywords: number; sample_volume: number; features: string; fetched_at: string } | undefined;
  if (!row) return null;
  try {
    return {
      target: row.target,
      location: row.location,
      sampleKeywords: row.sample_keywords,
      sampleVolume: row.sample_volume,
      features: JSON.parse(row.features) as FootprintRow[],
      fetchedAt: row.fetched_at,
    };
  } catch { return null; }
}
