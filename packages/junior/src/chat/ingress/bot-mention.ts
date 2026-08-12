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

/** True when a line opens a fence and also closes it before the newline. */
function isSingleLineFence(line: string): boolean {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith("```")) {
    return false;
  }
  return trimmed.slice(3).includes("```");
}

/**
 * Return true when `text` contains a Slack bot mention token outside code.
 *
 * Slack encodes user mentions as `<@UXXXXXXXX>` or `<@UXXXXXXXX|label>`.
 * Fenced blocks use line-start ` ``` ` toggles, matching Slack mrkdwn helpers,
 * except a line that both opens and closes a fence stays out of block state.
 * Nested or mid-line multi-backtick spans on non-fence lines are inline code.
 */
export function textMentionsBot(text: string, botUserId: string): boolean {
  if (!botUserId || !text) {
    return false;
  }

  const exactToken = `<@${botUserId}>`;
  const labeledPrefix = `<@${botUserId}|`;
  let inCodeBlock = false;

  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("```")) {
      if (inCodeBlock) {
        inCodeBlock = false;
        continue;
      }
      // Opening fence that also closes on this line never leaves us stuck.
      if (!isSingleLineFence(line)) {
        inCodeBlock = true;
      }
      continue;
    }
    if (inCodeBlock) {
      continue;
    }
    if (lineMentionsBot(line, exactToken, labeledPrefix)) {
      return true;
    }
  }

  return false;
}
