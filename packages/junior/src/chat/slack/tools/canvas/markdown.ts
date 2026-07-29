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
  unwrapNestedQuote: boolean;
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

function getIndentWidth(whitespace: string): number {
  let width = 0;
  for (const character of whitespace) {
    width += character === "\t" ? 4 - (width % 4) : 1;
  }
  return width;
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

function isInsideListItem(indent: number, listItems: ListItem[]): boolean {
  return listItems.some((item) => indent >= item.contentIndent);
}

function canOpenFence(fenceLine: FenceLine, listItems: ListItem[]) {
  return (
    fenceLine.indent <= 3 ||
    listItems.some(
      (item) =>
        fenceLine.indent >= item.contentIndent &&
        fenceLine.indent <= item.contentIndent + 3,
    )
  );
}

function unwrapNestedBlockquote(
  line: string,
  listItems: ListItem[],
): { line: string; unwrapped: boolean } {
  const match = line.match(/^([ \t]+)(?:>[ \t]*)+(.*)$/);
  if (
    !match ||
    !isInsideListItem(getIndentWidth(match[1] ?? ""), listItems)
  ) {
    return { line, unwrapped: false };
  }
  return {
    line: `${match[1]}${match[2]}`,
    unwrapped: true,
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
      const unwrapped = openFence.unwrapNestedQuote
        ? unwrapNestedBlockquote(originalLine, listItems)
        : { line: originalLine, unwrapped: false };
      if (unwrapped.unwrapped) {
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
    if (unwrapped.unwrapped) {
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
        unwrapNestedQuote: unwrapped.unwrapped,
      };
      return line;
    }

    const listMatch = line.match(
      /^([ \t]*)([-+*]|\d+[.)])([ \t]+)(.*)$/,
    );
    if (listMatch) {
      const [, whitespace = "", marker = "", gap = "", content = ""] =
        listMatch;
      const indent = getIndentWidth(whitespace);
      const type = getListType(marker);
      const contentIndent =
        indent + getIndentWidth(marker) + getIndentWidth(gap);

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
      return line;
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
      (headingIndent <= 3 ||
        isInsideListItem(headingIndent, listItems))
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
