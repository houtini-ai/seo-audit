import { env, AutoTokenizer, AutoModelForSequenceClassification } from '@huggingface/transformers';
import { homedir } from 'node:os';
import path from 'node:path';

// Cross-encoder reranker (ms-marco-MiniLM-L-6-v2) run locally via transformers.js / ONNX — pure Node,
// no Python. It SCORES (query, passage) relevance; it does not generate text, so it cannot hallucinate.
// Model is downloaded once from the HF hub and cached on disk (persists across npm reinstalls).
env.cacheDir = path.join(homedir(), '.cache', 'seo-audit-console-models');
env.allowLocalModels = false;

const MODEL = 'Xenova/ms-marco-MiniLM-L-6-v2';
type Loaded = { tokenizer: any; model: any };
let loading: Promise<Loaded> | null = null;

/** Lazy singleton — first call downloads (~25MB) + warms the model; later calls reuse it. */
function load(): Promise<Loaded> {
  if (!loading) {
    loading = (async () => ({
      tokenizer: await AutoTokenizer.from_pretrained(MODEL),
      model: await AutoModelForSequenceClassification.from_pretrained(MODEL),
    }))();
  }
  return loading;
}

/** Relevance logits for one query against many passages (batched). Higher = more relevant. */
export async function scorePassages(query: string, passages: string[]): Promise<number[]> {
  if (!passages.length || !query.trim()) return [];
  const { tokenizer, model } = await load();
  const out: number[] = [];
  const BATCH = 16; // bound peak memory
  for (let i = 0; i < passages.length; i += BATCH) {
    const batch = passages.slice(i, i + BATCH);
    const inputs = tokenizer(Array(batch.length).fill(query), { text_pair: batch, padding: true, truncation: true });
    const { logits } = await model(inputs);
    for (const row of logits.tolist() as number[][]) out.push(row[0]);
  }
  return out;
}

/** The single best passage's score + its index — the "max-passage" relevance of a doc to a query. */
export async function maxPassageScore(query: string, passages: string[]): Promise<{ max: number; index: number }> {
  const scores = await scorePassages(query, passages);
  let max = -Infinity, index = -1;
  scores.forEach((v, i) => { if (v > max) { max = v; index = i; } });
  return { max, index };
}
