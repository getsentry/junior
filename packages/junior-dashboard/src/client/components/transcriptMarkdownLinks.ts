import type { DecorationItem } from "shiki/bundle/web";

export const TRANSCRIPT_ANCHOR_CLASS =
  "font-medium text-[#d8ccff] underline decoration-[#beaaff]/45 underline-offset-2 transition-colors hover:text-white hover:decoration-white";

export type TranscriptMarkdownLink = {
  end: number;
  href: string;
  label: string;
  start: number;
};

type TextRange = {
  end: number;
  start: number;
};

/** Find safe markdown and bare links that should become transcript anchors. */
export function findTranscriptMarkdownLinks(
  text: string,
): TranscriptMarkdownLink[] {
  const literalRanges = findLiteralRanges(text);
  const markdownLinks = findMarkdownLinks(text, literalRanges);
  const bareRanges = mergeRanges([
    ...literalRanges,
    ...findMarkdownLinkSyntaxRanges(text, literalRanges),
  ]);
  return [...markdownLinks, ...findBareLinks(text, bareRanges)].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
}

/** Build Shiki decorations for safe transcript markdown and bare links. */
export function buildTranscriptMarkdownDecorations(
  links: TranscriptMarkdownLink[],
): DecorationItem[] {
  return links.map((link) => {
    const opensNewTab = /^https?:/i.test(link.href);
    return {
      end: link.end,
      properties: {
        class: TRANSCRIPT_ANCHOR_CLASS,
        href: link.href,
        ...(opensNewTab ? { rel: "noreferrer", target: "_blank" } : {}),
      },
      start: link.start,
      tagName: "a",
      transform(element) {
        element.children = [{ type: "text", value: link.label }];
      },
    };
  });
}

function findMarkdownLinks(
  text: string,
  ignoredRanges: TextRange[],
): TranscriptMarkdownLink[] {
  const links: TranscriptMarkdownLink[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const link = findNextMarkdownLink(text, cursor, ignoredRanges);
    if (!link) break;
    links.push(link);
    cursor = link.end;
  }
  return links;
}

function findNextMarkdownLink(
  text: string,
  start: number,
  ignoredRanges: TextRange[],
): TranscriptMarkdownLink | undefined {
  for (
    let linkStart = text.indexOf("[", start);
    linkStart >= 0;
    linkStart = text.indexOf("[", linkStart + 1)
  ) {
    if (isInRange(linkStart, ignoredRanges) || isEscaped(text, linkStart)) {
      continue;
    }

    const labelEnd = text.indexOf("]", linkStart + 1);
    if (labelEnd < 0) return undefined;
    if (text[labelEnd + 1] !== "(") continue;

    const label = text.slice(linkStart + 1, labelEnd);
    if (!isMarkdownLinkLabel(label)) continue;

    const destination = readMarkdownDestination(text, labelEnd + 2);
    if (!destination) continue;

    const href = safeMarkdownDestinationHref(destination.href);
    if (!href) continue;

    return {
      end: destination.end,
      href,
      label,
      start: linkStart,
    };
  }
}

function findMarkdownLinkSyntaxRanges(
  text: string,
  ignoredRanges: TextRange[],
): TextRange[] {
  const ranges: TextRange[] = [];
  for (
    let linkStart = text.indexOf("[");
    linkStart >= 0;
    linkStart = text.indexOf("[", linkStart + 1)
  ) {
    if (isInRange(linkStart, ignoredRanges) || isEscaped(text, linkStart)) {
      continue;
    }

    const labelEnd = text.indexOf("]", linkStart + 1);
    if (labelEnd < 0) continue;
    if (text[labelEnd + 1] !== "(") continue;

    const label = text.slice(linkStart + 1, labelEnd);
    if (!isMarkdownLinkLabel(label)) continue;

    const destination = readMarkdownDestination(text, labelEnd + 2);
    if (!destination) continue;

    ranges.push({ start: linkStart, end: destination.end });
  }
  return ranges;
}

function isMarkdownLinkLabel(label: string): boolean {
  return Boolean(label) && !label.includes("\n") && !label.includes("[");
}

function readMarkdownDestination(
  text: string,
  start: number,
): { end: number; href: string } | undefined {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char !== ")") continue;

    if (depth > 0) {
      depth -= 1;
      continue;
    }

    const href = text.slice(start, index);
    return href ? { end: index + 1, href } : undefined;
  }
}

