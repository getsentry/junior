import type { MarkdownLineKind } from "./composerMarkdownSyntax";

const LIST_ITEM = /^(\s*)(?:([-*+])|(\d{1,9})([.)])) (.*)$/;
const ORDERED_ITEM = /^\s*(\d{1,9})([.)]) /;

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

/**
 * The number that each ordered list item renders with, as CommonMark
 * numbers them: a list starts at its first item's number and counts up, so
 * `1.` on each line renders 1, 2, 3. Lines that are not ordered items get
 * undefined. Indented items start nested lists. A bullet at the same
 * indent, a new delimiter, or unindented text after a blank line ends a
 * list.
 */
export function orderedListNumbers(
  lines: { kind: MarkdownLineKind; text: string }[],
): (number | undefined)[] {
  // The open lists, outermost first.
  let open: { delimiter: string; indent: number; next: number }[] = [];
  let afterBlank = false;
  return lines.map(({ kind, text }) => {
    const wasAfterBlank = afterBlank;
    if (kind === "code") return undefined;
    afterBlank = !text.trim();
    if (afterBlank) return undefined;
    const indent = text.length - text.trimStart().length;
    if (kind === "ordered") {
      const [, number, delimiter] = ORDERED_ITEM.exec(text)!;
      open = open.filter(
        (list) =>
          list.indent < indent ||
          (list.indent === indent && list.delimiter === delimiter),
      );
      const list = open.at(-1);
      if (list?.indent === indent) return list.next++;
      open.push({ delimiter: delimiter!, indent, next: Number(number) + 1 });
      return Number(number);
    }
    if (kind === "bullet") {
      open = open.filter((list) => list.indent < indent);
    } else if (indent === 0 && (wasAfterBlank || kind !== "text")) {
      // Text right after an item continues it, as CommonMark's lazy lines.
      open = [];
    }
    return undefined;
  });
}
