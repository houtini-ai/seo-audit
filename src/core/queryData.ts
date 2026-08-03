/**
 * queryData — the composition-layer multiplier: aggregate IN the database, return
 * answers, not rows. Read-only (SQLite opened readonly, SELECTs only). Every
 * identifier (table, column) is validated against the table's actual columns via
 * PRAGMA table_info; every VALUE travels as a bound parameter — nothing user-supplied
 * is ever interpolated into SQL.
 */
import Database from 'better-sqlite3';

export const QUERYABLE_TABLES = [
  'pages', 'links', 'search_analytics', 'url_inspection', 'sitemap_urls',
  'findings', 'image_assets', 'page_backlinks',
] as const;
export type QueryTable = (typeof QUERYABLE_TABLES)[number];

export const FILTER_OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'like', 'in'] as const;
export type FilterOp = (typeof FILTER_OPS)[number];
const OP_SQL: Record<Exclude<FilterOp, 'in'>, string> = {
  eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=', like: 'LIKE',
};

export const METRIC_FNS = ['sum', 'avg', 'min', 'max'] as const;
export type MetricFn = (typeof METRIC_FNS)[number];

export interface QueryFilter { column: string; op: FilterOp; value: unknown }
export interface QueryMetric { fn: MetricFn; column: string }

export interface QueryDataInput {
  table: QueryTable;
  mode?: 'aggregate' | 'rows';
  groupBy?: string[];
  metrics?: QueryMetric[];
  filters?: QueryFilter[];
  orderBy?: string;
  orderDir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
  columns?: string[];
}

export interface QueryDataResult {
  markdown: string;
  structured: Record<string, unknown>;
}

/** Sensible default columns per table for rows mode — the fat columns (body_chunks,
 *  json_ld, evidence…) stay out unless explicitly requested. */
const DEFAULT_ROW_COLUMNS: Record<QueryTable, string[]> = {
  pages: ['url', 'status_code', 'indexable', 'title', 'h1', 'word_count', 'ipr', 'click_depth', 'inlink_count', 'canonical_key'],
  links: ['source_key', 'target_key', 'anchor_text', 'is_internal', 'placement', 'rel'],
  search_analytics: ['date', 'query', 'page_key', 'clicks', 'impressions', 'ctr', 'position'],
  url_inspection: ['url_key', 'verdict', 'coverage_state', 'google_canonical', 'user_canonical', 'last_crawl_time'],
  sitemap_urls: ['url', 'lastmod'],
  findings: ['id', 'run_id', 'check_id', 'category', 'severity', 'url_key', 'priority'],
  image_assets: ['url', 'bytes', 'status', 'content_type', 'used_on'],
  page_backlinks: ['url', 'backlinks', 'referring_domains', 'dofollow', 'status_code'],
};

const CELL_CAP = 120;

/** Truncate a cell value at CELL_CAP chars — always loud (trailing …). */
export function truncateCell(v: unknown): unknown {
  if (typeof v !== 'string' || v.length <= CELL_CAP) return v;
  return v.slice(0, CELL_CAP) + '…';
}

const mdCell = (v: unknown): string => {
  if (v == null) return '—';
  return String(truncateCell(v)).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
};

const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

const NUMERIC_AFFINITY = /INT|REAL|FLOA|DOUB|NUM|DECI/i;

export function runQueryData(dbPath: string, input: QueryDataInput): QueryDataResult {
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return {
      markdown: `No database at ${dbPath} — run refresh_property (or start_crawl / sync_gsc) first.`,
      structured: { error: 'no_database', dbPath },
    };
  }
  try {
    return execute(db, input);
  } finally {
    db.close();
  }
}

