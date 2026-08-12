/**
 * Detect Slack bot @mentions that should activate Junior.
 *
 * Mentions inside inline code or fenced code blocks are display-only
 * references. Slack can still deliver `app_mention` for those tokens, so
 * both `message` and `app_mention` paths must use this check.
 */

/** Remove fenced blocks and inline code so only active prose remains. */
function textOutsideCode(text: string): string {
  // Closed fences first, then an unclosed opener through end-of-text.
  let outside = text.replace(/```[\s\S]*?```/g, " ");
  outside = outside.replace(/```[\s\S]*$/g, " ");
  // Inline spans: one or more backticks, matching closer, no newlines.
  outside = outside.replace(/(`+)(?:(?!\1)[^\n])*\1/g, " ");
  return outside;
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
  return (
    outside.includes(`<@${botUserId}>`) ||
    outside.includes(`<@${botUserId}|`)
  );
}
