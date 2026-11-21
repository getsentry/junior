// Parts of Okapi BM25 and BM25F. Each search surface collects its own terms,
// document frequencies, and field lengths, and adds the parts up itself.

const DEFAULT_K1 = 1.2;

/**
 * Inverse document frequency of a term that `documentFrequency` of
 * `documentCount` documents contain. A rarer term gets a larger value. The
 * value is never negative.
 */
export function bm25InverseDocumentFrequency(
  documentCount: number,
  documentFrequency: number,
): number {
  return Math.log(
    1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5),
  );
}

/**
 * Term frequency in one field, normalized for the length of the field. A
 * field of the mean length keeps its frequency. `b` sets how strongly a
 * longer field lowers it, from 0 (not at all) to 1.
 */
export function bm25NormalizedFrequency(
  termFrequency: number,
  length: number,
  meanLength: number,
  b: number,
): number {
  const lengthRatio = meanLength === 0 ? 1 : length / meanLength;
  return termFrequency / (1 - b + b * lengthRatio);
}

/**
 * Saturate a normalized term frequency, so each more occurrence of a term
 * adds less to the score. Multiply the result by the inverse document
 * frequency of the term.
 */
export function bm25Saturation(frequency: number, k1 = DEFAULT_K1): number {
  return (frequency * (k1 + 1)) / (frequency + k1);
}
