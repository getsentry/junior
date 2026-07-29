type ListType = "bullet" | "numbered";

interface ListItem {
  contentIndent: number;
  indent: number;
  type: ListType;
  unwrapped: boolean;
}

interface Fence {
  marker: "`" | "~";
  length: number;
}

interface OpenFence extends Fence {
  quoteDepth: number;
}

interface FenceLine {
  fence: Fence;
  indent: number;
  suffix: string;
}

export interface CanvasMarkdownNormalization {
  markdown: string;
  normalizedCount: number;
  normalizedHeadingCount: number;
  normalizedMixedListCount: number;
  unwrappedBlockquoteCount: number;
}

function getListType(marker: string): ListType {
  return /^\d/.test(marker) ? "numbered" : "bullet";
}

function getPlainListMarker(marker: string, type: ListType): string {
  return type === "numbered" ? `${marker.match(/^\d+/)?.[0] ?? "1"}:` : "•";
}

function getIndentWidth(whitespace: string, startColumn = 0): number {
  let column = startColumn;
  for (const character of whitespace) {
    column += character === "\t" ? 4 - (column % 4) : 1;
  }
  return column - startColumn;
}

function getLineIndent(line: string): number {
  return getIndentWidth(line.match(/^[ \t]*/)?.[0] ?? "");
}

function getFence(line: string): FenceLine | undefined {
  const match = line.match(/^([ \t]*)(`{3,}|~{3,})(.*)$/);
  const run = match?.[2];
  if (!run) return undefined;
  return {
    fence: {
      marker: run[0] as Fence["marker"],
      length: run.length,
    },
    indent: getIndentWidth(match[1] ?? ""),
    suffix: match[3] ?? "",
  };
}

function isListBlockIndent(indent: number, listItems: ListItem[]): boolean {
  return listItems.some(
    (item) => indent >= item.contentIndent && indent <= item.contentIndent + 3,
  );
}

function canOpenFence(fenceLine: FenceLine, listItems: ListItem[]) {
  return (
    fenceLine.indent <= 3 || isListBlockIndent(fenceLine.indent, listItems)
  );
}

function unwrapNestedBlockquote(
  line: string,
  listItems: ListItem[],
  maxQuoteDepth = Number.POSITIVE_INFINITY,
): { line: string; quoteDepth: number } {
  const match = line.match(/^([ \t]+)((?:>[ \t]*)+)(.*)$/);
  if (!match || !isListBlockIndent(getIndentWidth(match[1] ?? ""), listItems)) {
    return { line, quoteDepth: 0 };
  }

  let quotePrefix = match[2] ?? "";
  const quoteDepth = Math.min(
    quotePrefix.match(/>/g)?.length ?? 0,
    maxQuoteDepth,
  );
  for (let index = 0; index < quoteDepth; index += 1) {
    quotePrefix = quotePrefix.replace(/^>[ \t]*/, "");
  }

  return {
    line: `${match[1]}${quotePrefix}${match[3]}`,
    quoteDepth,
  };
}

/** Normalize Markdown constructs known to be rejected by Slack Canvas. */
export function normalizeCanvasMarkdown(
  markdown: string,
): CanvasMarkdownNormalization {
  let normalizedHeadingCount = 0;
  let normalizedMixedListCount = 0;
  let unwrappedBlockquoteCount = 0;
  let openFence: OpenFence | undefined;
  const listItems: ListItem[] = [];

  const lines = markdown.split("\n").map((originalLine) => {
    if (openFence) {
      const unwrapped =
        openFence.quoteDepth > 0
          ? unwrapNestedBlockquote(
              originalLine,
              listItems,
              openFence.quoteDepth,
            )
          : { line: originalLine, quoteDepth: 0 };
      if (unwrapped.quoteDepth > 0) {
        unwrappedBlockquoteCount += 1;
      }
      const fenceLine = getFence(unwrapped.line);
      if (
        fenceLine?.fence.marker === openFence.marker &&
        fenceLine.fence.length >= openFence.length &&
        !fenceLine.suffix.trim()
      ) {
        openFence = undefined;
      }
      return unwrapped.line;
    }

    const unwrapped = unwrapNestedBlockquote(originalLine, listItems);
    // Slack rejects blockquotes nested inside list items. Unwrap every quote
    // marker before processing syntax that the quote may have hidden.
    if (unwrapped.quoteDepth > 0) {
      unwrappedBlockquoteCount += 1;
    }
    const line = unwrapped.line;

    const fenceLine = getFence(line);
    if (fenceLine && canOpenFence(fenceLine, listItems)) {
      const rootListContentIndent = listItems[0]?.contentIndent;
      if (
        rootListContentIndent !== undefined &&
        fenceLine.indent < rootListContentIndent
      ) {
        listItems.length = 0;
      }
      openFence = {
        ...fenceLine.fence,
        quoteDepth: unwrapped.quoteDepth,
      };
      return line;
    }

    const listMatch = line.match(/^([ \t]*)([-+*]|\d+[.)])([ \t]+)(.*)$/);
    if (listMatch) {
      const [, whitespace = "", marker = "", gap = "", rawContent = ""] =
        listMatch;
      const indent = getIndentWidth(whitespace);
      const type = getListType(marker);
      const markerEnd = indent + getIndentWidth(marker);
      const contentIndent = markerEnd + getIndentWidth(gap, markerEnd);
      const contentMatch = rawContent.match(/^(?:>[ \t]*)+(.*)$/);
      const content = contentMatch?.[1] ?? rawContent;
      if (contentMatch) {
        unwrappedBlockquoteCount += 1;
      }

      while (
        listItems.length > 0 &&
        listItems[listItems.length - 1]!.indent >= indent
      ) {
        listItems.pop();
      }

      const parent = listItems[listItems.length - 1];
      // Slack rejects a list nested under a different list type.
      if (parent && (parent.unwrapped || parent.type !== type)) {
        listItems.push({
          contentIndent,
          indent,
          type: parent.type,
          unwrapped: true,
        });
        normalizedMixedListCount += 1;
        return `${whitespace}${getPlainListMarker(marker, type)}${gap}${content}`;
      }

      listItems.push({ contentIndent, indent, type, unwrapped: false });
      return contentMatch ? `${whitespace}${marker}${gap}${content}` : line;
    }

    const rootListContentIndent = listItems[0]?.contentIndent;
    if (
      rootListContentIndent !== undefined &&
      line.trim() &&
      getLineIndent(line) < rootListContentIndent
    ) {
      listItems.length = 0;
    }

    const headingMatch = line.match(/^([ \t]*)#{4,}(?=[ \t])/);
    const headingIndent = headingMatch
      ? getIndentWidth(headingMatch[1] ?? "")
      : undefined;
    if (
      headingMatch &&
      headingIndent !== undefined &&
      (headingIndent <= 3 || isListBlockIndent(headingIndent, listItems))
    ) {
      normalizedHeadingCount += 1;
      return line.replace(
        /^([ \t]*)#{4,}(?=[ \t])/,
        (_, indent) => `${indent}###`,
      );
    }

    return line;
  });

  const normalizedCount =
    normalizedHeadingCount +
    normalizedMixedListCount +
    unwrappedBlockquoteCount;

  return {
    markdown: lines.join("\n"),
    normalizedCount,
    normalizedHeadingCount,
    normalizedMixedListCount,
    unwrappedBlockquoteCount,
  };
}
