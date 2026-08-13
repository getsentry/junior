const GITHUB_OWNER_PATTERN = "[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?";
const GITHUB_REPOSITORY_PATTERN = "[A-Za-z0-9._-]+";
const GITHUB_ISSUE_REFERENCE_PATTERN = new RegExp(
  `^(${GITHUB_OWNER_PATTERN})\\/(${GITHUB_REPOSITORY_PATTERN})#(\\d+)\\b`,
);

function isReferenceBoundary(char: string | undefined): boolean {
  return char === undefined || !/[A-Za-z0-9._-]/.test(char);
}

function readDelimitedText(
  text: string,
  start: number,
  open: string,
  close: string,
): number | undefined {
  if (!text.startsWith(open, start)) {
    return undefined;
  }
  const end = text.indexOf(close, start + open.length);
  return end === -1 ? undefined : end + close.length;
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

function linkifyLine(line: string): string {
  let output = "";
  let index = 0;

  while (index < line.length) {
    const codeEnd = readInlineCode(line, index);
    if (codeEnd !== undefined) {
      output += line.slice(index, codeEnd);
      index = codeEnd;
      continue;
    }

    const markdownLinkEnd = readDelimitedText(line, index, "[", ")");
    if (
      markdownLinkEnd !== undefined &&
      line.slice(index, markdownLinkEnd).includes("](")
    ) {
      output += line.slice(index, markdownLinkEnd);
      index = markdownLinkEnd;
      continue;
    }

    const slackTokenEnd = readDelimitedText(line, index, "<", ">");
    if (slackTokenEnd !== undefined) {
      output += line.slice(index, slackTokenEnd);
      index = slackTokenEnd;
      continue;
    }

    if (line.startsWith("https://", index) || line.startsWith("http://", index)) {
      const match = /^https?:\/\/\S+/.exec(line.slice(index));
      if (match) {
        output += match[0];
        index += match[0].length;
        continue;
      }
    }

    if (isReferenceBoundary(index === 0 ? undefined : line[index - 1])) {
      const match = GITHUB_ISSUE_REFERENCE_PATTERN.exec(line.slice(index));
      if (match) {
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

/** Linkify GitHub issue and pull request shorthand outside Markdown code. */
export function linkifyGitHubReferences(text: string): string {
  let inCodeBlock = false;
  return text
    .split("\n")
    .map((line) => {
      if (line.trimStart().startsWith("```")) {
        inCodeBlock = !inCodeBlock;
        return line;
      }
      return inCodeBlock ? line : linkifyLine(line);
    })
    .join("\n");
}
