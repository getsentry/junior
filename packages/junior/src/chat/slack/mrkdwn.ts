import { truncateStatusText } from "@/chat/runtime/status-format";
import {
  isMarkdownTableSeparator,
  parseMarkdownTableRow,
  renderMarkdownTableCodeBlock,
} from "@/chat/slack/markdown-table";

const PROTECTED_SLACK_SEGMENT_PATTERN =
  /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`)/g;

function normalizeSlackMarkdownSegment(text: string): string {
  let normalized = stripMarkdownHtmlComments(text);
  normalized = normalizeMarkdownHeadings(normalized);
  normalized = normalizeCommonMarkEmphasis(normalized);
  normalized = normalizeMarkdownLinks(normalized);
  normalized = normalizeWrappedRawUrls(normalized);
  normalized = normalizeMarkdownTables(normalized);
  return escapeSlackControlChars(normalized);
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
    .replace(/\*\*\*([^\s*](?:[^\n]*?[^\s*])?)\*\*\*/g, "*$1*")
    .replace(/\*\*([^\s*](?:[^\n]*?[^\s*])?)\*\*/g, "*$1*")
    .replace(/~~([^\s~](?:[^\n]*?[^\s~])?)~~/g, "~$1~");
}

function removeMarkdownHtmlComments(text: string): string {
  let normalized = text;

  while (true) {
    const start = normalized.indexOf("<!--");
    if (start === -1) {
      return normalized;
    }

    const end = normalized.indexOf("-->", start + 4);
    if (end === -1) {
      return normalized;
    }

    normalized = `${normalized.slice(0, start)}${normalized.slice(end + 3)}`;
  }
}

function stripMarkdownHtmlComments(text: string): string {
  return removeMarkdownHtmlComments(text).replaceAll("<!--", "&lt;!--");
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

type ParsedMarkdownUrl = {
  endIndex: number;
  url: string;
};

type MarkdownLinkDefinitionMap = Map<string, string>;

function normalizeMarkdownLinkIdentifier(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

function isMarkdownLinkTitle(text: string): boolean {
  return /^"[^"\n]*"$|^'[^'\n]*'$|^\([^()\n]*\)$/.test(text);
}

function isSupportedMarkdownUrl(text: string, startIndex: number): boolean {
  return (
    text.startsWith("https://", startIndex) ||
    text.startsWith("http://", startIndex)
  );
}

function parseMarkdownUrl(
  text: string,
  startIndex: number,
  options?: {
    stopAtClosingParen?: boolean;
  },
): ParsedMarkdownUrl | null {
  if (!isSupportedMarkdownUrl(text, startIndex)) {
    return null;
  }

  let depth = 0;
  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\n") {
      return null;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      if (depth > 0) {
        depth -= 1;
        continue;
      }
      if (options?.stopAtClosingParen) {
        const url = text.slice(startIndex, index);
        return url ? { endIndex: index + 1, url } : null;
      }
      const url = text.slice(startIndex, index);
      return url ? { endIndex: index, url } : null;
    }
    if (!/\s/.test(char)) {
      continue;
    }

    const url = text.slice(startIndex, index);
    return url ? { endIndex: index, url } : null;
  }

  const url = text.slice(startIndex);
  return url ? { endIndex: text.length, url } : null;
}

function parseInlineMarkdownLinkUrl(
  text: string,
  startIndex: number,
): ParsedMarkdownUrl | null {
  return parseMarkdownUrl(text, startIndex, {
    stopAtClosingParen: true,
  });
}

function parseMarkdownDefinitionUrl(text: string): ParsedMarkdownUrl | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("<")) {
    const closeIndex = trimmed.indexOf(">");
    if (closeIndex <= 1) {
      return null;
    }
    const url = trimmed.slice(1, closeIndex);
    if (!isSupportedMarkdownUrl(url, 0)) {
      return null;
    }
    const trailing = trimmed.slice(closeIndex + 1).trim();
    if (trailing && !isMarkdownLinkTitle(trailing)) {
      return null;
    }
    return {
      endIndex: trimmed.length,
      url,
    };
  }

  const parsed = parseMarkdownUrl(trimmed, 0);
  if (!parsed) {
    return null;
  }
  const trailing = trimmed.slice(parsed.endIndex).trim();
  if (trailing && !isMarkdownLinkTitle(trailing)) {
    return null;
  }
  return parsed;
}

function extractMarkdownLinkDefinitions(text: string): {
  definitions: MarkdownLinkDefinitionMap;
  textWithoutDefinitions: string;
} {
  const definitions: MarkdownLinkDefinitionMap = new Map();
  const out: string[] = [];

  for (const line of text.split("\n")) {
    const match = line.match(/^\s*\[([^\]\n]+)\]:\s*(.*)$/);
    if (!match) {
      out.push(line);
      continue;
    }

    const identifier = normalizeMarkdownLinkIdentifier(match[1] ?? "");
    const rawRest = (match[2] ?? "").trim();
    if (!identifier || !rawRest) {
      out.push(line);
      continue;
    }

    const parsed = parseMarkdownDefinitionUrl(rawRest);
    if (!parsed) {
      out.push(line);
      continue;
    }

    definitions.set(identifier, parsed.url);
  }

  return {
    definitions,
    textWithoutDefinitions: out.join("\n"),
  };
}

function normalizeInlineMarkdownLinks(text: string): string {
  let out = "";
  let index = 0;

  while (index < text.length) {
    const linkStart = text.indexOf("[", index);
    if (linkStart === -1) {
      out += text.slice(index);
      break;
    }

    out += text.slice(index, linkStart);
    if (text[linkStart - 1] === "!") {
      out += "[";
      index = linkStart + 1;
      continue;
    }

    const labelEnd = text.indexOf("](", linkStart + 1);
    if (labelEnd === -1) {
      out += text.slice(linkStart);
      break;
    }

    const label = text.slice(linkStart + 1, labelEnd);
    if (!label || label.includes("\n")) {
      out += "[";
      index = linkStart + 1;
      continue;
    }

    const parsed = parseInlineMarkdownLinkUrl(text, labelEnd + 2);
    if (!parsed) {
      out += "[";
      index = linkStart + 1;
      continue;
    }

    out += formatSlackLink(parsed.url, label);
    index = parsed.endIndex;
  }

  return out;
}

function normalizeReferenceMarkdownLinks(
  text: string,
  definitions: MarkdownLinkDefinitionMap,
): string {
  return text.replace(
    /(^|[^!])\[([^\]\n]+)\]\[([^\]\n]*)\]/g,
    (_match, prefix, label, rawIdentifier) => {
      const identifier = normalizeMarkdownLinkIdentifier(
        rawIdentifier ? String(rawIdentifier) : String(label),
      );
      const url = definitions.get(identifier);
      if (!url) {
        return `${prefix}[${label}][${rawIdentifier}]`;
      }
      return `${prefix}${formatSlackLink(String(url), String(label))}`;
    },
  );
}

function normalizeMarkdownLinks(text: string): string {
  const { definitions, textWithoutDefinitions } =
    extractMarkdownLinkDefinitions(text);
  const inlineNormalized = normalizeInlineMarkdownLinks(textWithoutDefinitions);
  if (definitions.size === 0) {
    return inlineNormalized;
  }
  return normalizeReferenceMarkdownLinks(inlineNormalized, definitions);
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

function splitWrappedRawUrlToken(token: string): {
  after: string;
  before: string;
  core: string;
} {
  let start = 0;
  while (/[([{'"']/.test(token[start] ?? "")) {
    start += 1;
  }

  let end = token.length;
  while (end > start && /[)\]}"',.!?;:]/.test(token[end - 1] ?? "")) {
    end -= 1;
  }

  return {
    after: token.slice(end),
    before: token.slice(0, start),
    core: token.slice(start, end),
  };
}

function normalizeWrappedRawUrlToken(token: string): string {
  const { after, before, core } = splitWrappedRawUrlToken(token);
  const match = core.match(/^([*_~`]+)(https?:\/\/[^\s<]+?)([*_~`]+)$/);
  if (!match) {
    return token;
  }

  const { suffix, url } = splitSlackUrlSuffix(match[2] ?? "");
  return `${before}${formatSlackLink(url)}${suffix}${after}`;
}

function normalizeWrappedRawUrls(text: string): string {
  let out = "";
  let lastIndex = 0;

  for (const match of text.matchAll(/\S+/g)) {
    const index = match.index ?? 0;
    out += text.slice(lastIndex, index);
    out += normalizeWrappedRawUrlToken(match[0]);
    lastIndex = index + match[0].length;
  }

  return `${out}${text.slice(lastIndex)}`;
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

function isPreservedSlackEntity(text: string, index: number): number {
  if (text.startsWith("&amp;", index)) {
    return 5;
  }
  if (text.startsWith("&lt;", index) || text.startsWith("&gt;", index)) {
    return 4;
  }
  return 0;
}

function isSlackBlockQuoteMarker(text: string, index: number): boolean {
  if (text[index] !== ">") {
    return false;
  }

  let cursor = index - 1;
  while (cursor >= 0 && text[cursor] !== "\n") {
    if (!/\s/.test(text[cursor] ?? "")) {
      return false;
    }
    cursor -= 1;
  }
  return true;
}

function isPreservedSlackToken(token: string): boolean {
  return (
    /^<https?:\/\/[^>\s]+(?:\|[^>]+)?>$/.test(token) ||
    /^<mailto:[^>\s]+(?:\|[^>]+)?>$/.test(token) ||
    /^<@[^>|]+(?:\|[^>]+)?>$/.test(token) ||
    /^<#[^>|]+(?:\|[^>]+)?>$/.test(token) ||
    /^<!(?!-)[^>]+>$/.test(token)
  );
}

function escapeSlackControlCharsSegment(text: string): string {
  let out = "";

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "&") {
      const entityLength = isPreservedSlackEntity(text, index);
      if (entityLength > 0) {
        out += text.slice(index, index + entityLength);
        index += entityLength - 1;
        continue;
      }
      out += "&amp;";
      continue;
    }

    if (char === "<") {
      const closeIndex = text.indexOf(">", index + 1);
      if (closeIndex !== -1) {
        const token = text.slice(index, closeIndex + 1);
        if (isPreservedSlackToken(token)) {
          out += token;
          index = closeIndex;
          continue;
        }
      }

      out += "&lt;";
      continue;
    }

    if (char === ">") {
      out += isSlackBlockQuoteMarker(text, index) ? ">" : "&gt;";
      continue;
    }

    out += char;
  }

  return out;
}

function escapeSlackControlChars(text: string): string {
  let out = "";
  let lastIndex = 0;

  for (const match of text.matchAll(PROTECTED_SLACK_SEGMENT_PATTERN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      out += escapeSlackControlCharsSegment(text.slice(lastIndex, index));
    }
    out += match[0];
    lastIndex = index + match[0].length;
  }

  if (lastIndex < text.length) {
    out += escapeSlackControlCharsSegment(text.slice(lastIndex));
  }

  return out;
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
