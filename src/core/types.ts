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
}

export type JobState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
