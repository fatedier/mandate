/** Lexical similarity between two memories' content, from 0 to 1. The dream
 *  uses it, beside stored embeddings, to flag possible duplicates for its model
 *  to read; nothing merges on it alone. Words alike are not meaning alike: a
 *  changed value or an added "not" scores above the threshold. */

/** At or above this, two memories are flagged as possible duplicates. */
export const SIMILAR_MEMORY_THRESHOLD = 0.82;

/** 1 for the same words, the length ratio when one contains the other, and
 *  otherwise the Jaccard overlap of their words and character pairs (pairs so
 *  text without spaces between words, such as Chinese, still compares). */
export function contentSimilarity(a: string, b: string): number {
  const normalizedA = normalizeForComparison(a);
  const normalizedB = normalizeForComparison(b);
  if (!normalizedA || !normalizedB) return 0;
  if (normalizedA === normalizedB) return 1;
  if (normalizedA.includes(normalizedB) || normalizedB.includes(normalizedA)) {
    return Math.min(normalizedA.length, normalizedB.length) / Math.max(normalizedA.length, normalizedB.length);
  }
  return jaccard(featureSet(normalizedA), featureSet(normalizedB));
}

/** Lower case, letters and digits only, single spaces. */
export function normalizeForComparison(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

function featureSet(value: string): Set<string> {
  const features = new Set<string>();
  for (const token of value.split(/\s+/).filter(Boolean)) features.add(token);
  const compact = value.replace(/\s+/g, "");
  for (let i = 0; i < compact.length - 1; i += 1) features.add(compact.slice(i, i + 2));
  return features;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}
