import { markdownNodes, parseMarkdown } from "@sentry/junior-plugin-api";

import { composerTokenFinder } from "./composerTypeaheadToken";

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
const SKILL_REFERENCE = new RegExp(
  `${SKILL_SIGIL}([a-z0-9]+(?:-[a-z0-9]+)*)(?![a-z0-9]|[-_][a-z0-9])`,
  "gi",
);

/** Find the skill reference that a caret is in, if any. */
export const skillTokenAt = composerTokenFinder(SKILL_SIGIL, "[a-z0-9-]", "i");

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

// The `[start, end)` ranges of fenced, indented, and inline code in Markdown
// text. A fence with no closing fence runs to the end of the text, and a run
// of backticks with no closing run is text, as CommonMark reads them.
function codeRanges(text: string): [number, number][] {
  return markdownNodes(parseMarkdown(text), ["code", "inlineCode"]).map(
    ({ position }) => [position?.start.offset ?? 0, position?.end.offset ?? 0],
  );
}
