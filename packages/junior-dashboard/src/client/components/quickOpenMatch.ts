export type QuickOpenMatch = {
  /** UTF-16 indices in the label that the query matched, ascending. */
  indices: number[];
  score: number;
};

// Each term match falls in a tier: a word-start substring beats a substring,
// which beats a scattered subsequence. Scores inside a tier stay below one
// tier step.
const TIER = 1_000;
const WORD_START_BONUS = 10;

/**
 * Match `query` against `label` the way an editor's quick open does: every
 * space-separated term must appear in order, contiguously or scattered, with
 * no case. Higher scores rank first. Returns undefined when a term misses.
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
  // A tight run that lands on word starts, such as "clt" in
  // "checkout latency triage", ranks above a loose scatter.
  const span = indices.at(-1)! - indices[0]!;
  const score = TIER - span + wordStarts * WORD_START_BONUS;
  return { indices, score: Math.min(Math.max(score, 1), 2 * TIER - 1) };
}

function isWordStart(haystack: string, at: number): boolean {
  return at === 0 || !/[\p{L}\p{N}]/u.test(haystack[at - 1]!);
}

function range(start: number, length: number): number[] {
  return Array.from({ length }, (_, offset) => start + offset);
}
