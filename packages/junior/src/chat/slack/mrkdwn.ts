import { truncateStatusText } from "@/chat/slack/status-format";

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
    const ch = line[end];
    if (/\s/.test(ch) || ch === "<" || ch === ">" || ch === '"' || ch === "`") {
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

  // Peel trailing emphasis markers — these are the core bug trigger.
  while (raw.endsWith("*") || raw.endsWith("_")) {
    peel();
  }

  // Peel trailing sentence punctuation.
  while (/[.,!?;:]$/.test(raw)) {
    peel();
  }

  // Peel unmatched closing parens, preserve balanced URL parens.
  while (raw.endsWith(")") && hasUnmatchedClosingParen(raw)) {
    peel();
  }

  if (!/^https?:\/\/.+/.test(raw)) {
    return undefined;
  }

  return { url: raw, suffix, end };
}

/** Wrap bare http(s) URLs on a single line as Slack explicit `<url>` links. */
function wrapBareUrlsOnLine(line: string): string {
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
 * Apply a line transform to every line outside backtick-fenced code blocks.
 * Fenced lines are emitted unchanged.
 */
function transformOutsideFences(
  text: string,
  transformLine: (line: string) => string,
): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inFence = false;
  let fenceLength = 0;

  for (const line of lines) {
    const trimmed = line.trimStart();

    if (!inFence) {
      const openMatch = trimmed.match(/^(`{3,})/);
      if (openMatch) {
        inFence = true;
        fenceLength = openMatch[1].length;
        out.push(line);
        continue;
      }
      out.push(transformLine(line));
      continue;
    }

    out.push(line);
    const closeMatch = trimmed.match(/^(`{3,})\s*$/);
    if (closeMatch && closeMatch[1].length >= fenceLength) {
      inFence = false;
      fenceLength = 0;
    }
  }

  return out.join("\n");
}

/**
 * Pre-wrap bare http(s) URLs outside fenced code blocks as Slack explicit
 * links, preventing Slack's auto-linker from consuming adjacent formatting
 * markers into the URL.
 */
function wrapBareUrls(text: string): string {
  return transformOutsideFences(text, wrapBareUrlsOnLine);
}

function convertBoldInPlain(text: string): string {
  return text.replace(/\*\*([^*\n]+)\*\*/g, "*$1*");
}

/**
 * Convert a single non-fenced line from CommonMark to Slack mrkdwn for use
 * as notification fallback text.
 *
 * Two passes: bold conversion first so `**...[link](url)...**` spans are
 * seen whole, then link conversion on the result.
 */
function toSlackMrkdwnFallbackLine(line: string): string {
  // Pass 1: convert **bold** → *bold* outside protected spans.
  let withBold = "";
  let i = 0;
  let plainStart = 0;

  while (i < line.length) {
    const codeSpan = readInlineCodeSpan(line, i);
    if (codeSpan) {
      withBold += convertBoldInPlain(line.slice(plainStart, i)) + codeSpan.text;
      i = codeSpan.end;
      plainStart = i;
      continue;
    }
    const angleToken = readExistingSlackAngleToken(line, i);
    if (angleToken) {
      withBold +=
        convertBoldInPlain(line.slice(plainStart, i)) + angleToken.text;
      i = angleToken.end;
      plainStart = i;
      continue;
    }
    i++;
  }
  withBold += convertBoldInPlain(line.slice(plainStart));

  // Pass 2: convert [label](url) → <url|label> outside protected spans.
  let result = "";
  i = 0;
  plainStart = 0;

  while (i < withBold.length) {
    const codeSpan = readInlineCodeSpan(withBold, i);
    if (codeSpan) {
      result += withBold.slice(plainStart, i) + codeSpan.text;
      i = codeSpan.end;
      plainStart = i;
      continue;
    }
    const angleToken = readExistingSlackAngleToken(withBold, i);
    if (angleToken) {
      result += withBold.slice(plainStart, i) + angleToken.text;
      i = angleToken.end;
      plainStart = i;
      continue;
    }
    const mdLink = readMarkdownLink(withBold, i);
    if (mdLink) {
      result += withBold.slice(plainStart, i);
      const labelCloseIdx = mdLink.text.indexOf("](");
      const label = mdLink.text.slice(1, labelCloseIdx);
      const url = mdLink.text.slice(labelCloseIdx + 2, -1);
      result += `<${url}|${label}>`;
      i = mdLink.end;
      plainStart = i;
      continue;
    }
    i++;
  }
  result += withBold.slice(plainStart);
  return result;
}

/** Insert blank lines between content blocks so Slack renders them with visual separation. */
export function ensureBlockSpacing(text: string): string {
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
 * Normalize model-authored Slack markdown for delivery via `markdown_text`
 * or `{ type: "markdown" }` blocks.
 *
 * Pre-wraps bare URLs as Slack explicit links to prevent Slack's auto-linker
 * from consuming adjacent formatting markers. Slack reply delivery owns
 * chunking and continuation markers separately.
 */
export function normalizeSlackReplyMarkdown(text: string): string {
  let normalized = text.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "");
  normalized = wrapBareUrls(normalized);
  normalized = ensureBlockSpacing(normalized);
  return normalized.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Convert a CommonMark reply text to mrkdwn-compatible fallback text for
 * the top-level Slack `text` field when posting with blocks.
 *
 * The `text` field is rendered by Slack as legacy mrkdwn (notifications,
 * screen readers, fallback clients). CommonMark `**bold**` and `[label](url)`
 * do not render correctly there, so this converts them to mrkdwn equivalents.
 * Inline code spans, fenced code blocks, and existing Slack angle tokens are
 * preserved unchanged.
 */
export function toSlackMrkdwnFallback(text: string): string {
  return transformOutsideFences(text, toSlackMrkdwnFallbackLine);
}

/** Normalize assistant status text before handing it to Slack. */
export function normalizeSlackStatusText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  return truncateStatusText(trimmed.replace(/(?:\.\s*)+$/, "").trim());
}
