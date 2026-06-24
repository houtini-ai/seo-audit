// Proof: cross-encoder (ms-marco-MiniLM-L-6-v2) loads on Windows via transformers.js and scores a
// (query, passage) pair by RELEVANCE — a classifier, not a generator (cannot hallucinate).
import { AutoTokenizer, AutoModelForSequenceClassification } from '@huggingface/transformers';

const MODEL = 'Xenova/ms-marco-MiniLM-L-6-v2';
console.log('loading', MODEL, '…');
const t0 = Date.now();
const tokenizer = await AutoTokenizer.from_pretrained(MODEL);
const model = await AutoModelForSequenceClassification.from_pretrained(MODEL);
console.log('loaded in', Date.now() - t0, 'ms');

const query = 'how much torque does the simucube 2 pro have';
const passages = [
  'The Simucube 2 Pro is a 25 Nm direct drive wheelbase — the reference flagship everyone measures against.', // strong
  'Direct drive wheelbases connect the motor directly to the wheel, with no belts or gears.',                  // partial
  'Free UK delivery on all orders over £50. Returns accepted within 30 days of purchase.',                     // irrelevant
];
const ti = Date.now();
const inputs = tokenizer(Array(passages.length).fill(query), { text_pair: passages, padding: true, truncation: true });
const { logits } = await model(inputs);
const scores = logits.tolist().map(l => l[0]);
console.log('scored', passages.length, 'pairs in', Date.now() - ti, 'ms\n');
passages.map((p, i) => ({ s: scores[i], p })).sort((a, b) => b.s - a.s)
  .forEach(({ s, p }) => console.log(`  ${s.toFixed(2).padStart(7)}  ${p.slice(0, 64)}`));
