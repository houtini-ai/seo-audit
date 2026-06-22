export interface GscProperty {
  siteUrl: string;
  permissionLevel?: string;
}

export interface GscApiRow {
  keys?: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface FetchOptions {
  startDate: string;
  endDate: string;
  dimensions?: string[];
  rowLimit?: number;
  dataState?: string;
  searchType?: string;
  fullResync?: boolean; // ignore the incremental resume point and re-pull the whole window
}

export type JobState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
