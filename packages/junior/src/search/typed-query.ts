// More words only narrow the match further.
const TYPED_QUERY_TERMS = 4;
// Enough tokens to reach the id in a pasted dashboard URL.
const TYPED_QUERY_TOKENS = 16;
// Fewer letters than one trigram match too much text to help.
const FUZZY_QUERY_MIN_LENGTH = 3;

/** Text that a person types into a search, ready for each kind of match. */
export type TypedQuery = {
  /**
   * The words for a typo-tolerant title match, lowercase, joined by one
   * space. Undefined when they are too short to match by trigrams.
   */
  fuzzy?: string;
  /** A `simple` tsquery: each word starts a word of the text. */
  prefix: string;
  /** Each token of the text, lowercase, to match an exact id. */
  tokens: string[];
};

/**
 * Parse text that a person types into a search. Each word must start a
 * word of the document, so a result shows while the last word is still
 * half typed. Returns undefined when the text has no letters or digits.
 */
export function parseTypedQuery(text: string): TypedQuery | undefined {
  const lower = text.toLowerCase();
  const terms = (lower.match(/[\p{L}\p{N}]+/gu) ?? []).slice(
    0,
    TYPED_QUERY_TERMS,
  );
  if (terms.length === 0) return undefined;
  const fuzzy = terms.join(" ");
  // The terms hold only letters and digits, so they cannot add tsquery syntax.
  return {
    ...(fuzzy.length >= FUZZY_QUERY_MIN_LENGTH ? { fuzzy } : undefined),
    prefix: terms.map((term) => `${term}:*`).join(" & "),
    tokens: (lower.match(/[\p{L}\p{N}_-]+/gu) ?? []).slice(
      0,
      TYPED_QUERY_TOKENS,
    ),
  };
}
