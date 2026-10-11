// Fixture test for the semantic near-duplicate engine: local embeddings + cosine must rate two
// paraphrases of the same product as near-identical and a different product as clearly lower.
// First run downloads the ~25MB all-MiniLM model to the shared cache.
//   npm run build:server && node scripts/probe-neardup.mjs
import { embed, cosine } from '../dist/core/embeddings.js';

let pass = 0, fail = 0;
const ok = (name, cond, got) => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  got: ${got}`}`); };

const [a, b, c] = await embed([
  'Proval Nitrile Examination Gloves, powder-free, box of 100. Durable disposable gloves for medical and food handling.',
  'Proval Nitrile Exam Gloves - powder free, 100 per box. Tough disposable gloves for medical and food use.',
  'Easyroll 125mm urethane castor wheel, 230kg load rating, swivel plate mount for industrial trolleys.',
]);

ok('embedding dimension is 384', a.length === 384, a.length);
ok('vectors are L2-normalised (self-cosine ~= 1)', Math.abs(cosine(a, a) - 1) < 1e-3, cosine(a, a));

const dup = cosine(a, b);
const diff = cosine(a, c);
console.log(`  paraphrase cosine = ${dup.toFixed(3)} · different-product cosine = ${diff.toFixed(3)}`);
ok('paraphrase pair clears the 0.9 near-duplicate threshold', dup >= 0.9, dup.toFixed(3));
ok('different product is clearly lower (gap >= 0.15)', dup - diff >= 0.15, `${dup.toFixed(3)} vs ${diff.toFixed(3)}`);
ok('different product is below the threshold', diff < 0.9, diff.toFixed(3));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
