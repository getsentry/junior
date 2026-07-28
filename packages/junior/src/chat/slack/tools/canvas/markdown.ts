type ListType = "bullet" | "numbered";

interface ListItem {
  indent: number;
  type: ListType;
}

interface Fence {
  marker: "`" | "~";
  length: number;
}

export interface CanvasMarkdownNormalization {
  markdown: string;
  normalizedCount: number;
  normalizedHeadingCount: number;
  flattenedMixedListCount: number;
  flattenedBlockquoteCount: number;
}

function getListType(marker: string): ListType {
  return /^\d/.test(marker) ? "numbered" : "bullet";
}

function getFence(line: string): { fence: Fence; suffix: string } | undefined {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  const run = match?.[1];
  if (!run) return undefined;
  return {
    fence: {
      marker: run[0] as Fence["marker"],
      length: run.length,
    },
    suffix: match[2] ?? "",
  };
}

/** Normalize Markdown constructs known to be rejected by Slack Canvas. */
export function normalizeCanvasMarkdown(
  markdown: string,
): CanvasMarkdownNormalization {
  let normalizedHeadingCount = 0;
  let flattenedMixedListCount = 0;
  let flattenedBlockquoteCount = 0;
  let openFence: Fence | undefined;
  const listItems: ListItem[] = [];

  const lines = markdown.split("\n").map((originalLine) => {
    const fenceLine = getFence(originalLine);
    if (openFence) {
      if (
        fenceLine?.fence.marker === openFence.marker &&
        fenceLine.fence.length >= openFence.length &&
        !fenceLine.suffix.trim()
      ) {
        openFence = undefined;
      }
      return originalLine;
    }
    if (fenceLine) {
      openFence = fenceLine.fence;
      return originalLine;
    }

    const listMatch = originalLine.match(
      /^([ \t]*)([-+*]|\d+[.)])([ \t]+)(.*)$/,
    );
    if (listMatch) {
      const [, whitespace = "", marker = "", gap = "", content = ""] =
        listMatch;
      const indent = whitespace.length;
      const type = getListType(marker);

      while (
        listItems.length > 0 &&
        listItems[listItems.length - 1]!.indent >= indent
      ) {
        listItems.pop();
      }

      const parent = listItems[listItems.length - 1];
      // Slack rejects a list nested under a different list type.
      if (parent && parent.type !== type) {
        const rootIndent = listItems[0]?.indent ?? 0;
        listItems.length = 0;
        listItems.push({ indent: rootIndent, type });
        flattenedMixedListCount += 1;
        return `${" ".repeat(rootIndent)}${marker}${gap}${content}`;
      }

      listItems.push({ indent, type });
      return originalLine;
    }

    const blockquoteMatch = originalLine.match(/^([ \t]+)(>+.*)$/);
    const rootListIndent = listItems[0]?.indent;
    // Slack rejects blockquotes nested inside list items.
    if (
      blockquoteMatch &&
      rootListIndent !== undefined &&
      blockquoteMatch[1]!.length > rootListIndent
    ) {
      flattenedBlockquoteCount += 1;
      return `${" ".repeat(rootListIndent)}${blockquoteMatch[2]}`;
    }

    if (
      rootListIndent !== undefined &&
      originalLine.trim() &&
      originalLine.search(/\S/) <= rootListIndent
    ) {
      listItems.length = 0;
    }

    return originalLine.replace(/^( {0,3})#{4,}(?=[ \t])/, (_, indent) => {
      normalizedHeadingCount += 1;
      return `${indent}###`;
    });
  });

  const normalizedCount =
    normalizedHeadingCount +
    flattenedMixedListCount +
    flattenedBlockquoteCount;

  return {
    markdown: lines.join("\n"),
    normalizedCount,
    normalizedHeadingCount,
    flattenedMixedListCount,
    flattenedBlockquoteCount,
  };
}
