// Probe a saved dashboard JSON payload. Usage: node scripts/probe-dash-json.mjs <file>
import fs from 'node:fs';
const d = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
console.log('top keys:', Object.keys(d).join(', '));
const len = k => Array.isArray(d[k]) ? d[k].length : (d[k] == null ? 'null' : typeof d[k]);
for (const k of ['rankHistory', 'rankTrend', 'topKeywords', 'rankingDistribution', 'strikingDistance', 'deviceBreakdown', 'countryBreakdown', 'pagePerformance', 'keywordMovement', 'findings'])
  console.log(`  ${k}: ${len(k)}`);
console.log('\ndateRange:', JSON.stringify(d.dateRange));
console.log('dateAlignment:', JSON.stringify(d.dateAlignment));
console.log('summary.current:', JSON.stringify(d.summary?.current));
console.log('summary.prior:', JSON.stringify(d.summary?.prior));
console.log('rankHistory sample:', JSON.stringify(d.rankHistory?.slice(0, 2)));
console.log('rankingDistribution:', JSON.stringify(d.rankingDistribution));
console.log('rankTrend[0] & last:', JSON.stringify(d.rankTrend?.[0]), JSON.stringify(d.rankTrend?.at(-1)));
console.log('topKeywords[0]:', JSON.stringify(d.topKeywords?.[0]));
console.log('deviceBreakdown:', JSON.stringify(d.deviceBreakdown));
console.log('countryBreakdown[0..2]:', JSON.stringify(d.countryBreakdown?.slice?.(0, 3)));
console.log('pagePerformance[0]:', JSON.stringify(d.pagePerformance?.[0]));
console.log('keywordMovement[0]:', JSON.stringify(d.keywordMovement?.[0]));
console.log('findings[0]:', JSON.stringify(d.findings?.[0]));
