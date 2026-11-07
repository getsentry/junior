// A double-click selects one word. A slipped click or drag selects a few
// characters or a mark. Neither is text to ask about or quote.
const MIN_SELECTION_WORDS = 2;
const MIN_SELECTION_CHARS = 6;
// Finds words also in scripts that do not put spaces between words.
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

/** True when selected text is long enough to be a deliberate quote. */
export function isDeliberateSelection(text: string): boolean {
  if (text.length < MIN_SELECTION_CHARS) return false;
  let words = 0;
  for (const segment of wordSegmenter.segment(text)) {
    if (segment.isWordLike) words += 1;
    if (words >= MIN_SELECTION_WORDS) return true;
  }
  return false;
}

/** Format text as a Markdown blockquote. */
export function markdownQuote(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.trim() ? `> ${line.trimEnd()}` : ">"))
    .join("\n");
}
