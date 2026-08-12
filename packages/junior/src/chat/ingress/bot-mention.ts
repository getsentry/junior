/**
 * Detect Slack bot @mentions that should activate Junior.
 *
 * Mentions inside inline code spans or fenced code blocks are display-only
 * references, so they must not count as activations. Slack can still deliver
 * `app_mention` for those tokens; callers must use this check for both
 * `message` and `app_mention` paths.
 */

function readInlineCodeSpanEnd(text: string, start: number): number | undefined {
  if (text[start] !== "`") {
    return undefined;
  }

  let n = 1;
  while (text[start + n] === "`") {
    n++;
  }

  const marker = "`".repeat(n);
  let search = start + n;

  while (search < text.length) {
    const close = text.indexOf(marker, search);
    if (close === -1) {
      return undefined;
    }
    const after = close + n;
    if (text[after] !== "`") {
      return after;
    }
    search = after + 1;
  }

  return undefined;
}

function lineMentionsBot(
  line: string,
  exactToken: string,
  labeledPrefix: string,
): boolean {
  let i = 0;
  while (i < line.length) {
    const spanEnd = readInlineCodeSpanEnd(line, i);
    if (spanEnd !== undefined) {
      i = spanEnd;
      continue;
    }

    if (line.startsWith(exactToken, i) || line.startsWith(labeledPrefix, i)) {
      return true;
    }

    i += 1;
  }

  return false;
}

function isFenceOpener(line: string): boolean {
  return line.trimStart().startsWith("```");
}

/** Closing fences are only backticks (3+) plus optional trailing space. */
function isFenceCloser(line: string): boolean {
  return /^`{3,}\s*$/.test(line.trimStart());
}

/**
 * When a line opens and closes a fence before the newline, return the text
 * after the closing fence. Otherwise return undefined.
 */
function singleLineFenceSuffix(line: string): string | undefined {
  const leadingWs = line.length - line.trimStart().length;
  const trimmed = line.slice(leadingWs);
  if (!trimmed.startsWith("```")) {
    return undefined;
  }

  let openLen = 3;
  while (trimmed[openLen] === "`") {
    openLen += 1;
  }

  // Find a closer of the same length; do not eat extra trailing backticks so
  // an immediately following inline-code opener stays in the suffix.
  const afterOpen = trimmed.slice(openLen);
  const closeRel = afterOpen.indexOf("`".repeat(openLen));
  if (closeRel === -1) {
    return undefined;
  }

  const end = leadingWs + openLen + closeRel + openLen;
  return line.slice(end);
}

/**
 * Return true when `text` contains a Slack bot mention token outside code.
 *
 * Slack encodes user mentions as `<@UXXXXXXXX>` or `<@UXXXXXXXX|label>`.
 * Fenced blocks open on a line-start ` ``` ` and close only on a pure fence
 * closer (backticks alone). Nested fence markers like ` ```js ` inside an
 * open block stay in code. Mid-line multi-backtick spans are inline code.
 * Text after a same-line fence close is still scanned for mentions.
 */
export function textMentionsBot(text: string, botUserId: string): boolean {
  if (!botUserId || !text) {
    return false;
  }

  const exactToken = `<@${botUserId}>`;
  const labeledPrefix = `<@${botUserId}|`;
  let inCodeBlock = false;

  for (const line of text.split("\n")) {
    if (inCodeBlock) {
      // Only a pure closer exits; ```js inside the block stays in code.
      if (isFenceCloser(line)) {
        inCodeBlock = false;
      }
      continue;
    }

    if (isFenceOpener(line)) {
      const suffix = singleLineFenceSuffix(line);
      if (suffix !== undefined) {
        // Closed on this line; only post-fence text can activate.
        if (lineMentionsBot(suffix, exactToken, labeledPrefix)) {
          return true;
        }
      } else {
        inCodeBlock = true;
      }
      continue;
    }

    if (lineMentionsBot(line, exactToken, labeledPrefix)) {
      return true;
    }
  }

  return false;
}
