// Copyright (c) Burak Yigit Kaya. Adapted from Lore's
// packages/core/eval/recall-score.ts (BYK/loreai) at the author's request.
// Deterministic fact matching: no model, no synthesis.

/** Lowercase, collapse whitespace, and trim. */
export function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function isWordChar(ch: string | undefined): boolean {
  return (
    ch !== undefined &&
    ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch === "_")
  );
}

/**
 * True when `fact` appears in normalized text at word boundaries, so a short
 * anchor cannot match inside a larger token.
 */
export function factPresent(textNorm: string, fact: string): boolean {
  const needle = normalizeForMatch(fact);
  if (!needle) return false;
  const leftWord = isWordChar(needle[0]);
  const rightWord = isWordChar(needle[needle.length - 1]);
  let from = 0;
  for (;;) {
    const index = textNorm.indexOf(needle, from);
    if (index === -1) return false;
    const end = index + needle.length;
    const leftOk = !leftWord || !isWordChar(textNorm[index - 1]);
    const rightOk = !rightWord || !isWordChar(textNorm[end]);
    if (leftOk && rightOk) return true;
    from = index + 1;
  }
}

/** Ground-truth anchors for one probe. */
export interface RetrievalAnchors {
  expectedFacts?: string[];
  /** Stale or superseded values that must not appear. */
  forbiddenFacts?: string[];
}

/** Retrieval score for one probe. */
export interface RetrievalScore {
  factRecall: number | null;
  expectedCount: number;
  matchedFacts: string[];
  missedFacts: string[];
  leakedStaleFacts: string[];
  pass: boolean;
}

/** Score text against a probe's anchors. Returns undefined without anchors. */
export function scoreRetrieval(
  text: string,
  anchors: RetrievalAnchors,
): RetrievalScore | undefined {
  const expected = (anchors.expectedFacts ?? []).filter((fact) => fact.trim());
  const forbidden = (anchors.forbiddenFacts ?? []).filter((fact) =>
    fact.trim(),
  );
  if (expected.length === 0 && forbidden.length === 0) return undefined;
  const norm = normalizeForMatch(text);
  const matchedFacts = expected.filter((fact) => factPresent(norm, fact));
  const missedFacts = expected.filter((fact) => !factPresent(norm, fact));
  const leakedStaleFacts = forbidden.filter((fact) => factPresent(norm, fact));
  return {
    factRecall: expected.length ? matchedFacts.length / expected.length : null,
    expectedCount: expected.length,
    matchedFacts,
    missedFacts,
    leakedStaleFacts,
    pass:
      matchedFacts.length === expected.length && leakedStaleFacts.length === 0,
  };
}
