/**
 * Detect Slack bot @mentions that should activate Junior.
 *
 * Mentions inside inline code or fenced code blocks are display-only
 * references. Slack can still deliver `app_mention` for those tokens, so
 * both `message` and `app_mention` paths must use this check.
 */

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Strip matching inline backtick spans from one line of prose. */
function stripInlineCode(line: string): string {
  return line.replace(/(`+)(?:(?!\1)[^\n])*\1/g, " ");
}

/** Length of the leading backtick run on a line-start fence marker. */
function fenceMarkerLength(trimmed: string): number {
  let n = 0;
  while (trimmed[n] === "`") {
    n += 1;
  }
  return n;
}

/**
 * If a fence opens and closes on this line, return the text after the close.
 * Mid-line ``` is not a fence opener; only line-start markers count.
 */
function singleLineFenceSuffix(trimmed: string): string | undefined {
  const openLen = fenceMarkerLength(trimmed);
  if (openLen < 3) {
    return undefined;
  }
  const afterOpen = trimmed.slice(openLen);
  const closeRel = afterOpen.indexOf("`".repeat(openLen));
  if (closeRel === -1) {
    return undefined;
  }
  return afterOpen.slice(closeRel + openLen);
}

/**
 * Remove fenced blocks and inline code so only active prose remains.
 *
 * Fences follow Slack mrkdwn (`mrkdwn.ts`): a line that starts with ``` opens
 * or closes a block. Text after a closing marker stays active. Mid-line
 * triple backticks are not fences.
 */
function textOutsideCode(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inFence = false;

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```")) {
      if (inFence) {
        // Same rule as Slack mrkdwn: line-start ``` closes the fence. Keep any
        // trailing prose after the marker so real mentions still activate.
        inFence = false;
        const suffix = trimmed.slice(fenceMarkerLength(trimmed));
        if (suffix.length > 0) {
          out.push(stripInlineCode(suffix));
        }
        continue;
      }
      const suffix = singleLineFenceSuffix(trimmed);
      if (suffix !== undefined) {
        out.push(stripInlineCode(suffix));
        continue;
      }
      inFence = true;
      continue;
    }
    if (inFence) {
      continue;
    }
    out.push(stripInlineCode(line));
  }

  return out.join("\n");
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

  const outside = textOutsideCode(text);
  const id = escapeRegExp(botUserId);
  return new RegExp(`<@${id}(?:\\|[^>]+)?>`).test(outside);
}
