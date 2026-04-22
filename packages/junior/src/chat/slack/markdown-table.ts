export interface MarkdownTableMatch {
  after: string;
  before: string;
  rows: string[][];
}

function getMarkdownFenceDelimiter(line: string): "```" | "~~~" | null {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("```")) {
    return "```";
  }
  if (trimmed.startsWith("~~~")) {
    return "~~~";
  }
  return null;
}

/** Parse a single markdown table row while preserving Slack link cells. */
export function parseMarkdownTableRow(line: string): string[] | null {
  if (!line.includes("|")) {
    return null;
  }

  const normalized = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  let insideSlackLink = false;

  for (const char of normalized) {
    if (char === "<") {
      insideSlackLink = true;
      current += char;
      continue;
    }
    if (char === ">") {
      insideSlackLink = false;
      current += char;
      continue;
    }
    if (char === "|" && !insideSlackLink) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }

  cells.push(current.trim());
  return cells.length >= 2 ? cells : null;
}

/** Return true when a line is a markdown table separator row. */
export function isMarkdownTableSeparator(line: string): boolean {
  const cells = parseMarkdownTableRow(line);
  return (
    cells !== null &&
    cells.length >= 2 &&
    cells.every((cell) => /^:?-{3,}:?$/.test(cell))
  );
}

/** Render parsed markdown-table rows into a Slack-safe ASCII code block. */
export function renderMarkdownTableCodeBlock(rows: string[][]): string {
  const columnCount = Math.max(...rows.map((row) => row.length));
  const normalizedRows = rows.map((row) =>
    Array.from({ length: columnCount }, (_unused, index) => row[index] ?? ""),
  );
  const widths = Array.from({ length: columnCount }, (_unused, index) =>
    Math.max(3, ...normalizedRows.map((row) => (row[index] ?? "").length)),
  );

  const formatRow = (row: string[]) =>
    row
      .map((cell, index) => cell.padEnd(widths[index] ?? 3))
      .join(" | ")
      .trimEnd();

  const header = formatRow(normalizedRows[0] ?? []);
  const separator = widths
    .map((width) => "-".repeat(Math.max(3, width)))
    .join(" | ");
  const body = normalizedRows.slice(1).map(formatRow);

  return ["```", header, separator, ...body, "```"].join("\n");
}

/** Extract the first simple markdown table plus surrounding text. */
export function extractFirstMarkdownTable(
  text: string,
): MarkdownTableMatch | null {
  const lines = text.split("\n");
  let activeFence: "```" | "~~~" | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const fenceDelimiter = getMarkdownFenceDelimiter(lines[index] ?? "");
    if (fenceDelimiter) {
      activeFence =
        activeFence === fenceDelimiter ? null : (activeFence ?? fenceDelimiter);
      continue;
    }
    if (activeFence) {
      continue;
    }

    const header = parseMarkdownTableRow(lines[index] ?? "");
    if (!header || !isMarkdownTableSeparator(lines[index + 1] ?? "")) {
      continue;
    }

    const rows = [header];
    let nextIndex = index + 2;
    while (nextIndex < lines.length) {
      const row = parseMarkdownTableRow(lines[nextIndex] ?? "");
      if (!row) {
        break;
      }
      rows.push(row);
      nextIndex += 1;
    }

    return {
      after: lines.slice(nextIndex).join("\n"),
      before: lines.slice(0, index).join("\n"),
      rows,
    };
  }

  return null;
}
