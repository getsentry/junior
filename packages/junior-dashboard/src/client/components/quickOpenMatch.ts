export type QuickOpenMatch = {
  /** UTF-16 indices in the label that the query matched, ascending. */
  indices: number[];
  score: number;
};

// Each term match falls in a tier: a word-start substring beats a substring,
// which beats a scattered subsequence or a typo. Scores inside a tier stay
// below one tier step.
const TIER = 1_000;
const WORD_START_BONUS = 10;
// Each character a scatter spreads over costs this much, so "clt" in
// "Checkout latency triage" ranks far above letters strewn across a title.
const SPAN_PENALTY = 20;
// A one-edit typo beats a loose scatter but not a tight one.
const TYPO_SCORE = 600;
// Shorter terms are mostly noise when edited, and need an exact match.
const TYPO_MIN_LENGTH = 4;

/**
 * Match `query` against `label` the way an editor's quick open does: every
 * space-separated term must appear in order, contiguously or scattered, or
 * within a typo of a word's start, with no case. Higher scores rank first.
 * Returns undefined when a term misses.
 */
export function quickOpenMatch(
  label: string,
  query: string,
): QuickOpenMatch | undefined {
  const haystack = label.toLowerCase();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const indices = new Set<number>();
  let score = 0;
  for (const term of terms) {
    const match = matchTerm(haystack, term);
    if (!match) return undefined;
    score += match.score;
    for (const index of match.indices) indices.add(index);
  }
  return { indices: [...indices].sort((a, b) => a - b), score };
}

function matchTerm(haystack: string, term: string): QuickOpenMatch | undefined {
  let substringAt = -1;
  for (
    let at = haystack.indexOf(term);
    at !== -1;
    at = haystack.indexOf(term, at + 1)
  ) {
    if (isWordStart(haystack, at)) {
      return { indices: range(at, term.length), score: 3 * TIER - at };
    }
    if (substringAt === -1) substringAt = at;
  }
  if (substringAt !== -1) {
    return {
      indices: range(substringAt, term.length),
      score: 2 * TIER - substringAt,
    };
  }
  const scatter = matchScatter(haystack, term);
  // No typo can beat a scatter this tight, so skip the edit distances.
  if (scatter && scatter.score >= TYPO_SCORE) return scatter;
  const typo = matchTypo(haystack, term);
  if (!scatter || !typo) return scatter ?? typo;
  return scatter.score >= typo.score ? scatter : typo;
}

function matchScatter(
  haystack: string,
  term: string,
): QuickOpenMatch | undefined {
  const indices: number[] = [];
  let wordStarts = 0;
  let from = 0;
  for (const char of term) {
    const at = haystack.indexOf(char, from);
    if (at === -1) return undefined;
    if (isWordStart(haystack, at)) wordStarts += 1;
    indices.push(...range(at, char.length));
    from = at + char.length;
  }
  const span = indices.at(-1)! - indices[0]!;
  const score = TIER - span * SPAN_PENALTY + wordStarts * WORD_START_BONUS;
  return { indices, score: Math.min(Math.max(score, 1), TIER - 1) };
}

/**
 * Compare `term` with the text from each word start, so an unfinished word
 * still counts. Allows one edit for short terms and two for longer ones.
 */
function matchTypo(haystack: string, term: string): QuickOpenMatch | undefined {
  if (term.length < TYPO_MIN_LENGTH) return undefined;
  const allowed = term.length < 6 ? 1 : 2;
  let best: { at: number; length: number; distance: number } | undefined;
  // Compare against the rest of the title, not only the word, so
  // `slef-update` still finds "self-update".
  for (const word of haystack.matchAll(/[\p{L}\p{N}]+/gu)) {
    const distances = prefixDistances(
      term,
      haystack.slice(word.index, word.index + term.length + allowed),
    );
    // Each extra or missing letter costs an edit, so lengths further than
    // `allowed` from the term can't match. A tie keeps the length closest
    // to the term's, so the highlight covers the whole term.
    for (let offset = 0; offset <= 2 * allowed; offset++) {
      const length =
        term.length + (offset % 2 ? -1 : 1) * Math.ceil(offset / 2);
      const distance = distances[length];
      if (distance === undefined) continue;
      if (distance <= allowed && (!best || distance < best.distance)) {
        best = { at: word.index, length, distance };
      }
    }
  }
  if (!best) return undefined;
  return {
    indices: range(best.at, best.length),
    score: Math.max(TYPO_SCORE / best.distance - best.at, 1),
  };
}

// Levenshtein distance from `a` to each prefix of `b`, where swapping two
// neighbors costs one edit. Keeps three rows: the swap looks two rows back.
function prefixDistances(a: string, b: string): number[] {
  let before = Array.from({ length: b.length + 1 }, () => 0);
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  let current = Array.from({ length: b.length + 1 }, () => 0);
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        current[j] = Math.min(current[j]!, before[j - 2]! + 1);
      }
    }
    [before, previous, current] = [previous, current, before];
  }
  return previous;
}

function isWordStart(haystack: string, at: number): boolean {
  return at === 0 || !/[\p{L}\p{N}]/u.test(haystack[at - 1]!);
}

function range(start: number, length: number): number[] {
  return Array.from({ length }, (_, offset) => start + offset);
}
