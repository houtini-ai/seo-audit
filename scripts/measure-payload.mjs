import fs from 'node:fs';
const d = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const total = JSON.stringify(d).length;
console.log('TOTAL chars:', total);
const rows = Object.entries(d).map(([k, v]) => {
  const s = JSON.stringify(v).length;
  const n = Array.isArray(v) ? v.length : (v && typeof v === 'object' ? Object.keys(v).length : '');
  return { key: k, chars: s, pct: Math.round((s / total) * 100), n };
}).sort((a, b) => b.chars - a.chars);
for (const r of rows) console.log(`${String(r.pct).padStart(3)}%  ${String(r.chars).padStart(7)}  ${r.key} (${r.n})`);
// findings breakdown
if (d.findings) {
  console.log('\nfindings sub-sizes:');
  for (const [k, v] of Object.entries(d.findings)) console.log(`   ${String(JSON.stringify(v).length).padStart(7)}  findings.${k} (${Array.isArray(v) ? v.length : ''})`);
}
