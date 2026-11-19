/** The `$skill-name` or `@name` reference that the caret is in. */
export type ComposerToken = {
  /** Index of the `$` or `@`. */
  start: number;
  /** Index after the last name character, which can be after the caret. */
  end: number;
  /** Name characters before the caret. */
  query: string;
};

// The runtime reads `$name` only after a character that is not a letter,
// digit, or `$`, so `US$5` is not a reference. Keep this boundary the same as
// `skillReferences`.
const TOKEN_BEFORE_CARET = /(?<![a-z0-9$])\$([a-z0-9-]*)$/i;
const NAME_AFTER_CARET = /^[a-z0-9-]*/i;

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
