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
