import { env, pipeline } from '@huggingface/transformers';
import { homedir } from 'node:os';
import path from 'node:path';

// Sentence embeddings (all-MiniLM-L6-v2, 384-dim) run locally via transformers.js / ONNX — pure Node,
// no Python. A bi-encoder: it maps text → a vector so cosine similarity measures semantic closeness.
// It does not generate text. Model downloaded once from the HF hub and cached on disk (shared cache
// dir with the reranker; persists across npm reinstalls).
env.cacheDir = path.join(homedir(), '.cache', 'seo-audit-console-models');
env.allowLocalModels = false;

const MODEL = 'Xenova/all-MiniLM-L6-v2';
// Same device policy as the reranker: prefer the DirectML GPU, fall back to CPU. Override with
// SAC_RERANK_DEVICE=cpu|dml. fp32 — DirectML won't run the q8-quantised graph.
const DEVICE_ORDER: string[] = process.env.SAC_RERANK_DEVICE ? [process.env.SAC_RERANK_DEVICE] : ['dml', 'cpu'];

let loading: Promise<any> | null = null;
/** Lazy singleton — first call downloads (~25MB) + warms the model on the best device; later calls reuse it. */
function load(): Promise<any> {
  if (!loading) {
    loading = (async () => {
      for (let i = 0; i < DEVICE_ORDER.length; i++) {
        const device = DEVICE_ORDER[i];
        try {
          const extractor = await pipeline('feature-extraction', MODEL, { device: device as 'dml' | 'cpu' | 'cuda' | 'auto', dtype: 'fp32' });
          console.error(`[embeddings] all-MiniLM-L6-v2 loaded on ${device}`);
          return extractor;
        } catch (e) {
          const last = i === DEVICE_ORDER.length - 1;
          console.error(`[embeddings] device '${device}' unavailable${last ? '' : ', falling back'}: ${e instanceof Error ? e.message.slice(0, 100) : e}`);
          if (last) throw e;
        }
      }
      throw new Error('embeddings: no usable device');
    })();
  }
  return loading;
}

/** Embed texts → L2-normalised 384-dim vectors (mean-pooled). Batched to bound peak memory. */
export async function embed(texts: string[]): Promise<Float32Array[]> {
  if (!texts.length) return [];
  const extractor = await load();
  const out: Float32Array[] = [];
  const BATCH = 16;
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH).map(t => t || ' '); // empty string → model error; pad to a space
    const res = await extractor(batch, { pooling: 'mean', normalize: true });
    for (const v of res.tolist() as number[][]) out.push(Float32Array.from(v));
  }
  return out;
}

/** Cosine similarity of two L2-normalised vectors = their dot product (range -1..1, ~0..1 in practice). */
export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}
