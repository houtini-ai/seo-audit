// date_from window for DataForSEO Labs historical endpoints (domain_visibility `months`).
// Without date_from the endpoint returns only 6 months, so months=24 silently gave 6.
//   node scripts/probe-dfs-datefrom.mjs   (after npm run build:server)
import { historicalDateFrom, HISTORICAL_MIN_DATE_FROM } from '../dist/core/DataForSeoClient.js';

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = got === want;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  got ${got}, want ${want}`}`);
  ok ? pass++ : fail++;
};
const oct = new Date(Date.UTC(2026, 9, 6, 15));

t('min is 2020-10-01', HISTORICAL_MIN_DATE_FROM, '2020-10-01');
t('12 months in Oct 2026 -> 2025-10-01', historicalDateFrom(12, oct), '2025-10-01');
t('24 months in Oct 2026 -> 2024-10-01', historicalDateFrom(24, oct), '2024-10-01');
t('1 month in Oct 2026 -> 2026-09-01', historicalDateFrom(1, oct), '2026-09-01');
t('crosses year boundary (Jan, 1 month) -> previous Dec', historicalDateFrom(1, new Date(Date.UTC(2026, 0, 15))), '2025-12-01');
t('first-of-month instant stays in that month', historicalDateFrom(6, new Date(Date.UTC(2026, 2, 1, 0, 0, 0))), '2025-09-01');
t('last-of-month instant stays in that month', historicalDateFrom(6, new Date(Date.UTC(2026, 2, 31, 23, 59, 59))), '2025-09-01');
t('clamped to the 2020-10-01 floor', historicalDateFrom(24, new Date(Date.UTC(2021, 5, 1))), '2020-10-01');
t('exactly at the floor', historicalDateFrom(12, new Date(Date.UTC(2021, 9, 1))), '2020-10-01');
t('0 / fractional treated as >= 1 whole month', historicalDateFrom(0, oct), '2026-09-01');
t('stable across the month (cache key)', historicalDateFrom(12, new Date(Date.UTC(2026, 9, 1))), historicalDateFrom(12, new Date(Date.UTC(2026, 9, 31, 23))));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
