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

  // Triple-or-longer markers belong to fenced blocks, not inline spans.
  if (n >= 3) {
    return undefined;
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

function readFencedCodeBlockEnd(text: string, start: number): number | undefined {
  if (!text.startsWith("```", start)) {
    return undefined;
  }

  const close = text.indexOf("```", start + 3);
  if (close === -1) {
    // Unclosed fence: treat the remainder as code.
    return text.length;
  }
  return close + 3;
}

/**
 * Return true when `text` contains a Slack bot mention token outside code.
 *
 * Slack encodes user mentions as `<@UXXXXXXXX>` or `<@UXXXXXXXX|label>`.
 */
export function textMentionsBot(text: string, botUserId: string): boolean {
  if (!botUserId || !text) {
    return false;
  }

  const exactToken = `<@${botUserId}>`;
  const labeledPrefix = `<@${botUserId}|`;
  let i = 0;

  while (i < text.length) {
    const fenceEnd = readFencedCodeBlockEnd(text, i);
    if (fenceEnd !== undefined) {
      i = fenceEnd;
      continue;
    }

    const spanEnd = readInlineCodeSpanEnd(text, i);
    if (spanEnd !== undefined) {
      i = spanEnd;
      continue;
    }

    if (text.startsWith(exactToken, i) || text.startsWith(labeledPrefix, i)) {
      return true;
    }

    i += 1;
  }

  return false;
}
