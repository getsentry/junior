/** The `$skill-name` or `@name` reference that the caret is in. */
export type ComposerToken = {
  /** Index of the `$` or `@`. */
  start: number;
  /** Index after the last name character, which can be after the caret. */
  end: number;
  /** Name characters before the caret. */
  query: string;
};

/** One complete `$skill-name` reference in text. */
export type SkillReference = {
  /** Index of the `$`. */
  start: number;
  /** Index after the last name character. */
  end: number;
  /** Lowercase name, as the runtime reads it. */
  name: string;
};

// The runtime reads `$name` only after a character that is not a letter,
// digit, or `$`, so `US$5` is not a reference. Keep this boundary and the
// name shape the same as `DOLLAR_REFERENCE` in
// `packages/junior/src/chat/skill-references.ts`.
const SKILL_SIGIL = String.raw`(?<![a-z0-9$])\$`;
const TOKEN_BEFORE_CARET = new RegExp(`${SKILL_SIGIL}([a-z0-9-]*)$`, "i");
const NAME_AFTER_CARET = /^[a-z0-9-]*/i;
const SKILL_REFERENCE = new RegExp(
  `${SKILL_SIGIL}([a-z0-9]+(?:-[a-z0-9]+)*)(?![a-z0-9]|[-_][a-z0-9])`,
  "gi",
);

/** Find the skill reference that a caret at `caret` is in, if any. */
export function skillTokenAt(
  text: string,
  caret: number,
): ComposerToken | undefined {
  const match = TOKEN_BEFORE_CARET.exec(text.slice(0, caret));
  if (!match) return undefined;
  const rest = NAME_AFTER_CARET.exec(text.slice(caret))?.[0] ?? "";
  return { start: match.index, end: caret + rest.length, query: match[1]! };
}

/** Find each `$skill-name` reference in `text` that the runtime would read. */
export function findSkillReferences(text: string): SkillReference[] {
  return [...text.matchAll(SKILL_REFERENCE)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    name: match[1]!.toLowerCase(),
  }));
}

/**
 * Find each `$skill-name` reference outside Markdown code, the ones that a
 * sent message links. The composer styles the same ones.
 */
export function findProseSkillReferences(text: string): SkillReference[] {
  const code = codeRanges(text);
  return findSkillReferences(text).filter(
    (reference) =>
      !code.some(
        ([start, end]) => reference.start < end && reference.end > start,
      ),
  );
}

// A fence line opens a block that runs to its closing fence, or to the end
// of the text. A run of backticks opens a span that ends at the next run of
// the same length. A run with no closing run is text.
const CODE_OPENER = /(^[ \t]*```)|`+/gm;
const FENCE_CLOSER = /\n[ \t]*```/g;

// The `[start, end)` ranges of fenced and inline code in Markdown text.
function codeRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  const opener = new RegExp(CODE_OPENER);
  let match: RegExpExecArray | null;
  while ((match = opener.exec(text))) {
    const fence = Boolean(match[1]);
    const closer = fence
      ? new RegExp(FENCE_CLOSER)
      : new RegExp(`(?<!\`)${match[0]}(?!\`)`, "g");
    closer.lastIndex = opener.lastIndex;
    const close = closer.exec(text);
    if (!close && !fence) continue;
    const end = close ? close.index + close[0].length : text.length;
    ranges.push([match.index, end]);
    opener.lastIndex = end;
  }
  return ranges;
}
