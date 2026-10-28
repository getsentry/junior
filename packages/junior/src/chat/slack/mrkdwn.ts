import { truncateStatusText } from "@/chat/slack/status-format";
import { applyPluginFormatMarkdown } from "@/chat/plugins/agent-hooks";

/** Escape dynamic text for Slack mrkdwn without changing intended formatting. */
export function escapeSlackMrkdwnText(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** Escape a URL for Slack explicit link syntax while preserving query semantics. */
export function escapeSlackLinkUrl(url: string): string {
  return url
    .replaceAll("&", "&amp;")
    .replaceAll("<", "%3C")
    .replaceAll(">", "%3E");
}

/** Build a Slack explicit link from dynamic URL and label values. */
export function formatSlackLink(url: string, label: string): string {
  return `<${escapeSlackLinkUrl(url)}|${escapeSlackMrkdwnText(label)}>`;
}

function readInlineCodeSpan(
  line: string,
  start: number,
): { text: string; end: number } | undefined {
  if (line[start] !== "`") {
    return undefined;
  }

  let n = 1;
  while (line[start + n] === "`") {
    n++;
  }

  const marker = "`".repeat(n);
  let search = start + n;

  while (search < line.length) {
    const close = line.indexOf(marker, search);
    if (close === -1) {
      return undefined;
    }
    const after = close + n;
    if (line[after] !== "`") {
      return { text: line.slice(start, after), end: after };
    }
    search = after + 1;
  }

  return undefined;
}

function readExistingSlackAngleToken(
  line: string,
  start: number,
): { text: string; end: number } | undefined {
  if (line[start] !== "<") {
    return undefined;
  }

  const close = line.indexOf(">", start + 1);
  if (close === -1) {
    return undefined;
  }

  const body = line.slice(start + 1, close);
  if (/^(?:https?:\/\/|@|#|!)/.test(body)) {
    return { text: line.slice(start, close + 1), end: close + 1 };
  }

  return undefined;
}

function readMarkdownLink(
  line: string,
  start: number,
): { text: string; end: number } | undefined {
  if (line[start] !== "[") {
    return undefined;
  }

  const labelEnd = line.indexOf("](", start + 1);
  if (labelEnd === -1) {
    return undefined;
  }

  const destStart = labelEnd + 2;
  if (
    !line.startsWith("http://", destStart) &&
    !line.startsWith("https://", destStart)
  ) {
    return undefined;
  }

  const closeParens = line.indexOf(")", destStart);
  if (closeParens === -1) {
    return undefined;
  }

  return { text: line.slice(start, closeParens + 1), end: closeParens + 1 };
}

function hasUnmatchedClosingParen(text: string): boolean {
  let balance = 0;
  for (const ch of text) {
    if (ch === "(") balance++;
    else if (ch === ")") balance--;
  }
  return balance < 0;
}

function readBareUrl(
  line: string,
  start: number,
): { url: string; suffix: string; end: number } | undefined {
  let end = start;
  while (end < line.length) {
    const ch = line.charAt(end);
    if (
      /\s/.test(ch) ||
      ch === "<" ||
      ch === ">" ||
      ch === '"' ||
      ch === "`" ||
      ch === "|" ||
      ch === "*"
    ) {
      break;
    }
    end++;
  }

  if (end === start) {
    return undefined;
  }

  let raw = line.slice(start, end);
  let suffix = "";

  const peel = () => {
    suffix = raw.slice(-1) + suffix;
    raw = raw.slice(0, -1);
  };

  // Peel trailing non-URL chars in a single stable loop so mixed suffixes
  // (e.g. trailing `_` then `.`) are emitted in the correct order.
  const shouldPeel = (): boolean =>
    raw.endsWith("_") ||
    /[.,!?;:]$/.test(raw) ||
    (raw.endsWith(")") && hasUnmatchedClosingParen(raw));

  while (raw.length > 0 && shouldPeel()) {
    peel();
  }

  if (!/^https?:\/\/.+/.test(raw)) {
    return undefined;
  }

  return { url: raw, suffix, end };
}

// Slack user IDs start with U or W and contain a digit, so `@URGENT` stays text.
const BARE_SLACK_USER_ID_RE = /^@([UW](?=[A-Z0-9]*\d)[A-Z0-9]{8,})(?![\w])/;

function readBareSlackUserMention(
  line: string,
  start: number,
): { text: string; end: number } | undefined {
  if (line[start] !== "@" || /\w/.test(line[start - 1] ?? "")) {
    return undefined;
  }
  const match = BARE_SLACK_USER_ID_RE.exec(line.slice(start));
  if (!match) {
    return undefined;
  }
  return { text: `<@${match[1]}>`, end: start + match[0].length };
}

/**
 * Wrap bare http(s) URLs and bare `@U123` Slack user IDs on a single line as
 * Slack explicit `<url>` links and `<@U123>` mentions.
 */
function wrapBareReferencesOnLine(line: string): string {
  let result = "";
  let i = 0;

  while (i < line.length) {
    const codeSpan = readInlineCodeSpan(line, i);
    if (codeSpan) {
      result += codeSpan.text;
      i = codeSpan.end;
      continue;
    }

    const angleToken = readExistingSlackAngleToken(line, i);
    if (angleToken) {
      result += angleToken.text;
      i = angleToken.end;
      continue;
    }

    const mdLink = readMarkdownLink(line, i);
    if (mdLink) {
      result += mdLink.text;
      i = mdLink.end;
      continue;
    }

    const userMention = readBareSlackUserMention(line, i);
    if (userMention) {
      result += userMention.text;
      i = userMention.end;
      continue;
    }

    if (line.startsWith("https://", i) || line.startsWith("http://", i)) {
      const parsed = readBareUrl(line, i);
      if (parsed) {
        result += `<${parsed.url}>${parsed.suffix}`;
        i = parsed.end;
        continue;
      }
    }

    result += line[i];
    i++;
  }

  return result;
}

/**
 * Pre-wrap bare http(s) URLs outside fenced code blocks as Slack explicit
 * links, preventing Slack's auto-linker from consuming adjacent formatting
 * markers into the URL. Bare `@U123` user IDs become `<@U123>` mentions,
 * because Slack shows a bare ID as literal text.
 *
 * Uses the same fence-toggle rule as `ensureBlockSpacing` so both passes
 * agree on which lines are code.
 */
function wrapBareReferences(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      out.push(line);
      continue;
    }
    out.push(inCodeBlock ? line : wrapBareReferencesOnLine(line));
  }

  return out.join("\n");
}

