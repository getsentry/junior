/** The `$`, `@`, or `#` reference that the caret is in. */
export type ComposerToken = {
  /** Index of the `$`, `@`, or `#`. */
  start: number;
  /** Index after the last name character, which can be after the caret. */
  end: number;
  /** Name characters before the caret, with one space between words. */
  query: string;
};

/**
 * Make a finder for the reference that a caret is in: `trigger`, then
 * words of `nameChar` with one space between them, so `@Avery Chen` finds
 * a name with a space. The query starts with a name character, and it can
 * end with one space while the reader types the next word. Two spaces end
 * it. After the caret, only the rest of the word is in the reference, and
 * nothing is when the query ends with a space.
 */
export function composerTokenFinder(
  trigger: string,
  nameChar: string,
  flags: string,
): (text: string, caret: number) => ComposerToken | undefined {
  // Each space must come before a name character, so no two ways to split
  // the words exist and a miss does not backtrack for long.
  const beforeCaret = new RegExp(
    `${trigger}((?:${nameChar}+(?: ${nameChar}+)* ?)?)$`,
    flags,
  );
  const afterCaret = new RegExp(`^${nameChar}*`, flags);
  return (text, caret) => {
    const match = beforeCaret.exec(text.slice(0, caret));
    if (!match) return undefined;
    const rest = match[1]!.endsWith(" ")
      ? ""
      : (afterCaret.exec(text.slice(caret))?.[0] ?? "");
    return { start: match.index, end: caret + rest.length, query: match[1]! };
  };
}