function findNextBareLink(
  text: string,
  start: number,
  ignoredRanges: TextRange[],
): TranscriptMarkdownLink | undefined {
  const bareUrlPattern = /(https?:\/\/[^\s<>"']+|mailto:[^\s<>"']+)/gi;
  bareUrlPattern.lastIndex = start;

  let match: RegExpExecArray | null;
  while ((match = bareUrlPattern.exec(text))) {
    if (isInRange(match.index, ignoredRanges)) continue;

    const bareLink = trimBareUrl(match[0]);
    const href = safeLinkHref(bareLink);
    if (!href) continue;

    return {
      end: match.index + bareLink.length,
      href,
      label: href,
      start: match.index,
    };
  }
}

function findBareLinks(
  text: string,
  ignoredRanges: TextRange[],
): TranscriptMarkdownLink[] {
  const links: TranscriptMarkdownLink[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const link = findNextBareLink(text, cursor, ignoredRanges);
    if (!link) break;
    links.push(link);
    cursor = link.end;
  }
  return links;
}

function findLiteralRanges(text: string): TextRange[] {
  return [...findInlineCodeRanges(text), ...findEscapedMarkdownLinkRanges(text)]
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
}

function findInlineCodeRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "`" || isEscaped(text, index)) continue;

    const ticks = countRun(text, index, "`");
    const closing = findClosingBacktickRun(text, index + ticks, ticks);
    if (closing < 0) {
      index += ticks - 1;
      continue;
    }

    ranges.push({ start: index, end: closing + ticks });
    index = closing + ticks - 1;
  }
  return ranges;
}

function findClosingBacktickRun(
  text: string,
  start: number,
  ticks: number,
): number {
  for (let index = start; index < text.length; index += 1) {
    if (text[index] !== "`" || isEscaped(text, index)) continue;

    const run = countRun(text, index, "`");
    if (run === ticks) return index;
    index += run - 1;
  }
  return -1;
}

function findEscapedMarkdownLinkRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  for (
    let linkStart = text.indexOf("[");
    linkStart >= 0;
    linkStart = text.indexOf("[", linkStart + 1)
  ) {
    if (!isEscaped(text, linkStart)) continue;

    const labelEnd = text.indexOf("]", linkStart + 1);
    if (labelEnd < 0) continue;
    if (text[labelEnd + 1] !== "(") continue;

    const destination = readMarkdownDestination(text, labelEnd + 2);
    if (!destination) continue;

    ranges.push({ start: linkStart, end: destination.end });
  }
  return ranges;
}

function isInRange(index: number, ranges: TextRange[]): boolean {
  for (const range of ranges) {
    if (index < range.start) return false;
    if (index >= range.start && index < range.end) return true;
  }
  return false;
}

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (
    let cursor = index - 1;
    cursor >= 0 && text[cursor] === "\\";
    cursor -= 1
  ) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function countRun(text: string, start: number, char: string): number {
  let count = 0;
  for (
    let index = start;
    index < text.length && text[index] === char;
    index += 1
  ) {
    count += 1;
  }
  return count;
}

function safeMarkdownDestinationHref(destination: string): string | undefined {
  const href = readMarkdownHref(destination);
  return href ? safeLinkHref(href) : undefined;
}

function readMarkdownHref(destination: string): string | undefined {
  const trimmed = destination.trim();
  const match =
    /^(<[^>\n]+>|[^\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?$/.exec(trimmed);
  const href = match?.[1];
  if (!href) return undefined;
  return href.startsWith("<") && href.endsWith(">") ? href.slice(1, -1) : href;
}

function safeLinkHref(href: string): string | undefined {
  const trimmed = href.trim();
  if (!trimmed || /[\u0000-\u001f\u007f\s]/.test(trimmed)) return undefined;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" ||
      url.protocol === "https:" ||
      url.protocol === "mailto:"
      ? trimmed
      : undefined;
  } catch {
    return undefined;
  }
}

function trimBareUrl(href: string): string {
  let trimmed = href;

  while (shouldTrimBareUrlSuffix(trimmed)) {
    trimmed = trimmed.slice(0, -1);
  }

  return trimmed;
}

function shouldTrimBareUrlSuffix(href: string): boolean {
  const last = href.at(-1);
  if (!last) return false;
  if (/[.,;:!?]/.test(last)) return true;
  return last === ")" && closingParensExceedOpening(href);
}

function closingParensExceedOpening(value: string): boolean {
  let balance = 0;
  for (const char of value) {
    if (char === "(") balance += 1;
    if (char === ")") balance -= 1;
  }
  return balance < 0;
}

function mergeRanges(ranges: TextRange[]): TextRange[] {
  const sorted = ranges
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: TextRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (!previous || range.start > previous.end) {
      merged.push({ ...range });
      continue;
    }
    previous.end = Math.max(previous.end, range.end);
  }
  return merged;
}
