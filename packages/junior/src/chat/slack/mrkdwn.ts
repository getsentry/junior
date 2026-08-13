import { truncateStatusText } from "@/chat/slack/status-format";

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

const GITHUB_OWNER_PATTERN = "[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?";
const GITHUB_REPO_PATTERN = "[A-Za-z0-9._-]+";
const GITHUB_REPO_ISSUE_REF_PATTERN = new RegExp(
  `^(${GITHUB_OWNER_PATTERN})\\/(${GITHUB_REPO_PATTERN})#(\\d+)\\b`,
);

function isGitHubRefBoundary(char: string | undefined): boolean {
  return char === undefined || !/[A-Za-z0-9._-]/.test(char);
}

/**
 * Read an unambiguous `owner/repo#number` reference.
 *
 * Uses the issues URL because GitHub serves both issues and pull requests there
 * and redirects pull requests to `/pull/number`.
 */
function readGitHubRepoIssueRef(
  line: string,
  start: number,
): { text: string; end: number; url: string } | undefined {
  if (!isGitHubRefBoundary(start === 0 ? undefined : line[start - 1])) {
    return undefined;
  }

  const match = GITHUB_REPO_ISSUE_REF_PATTERN.exec(line.slice(start));
  if (!match) {
    return undefined;
  }

  const [text, owner, repo, number] = match;
  return {
    text,
    end: start + text.length,
    url: `https://github.com/${owner}/${repo}/issues/${number}`,
  };
}

function readBareUrl(
  line: string,
  start: number,
): { url: string; suffix: string; end: number } | undefined {
  let end = start;
  while (end < line.length) {
    const ch = line[end];
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

/**
 * Wrap bare http(s) URLs and unambiguous GitHub `owner/repo#number` refs on one
 * line. URLs become Slack explicit `<url>` links. Repo refs become Markdown
 * links so destination-visible replies always carry a clickable target.
 */
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

    const repoIssueRef = readGitHubRepoIssueRef(line, i);
    if (repoIssueRef) {
      result += `[${repoIssueRef.text}](${repoIssueRef.url})`;
      i = repoIssueRef.end;
      continue;
    }

    result += line[i];
    i++;
  }

  return result;
}

/**
 * Pre-wrap bare http(s) URLs and unambiguous GitHub `owner/repo#number` refs
 * outside fenced code blocks. URLs become Slack explicit links so Slack's
 * auto-linker does not consume adjacent formatting markers. Repo refs become
 * Markdown links so destination-visible replies keep a clickable target.
 *
 * Uses the same fence-toggle rule as `ensureBlockSpacing` so both passes
 * agree on which lines are code.
 */
function wrapBareUrls(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      out.push(line);
      continue;
    }
    out.push(inCodeBlock ? line : wrapBareUrlsOnLine(line));
  }

  return out.join("\n");
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
 * from consuming adjacent formatting markers. Also turns unambiguous GitHub
 * `owner/repo#number` mentions into Markdown links. Slack reply delivery owns
 * chunking and continuation markers separately.
 */
export function normalizeSlackReplyMarkdown(text: string): string {
  let normalized = text.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "");
  normalized = wrapBareUrls(normalized);
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