function execute(db: Database.Database, input: QueryDataInput): QueryDataResult {
  const table = input.table;
  if (!QUERYABLE_TABLES.includes(table)) throw new Error(`Unknown table: ${table}`);

  // The column whitelist IS the table's real columns (PRAGMA table_info) — anything
  // not in it is hard-rejected. Numeric columns (INTEGER/REAL affinity) additionally
  // qualify for sum/avg/min/max.
  const info = db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as { name: string; type: string }[];
  if (!info.length) {
    return { markdown: `Table ${table} has no columns in this database (nothing synced yet?).`, structured: { error: 'empty_table_schema', table } };
  }
  const allCols = new Set(info.map(c => c.name));
  const numericCols = new Set(info.filter(c => NUMERIC_AFFINITY.test(c.type ?? '')).map(c => c.name));
  const requireCol = (name: string, context: string): string => {
    if (!allCols.has(name)) throw new Error(`Unknown column in ${context}: "${name}". Columns on ${table}: ${[...allCols].join(', ')}`);
    return name;
  };
  const requireNumeric = (name: string, context: string): string => {
    requireCol(name, context);
    if (!numericCols.has(name)) throw new Error(`Column "${name}" is not numeric — ${context} needs one of: ${[...numericCols].join(', ')}`);
    return name;
  };

  // WHERE — column names from the whitelist, values ALWAYS as bound parameters.
  const whereParts: string[] = [];
  const params: unknown[] = [];
  for (const f of input.filters ?? []) {
    const col = quoteIdent(requireCol(f.column, 'filters'));
    if (f.op === 'in') {
      if (!Array.isArray(f.value) || !f.value.length) throw new Error(`Filter op "in" on ${f.column} needs a non-empty array value.`);
      if (f.value.length > 100) throw new Error(`Filter op "in" on ${f.column}: max 100 values.`);
      whereParts.push(`${col} IN (${f.value.map(() => '?').join(',')})`);
      params.push(...f.value);
    } else if (f.value === null && (f.op === 'eq' || f.op === 'ne')) {
      whereParts.push(`${col} IS ${f.op === 'eq' ? '' : 'NOT '}NULL`);
    } else {
      if (f.value === null || Array.isArray(f.value) || typeof f.value === 'object') {
        throw new Error(`Filter op "${f.op}" on ${f.column} needs a scalar value.`);
      }
      whereParts.push(`${col} ${OP_SQL[f.op]} ?`);
      params.push(f.value);
    }
  }
  const where = whereParts.length ? ` WHERE ${whereParts.join(' AND ')}` : '';
  const from = `FROM ${quoteIdent(table)}${where}`;

  const mode = input.mode ?? 'aggregate';
  const orderDir = input.orderDir === 'asc' ? 'ASC' : 'DESC';

  // Total matching rows — both modes report it (the honest denominator).
  const rowsTotal = (db.prepare(`SELECT COUNT(*) n ${from}`).get(...params) as { n: number }).n;

  if (mode === 'aggregate') {
    const groupBy = (input.groupBy ?? []).map(c => requireCol(c, 'groupBy'));
    const metrics = (input.metrics ?? []).map(m => {
      if (!METRIC_FNS.includes(m.fn)) throw new Error(`Unknown metric fn: ${m.fn}`);
      return { fn: m.fn, column: requireNumeric(m.column, `metrics (${m.fn})`), alias: `${m.fn}_${m.column}` };
    });
    const sel = [
      ...groupBy.map(quoteIdent),
      'COUNT(*) AS count',
      ...metrics.map(m => `${m.fn.toUpperCase()}(${quoteIdent(m.column)}) AS ${quoteIdent(m.alias)}`),
    ].join(', ');
    const groupClause = groupBy.length ? ` GROUP BY ${groupBy.map(quoteIdent).join(', ')}` : '';
    // orderBy: a groupBy column, 'count', or a requested metric alias (e.g. sum_clicks).
    const orderable = new Set(['count', ...groupBy, ...metrics.map(m => m.alias)]);
    const orderCol = input.orderBy ?? 'count';
    if (!orderable.has(orderCol)) throw new Error(`orderBy "${orderCol}" must be one of: ${[...orderable].join(', ')}`);
    const limit = Math.min(Math.max(input.limit ?? 25, 1), 500);
    const sql = `SELECT ${sel} ${from}${groupClause} ORDER BY ${quoteIdent(orderCol)} ${orderDir} LIMIT ${limit}`;
    const groups = db.prepare(sql).all(...params) as Record<string, unknown>[];
    const groupsTotal = groupBy.length
      ? (db.prepare(`SELECT COUNT(*) n FROM (SELECT 1 ${from}${groupClause})`).get(...params) as { n: number }).n
      : 1;

    // Round avg to 2dp; attach SF-style percentages.
    const out = groups.map(g => {
      const row: Record<string, unknown> = {};
      for (const c of groupBy) row[c] = truncateCell(g[c]);
      const count = Number(g.count) || 0;
      row.count = count;
      row.pct = rowsTotal > 0 ? Math.round((count / rowsTotal) * 1000) / 10 : 0;
      for (const m of metrics) {
        const v = g[m.alias];
        row[m.alias] = m.fn === 'avg' && typeof v === 'number' ? Math.round(v * 100) / 100 : v;
      }
      return row;
    });

    const headerCols = [...groupBy, 'count', '%', ...metrics.map(m => m.alias)];
    const header = `| ${headerCols.join(' | ')} |\n|${headerCols.map(() => '---').join('|')}|`;
    const body = out.map(r =>
      `| ${[...groupBy.map(c => mdCell(r[c])), String(r.count), `${r.pct}%`, ...metrics.map(m => mdCell(r[m.alias]))].join(' | ')} |`,
    ).join('\n');
    const shownPct = rowsTotal > 0
      ? Math.round((out.reduce((s, r) => s + (r.count as number), 0) / rowsTotal) * 1000) / 10
      : 0;
    const totalLine = groupBy.length
      ? `Total: ${rowsTotal.toLocaleString('en-US')} rows across ${groupsTotal.toLocaleString('en-US')} groups — showing ${out.length}${groupsTotal > out.length ? ` (covering ${shownPct}% of rows; raise limit or add filters for the rest)` : ''}.`
      : `Total: ${rowsTotal.toLocaleString('en-US')} rows (no groupBy — single aggregate).`;
    const markdown = out.length ? `${header}\n${body}\n\n${totalLine}` : `No rows match. ${totalLine}`;
    return {
      markdown,
      structured: { table, mode, groupBy, metrics: metrics.map(({ fn, column }) => ({ fn, column })), groups: out, groupsTotal, groupsReturned: out.length, rowsTotal },
    };
  }

  // rows mode — token discipline: curated default columns, 120-char cells, loud paging footer.
  const cols = (input.columns?.length ? input.columns : DEFAULT_ROW_COLUMNS[table]).map(c => requireCol(c, 'columns'));
  const orderCol = input.orderBy ? requireCol(input.orderBy, 'orderBy') : null;
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 500);
  const offset = Math.max(input.offset ?? 0, 0);
  const sql = `SELECT ${cols.map(quoteIdent).join(', ')} ${from}${orderCol ? ` ORDER BY ${quoteIdent(orderCol)} ${orderDir}` : ''} LIMIT ${limit} OFFSET ${offset}`;
  const raw = db.prepare(sql).all(...params) as Record<string, unknown>[];
  let truncated = false;
  const rows = raw.map(r => {
    const o: Record<string, unknown> = {};
    for (const c of cols) {
      const t = truncateCell(r[c]);
      if (t !== r[c]) truncated = true;
      o[c] = t;
    }
    return o;
  });
  const first = rows.length ? offset + 1 : 0;
  const last = offset + rows.length;
  const nextOffset = last < rowsTotal ? last : null;
  const footer = `Showing ${first}–${last} of ${rowsTotal.toLocaleString('en-US')}${nextOffset != null ? `; next offset ${nextOffset}` : ' (end)'}.` +
    (truncated ? ` Cells over ${CELL_CAP} chars truncated (…) — use mode:aggregate or fewer columns for full values via SQL.` : '');
  const header = `| ${cols.join(' | ')} |\n|${cols.map(() => '---').join('|')}|`;
  const body = rows.map(r => `| ${cols.map(c => mdCell(r[c])).join(' | ')} |`).join('\n');
  const markdown = rows.length ? `${header}\n${body}\n\n${footer}` : `No rows match (${rowsTotal} total in ${table} for these filters).`;
  return {
    markdown,
    structured: { table, mode, columns: cols, rows, rowsReturned: rows.length, rowsTotal, offset, nextOffset, cellsTruncated: truncated },
  };
}