const LIST_ITEM_RE = /^[ \t]*(?:[-*•]|\d+\.)[ \t]/;

/**
 * Turn a follow-up paragraph inside a list item into a bullet at the same
 * indent.
 *
 * Slack's `markdown` block keeps only one paragraph per list item. It joins
 * the other paragraphs to the top-level item's text with no space and renders
 * nested lists after them. As a bullet, the paragraph keeps its place and
 * nesting.
 */
function bulletListFollowUpParagraphs(text: string): string {
  const lines = text.split("\n");
  let inCodeBlock = false;
  let inList = false;

  for (const [i, line] of lines.entries()) {
    const trimmed = line.trimStart();
    const isFence = trimmed.startsWith("```");
    if (!inCodeBlock && trimmed && trimmed.length === line.length) {
      inList = LIST_ITEM_RE.test(line);
    } else if (
      !inCodeBlock &&
      inList &&
      trimmed &&
      !isFence &&
      lines[i - 1]?.trim() === "" &&
      !LIST_ITEM_RE.test(line)
    ) {
      lines[i] = `${line.slice(0, line.length - trimmed.length)}- ${trimmed}`;
    }
    if (isFence) {
      inCodeBlock = !inCodeBlock;
    }
  }

  return lines.join("\n");
}

/** Insert blank lines between content blocks so Slack renders them with visual separation. */
export function ensureBlockSpacing(text: string): string {
  const codeBlockPattern = /^```/;
  const listItemPattern = /^[-*•]\s|^\d+\.\s/;
  const lines = text.split("\n");
  const result: string[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
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
 * Normalize model-authored Slack markdown for delivery via `markdown_text`
 * or `{ type: "markdown" }` blocks.
 *
 * Plugins may first rewrite ordinary Markdown. Core then applies Slack-only
 * delivery shaping: bare URL wrapping, block spacing, and list follow-up
 * paragraph bullets. Slack reply delivery owns chunking and continuation
 * markers separately.
 */
export function normalizeSlackReplyMarkdown(text: string): string {
  let normalized = applyPluginFormatMarkdown(text)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "");
  normalized = wrapBareReferences(normalized);
  normalized = ensureBlockSpacing(normalized);
  normalized = bulletListFollowUpParagraphs(normalized);
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

/** Render a Slack user mention, which Slack shows as the person's name. */
export function slackMention(userId: string): string {
  return `<@${userId}>`;
}
