const GITHUB_OWNER_PATTERN = "[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?";
const GITHUB_REPOSITORY_PATTERN = "[A-Za-z0-9._-]+";
const GITHUB_ISSUE_REFERENCE_PATTERN = new RegExp(
  `^(${GITHUB_OWNER_PATTERN})\\/(${GITHUB_REPOSITORY_PATTERN})#(\\d+)\\b`,
);

const GITHUB_CLOSING_KEYWORD_PATTERN =
  /(?:^|[^A-Za-z0-9_])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+$/i;

function isReferenceBoundary(char: string | undefined): boolean {
  return char === undefined || !/[A-Za-z0-9._-]/.test(char);
}

function readInlineCode(text: string, start: number): number | undefined {
  if (text[start] !== "`") {
    return undefined;
  }
  let markerLength = 1;
  while (text[start + markerLength] === "`") {
    markerLength++;
  }
  const marker = "`".repeat(markerLength);
  const end = text.indexOf(marker, start + markerLength);
  return end === -1 ? undefined : end + markerLength;
}

/** Read a fenced code opener/closer length of three or more backticks. */
function readFenceLength(line: string): number | undefined {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith("```")) {
    return undefined;
  }
  let length = 0;
  while (trimmed[length] === "`") {
    length++;
  }
  return length >= 3 ? length : undefined;
}

/**
 * Skip one existing Markdown link.
 *
 * Labels must not contain brackets or newlines so a bare earlier `[` cannot bind
 * to a later real link. Destinations may be absolute or relative.
 */
function readMarkdownLink(text: string, start: number): number | undefined {
  if (text[start] !== "[") {
    return undefined;
  }

  const labelEnd = text.indexOf("](", start + 1);
  if (labelEnd === -1) {
    return undefined;
  }

  const label = text.slice(start + 1, labelEnd);
  if (label.includes("[") || label.includes("]") || label.includes("\n")) {
    return undefined;
  }

  const destStart = labelEnd + 2;
  const closeParens = text.indexOf(")", destStart);
  return closeParens === -1 ? undefined : closeParens + 1;
}

function readAngleToken(text: string, start: number): number | undefined {
  if (text[start] !== "<") {
    return undefined;
  }
  const end = text.indexOf(">", start + 1);
  return end === -1 ? undefined : end + 1;
}

function linkifyLine(line: string, keepClosingReferences: boolean): string {
  let output = "";
  let index = 0;

  while (index < line.length) {
    const codeEnd = readInlineCode(line, index);
    if (codeEnd !== undefined) {
      output += line.slice(index, codeEnd);
      index = codeEnd;
      continue;
    }

    const markdownLinkEnd = readMarkdownLink(line, index);
    if (markdownLinkEnd !== undefined) {
      output += line.slice(index, markdownLinkEnd);
      index = markdownLinkEnd;
      continue;
    }

    const angleTokenEnd = readAngleToken(line, index);
    if (angleTokenEnd !== undefined) {
      output += line.slice(index, angleTokenEnd);
      index = angleTokenEnd;
      continue;
    }

    if (
      line.startsWith("https://", index) ||
      line.startsWith("http://", index)
    ) {
      const match = /^https?:\/\/\S+/.exec(line.slice(index));
      if (match) {
        output += match[0];
        index += match[0].length;
        continue;
      }
    }

    if (isReferenceBoundary(index === 0 ? undefined : line[index - 1])) {
      const match = GITHUB_ISSUE_REFERENCE_PATTERN.exec(line.slice(index));
      if (
        match &&
        !(
          keepClosingReferences &&
          GITHUB_CLOSING_KEYWORD_PATTERN.test(line.slice(0, index))
        )
      ) {
        const [reference, owner, repository, number] = match;
        output += `[${reference}](https://github.com/${owner}/${repository}/issues/${number})`;
        index += reference.length;
        continue;
      }
    }

    output += line[index];
    index++;
  }

  return output;
}

function linkify(text: string, keepClosingReferences: boolean): string {
  let openFenceLength = 0;
  return text
    .split("\n")
    .map((line) => {
      const fenceLength = readFenceLength(line);
      if (fenceLength !== undefined) {
        if (openFenceLength === 0) {
          openFenceLength = fenceLength;
        } else if (fenceLength >= openFenceLength) {
          openFenceLength = 0;
        }
        return line;
      }
      return openFenceLength > 0
        ? line
        : linkifyLine(line, keepClosingReferences);
    })
    .join("\n");
}

/** Linkify GitHub issue and pull request shorthand outside Markdown code. */
export function linkifyGitHubReferences(text: string): string {
  return linkify(text, false);
}

/**
 * Linkify shorthand in a GitHub body, but keep closing references such as
 * `Fixes owner/repo#1` bare so GitHub still links and closes the issue.
 *
 * A repository autolink prefix such as `SENTRY-` can claim part of bare
 * `getsentry/sentry-docs#1` and link the rest as a same-repository reference.
 * GitHub does not rewrite Markdown link labels.
 */
export function linkifyGitHubBodyReferences(text: string): string {
  return linkify(text, true);
}
