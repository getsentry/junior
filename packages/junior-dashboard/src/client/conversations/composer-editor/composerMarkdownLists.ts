const LIST_ITEM = /^(\s*)(?:([-*+])|(\d{1,9})([.)])) (.*)$/;

/** What Enter at the end of a list item does. */
export type ListEnter = { kind: "continue"; marker: string } | { kind: "end" };

/**
 * Enter at the end of a list item line. An item with text continues the
 * list: the next line gets the same bullet, or the number after the one
 * that the item renders with (`rendered`, else its own). An item with only
 * its marker ends the list. Undefined when the line is not a list item.
 */
export function listEnter(
  line: string,
  rendered?: number,
): ListEnter | undefined {
  const match = LIST_ITEM.exec(line);
  if (!match) return undefined;
  const [, indent, bullet, number, delimiter, content] = match;
  if (!content!.trim()) return { kind: "end" };
  const marker = bullet ?? `${(rendered ?? Number(number)) + 1}${delimiter}`;
  return { kind: "continue", marker: `${indent}${marker} ` };
}
