import { truncateStatusText } from "@/chat/runtime/status-format";

const PROTECTED_SLACK_SEGMENT_PATTERN =
  /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`)/g;

function normalizeSlackMarkdownSegment(text: string): string {
  let normalized = normalizeMarkdownHeadings(text);
  normalized = normalizeCommonMarkEmphasis(normalized);
  normalized = normalizeMarkdownLinks(normalized);
  normalized = normalizeWrappedRawUrls(normalized);
  return normalizeMarkdownTables(normalized);
}

function normalizeUnprotectedSlackMarkdown(text: string): string {
  let out = "";
  let lastIndex = 0;

  for (const match of text.matchAll(PROTECTED_SLACK_SEGMENT_PATTERN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      out += normalizeSlackMarkdownSegment(text.slice(lastIndex, index));
    }
    out += match[0];
    lastIndex = index + match[0].length;
  }

  if (lastIndex < text.length) {
    out += normalizeSlackMarkdownSegment(text.slice(lastIndex));
  }

  return out;
}

function normalizeMarkdownHeadings(text: string): string {
  return text.replace(/^#{1,6}\s+(.+)$/gm, (_match, heading) => {
    const normalized = String(heading)
      .trim()
      .replace(/\s+#+\s*$/, "")
      .trim();
    return normalized ? `*${normalized}*` : "";
  });
}

function normalizeCommonMarkEmphasis(text: string): string {
  return text
    .replace(/\*\*([^\s*](?:[^\n]*?[^\s*])?)\*\*/g, "*$1*")
    .replace(/~~([^\s~](?:[^\n]*?[^\s~])?)~~/g, "~$1~");
}

function escapeSlackLinkLabel(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "¦");
}

function deriveSlackLinkLabel(url: string): string {
  const withoutScheme = url.replace(/^https?:\/\//, "");
  return withoutScheme.replace(/\/$/, "") || url;
}

function formatSlackLink(url: string, label?: string): string {
  const normalizedUrl = url.trim();
  const normalizedLabel = escapeSlackLinkLabel(
    label?.trim() || deriveSlackLinkLabel(normalizedUrl),
  );
  return `<${normalizedUrl}|${normalizedLabel}>`;
}

function normalizeMarkdownLinks(text: string): string {
  return text.replace(
    /(^|[^!])\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_match, prefix, label, url) =>
      `${prefix}${formatSlackLink(String(url), String(label))}`,
  );
}

function splitSlackUrlSuffix(text: string): { suffix: string; url: string } {
  let url = text;
  let suffix = "";

  while (/[*_~`]/.test(url.at(-1) ?? "")) {
    url = url.slice(0, -1);
  }

  while (/[.,!?;:]/.test(url.at(-1) ?? "")) {
    suffix = `${url.at(-1) ?? ""}${suffix}`;
    url = url.slice(0, -1);
  }

  while (url.endsWith(")")) {
    const opens = url.split("(").length - 1;
    const closes = url.split(")").length - 1;
    if (closes <= opens) {
      break;
    }
    suffix = `)${suffix}`;
    url = url.slice(0, -1);
  }

  return { suffix, url };
}

function normalizeWrappedRawUrls(text: string): string {
  return text.replace(
    /([*_~`]+)?(https?:\/\/[^\s<]+)([*_~`]+)?/g,
    (match, leading, rawUrl, trailing) => {
      if (!leading && !trailing) {
        return match;
      }

      const { suffix, url } = splitSlackUrlSuffix(String(rawUrl));
      return `${formatSlackLink(url)}${suffix}`;
    },
  );
}

function parseMarkdownTableRow(line: string): string[] | null {
  if (!line.includes("|")) {
    return null;
  }

  const normalized = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells = normalized.split("|").map((cell) => cell.trim());
  return cells.length >= 2 ? cells : null;
}

function isMarkdownTableSeparator(line: string): boolean {
  const cells = parseMarkdownTableRow(line);
  return (
    cells !== null &&
    cells.length >= 2 &&
    cells.every((cell) => /^:?-{3,}:?$/.test(cell))
  );
}

function renderMarkdownTableCodeBlock(rows: string[][]): string {
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

function normalizeMarkdownTables(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const header = parseMarkdownTableRow(lines[index] ?? "");
    if (!header || !isMarkdownTableSeparator(lines[index + 1] ?? "")) {
      out.push(lines[index] ?? "");
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

    out.push(renderMarkdownTableCodeBlock(rows));
    index = nextIndex - 1;
  }

  return out.join("\n");
}

/** Insert blank lines between content blocks so Slack renders them with visual separation. */
function ensureBlockSpacing(text: string): string {
  const codeBlockPattern = /^```/;
  const listItemPattern = /^[-*•]\s|^\d+\.\s/;
  const lines = text.split("\n");
  const result: string[] = [];
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isCodeFence = codeBlockPattern.test(line.trimStart());

    if (isCodeFence) {
      if (!inCodeBlock) {
        const prev = result.length > 0 ? result[result.length - 1] : undefined;
        if (prev !== undefined && prev.trim() !== "") {
          result.push("");
        }
      }
      inCodeBlock = !inCodeBlock;
      result.push(line);
      continue;
    }

    if (inCodeBlock) {
      result.push(line);
      continue;
    }

    const prev = result.length > 0 ? result[result.length - 1] : undefined;
    if (
      prev !== undefined &&
      prev.trim() !== "" &&
      line.trim() !== "" &&
      !(
        listItemPattern.test(prev.trimStart()) &&
        listItemPattern.test(line.trimStart())
      )
    ) {
      result.push("");
    }

    result.push(line);
  }

  return result.join("\n");
}

/**
 * Render model-authored markdown into Slack-friendly `mrkdwn`.
 *
 * Slack reply delivery owns chunking and continuation markers separately.
 * This helper only normalizes text into the repository's canonical Slack
 * rendering form.
 */
export function renderSlackMrkdwn(text: string): string {
  let normalized = text.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "");
  normalized = normalizeUnprotectedSlackMarkdown(normalized);
  normalized = ensureBlockSpacing(normalized);
  return normalized.replace(/\n{3,}/g, "\n\n").trim();
}

/** Normalize assistant status text before handing it to Slack. */
export function normalizeSlackStatusText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  return truncateStatusText(trimmed.replace(/(?:\.\s*)+$/, "").trim());
}
