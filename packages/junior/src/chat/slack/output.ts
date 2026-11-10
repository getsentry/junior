import { isTableRow, normalizeSlackReplyMarkdown } from "@/chat/slack/mrkdwn";

// Slack recommends at most 4,000 characters of message text, and all markdown
// blocks in one payload share a 12,000 character limit.
const MAX_INLINE_CHARS = 4000;

type FenceContinuation = {
  closeSuffix: string;
  reopenPrefix: string;
};

function getFenceContinuation(text: string): FenceContinuation | null {
  let open:
    | {
        fence: string;
        openerLine: string;
      }
    | undefined;

  for (const line of text.split("\n")) {
    const trimmed = line.trimStart();
    const openerMatch = trimmed.match(/^(`{3,}|~{3,})(.*)$/);
    if (!openerMatch?.[1]) {
      continue;
    }

    if (!open) {
      open = {
        fence: openerMatch[1],
        openerLine: trimmed,
      };
      continue;
    }

    if (new RegExp(`^${open.fence}\\s*$`).test(trimmed)) {
      open = undefined;
    }
  }

  if (!open) {
    return null;
  }

  return {
    closeSuffix: text.endsWith("\n") ? open.fence : `\n${open.fence}`,
    reopenPrefix: `${open.openerLine}\n`,
  };
}

function findSplitIndex(text: string, maxChars: number): number {
  const bounded = text.slice(0, maxChars);
  const newlineIndex = bounded.lastIndexOf("\n");
  if (newlineIndex > 0) {
    return newlineIndex;
  }

  const spaceIndex = bounded.lastIndexOf(" ");
  if (spaceIndex > 0) {
    return spaceIndex;
  }

  return maxChars;
}

function takePrefix(
  text: string,
  maxChars: number,
): { prefix: string; rest: string } {
  const prefix =
    text.slice(0, findSplitIndex(text, maxChars)).trimEnd() ||
    text.slice(0, maxChars);
  return { prefix, rest: text.slice(prefix.length).trimStart() };
}

/**
 * Keep a pipe table readable when a split lands inside it. Each post renders
 * on its own, so rows without the header and delimiter rows show as text.
 * Move a table that starts mid-post to the next post. Repeat the header rows
 * when one table is longer than a post.
 */
function splitOutsideTable(
  prefix: string,
  rest: string,
): { chunk: string; rest: string } {
  const lines = prefix.split("\n");
  if (!isTableRow(lines.at(-1) ?? "") || !isTableRow(rest)) {
    return { chunk: prefix, rest };
  }

  let start = lines.length - 1;
  while (start > 0 && isTableRow(lines[start - 1] ?? "")) {
    start--;
  }
  const before = lines.slice(0, start).join("\n").trimEnd();
  const table = lines.slice(start);
  if (before) {
    return { chunk: before, rest: `${table.join("\n")}\n${rest}` };
  }
  // Repeat the header only when this post also has data rows, so every post
  // moves the reply forward.
  if (table.length <= 2) {
    return { chunk: prefix, rest };
  }
  return { chunk: prefix, rest: `${table.slice(0, 2).join("\n")}\n${rest}` };
}

/** Take one post that fits the budget, closing a code fence it leaves open. */
function takeChunk(text: string): { chunk: string; rest: string } {
  let { prefix, rest } = takePrefix(text, MAX_INLINE_CHARS);
  let carryover = getFenceContinuation(prefix);
  if (!carryover) {
    return splitOutsideTable(prefix, rest);
  }

  ({ prefix, rest } = takePrefix(
    text,
    MAX_INLINE_CHARS - carryover.closeSuffix.length,
  ));
  carryover = getFenceContinuation(prefix);
  if (!carryover || !rest) {
    return { chunk: prefix, rest };
  }

  return {
    chunk: `${prefix}${carryover.closeSuffix}`,
    rest: `${carryover.reopenPrefix}${rest}`,
  };
}

/** Split a normalized Slack reply into thread posts that fit Slack limits. */
export function splitSlackReplyText(text: string): string[] {
  const chunks: string[] = [];
  let remaining = normalizeSlackReplyMarkdown(text);
  while (remaining.length > MAX_INLINE_CHARS) {
    const { chunk, rest } = takeChunk(remaining);
    chunks.push(chunk);
    remaining = rest;
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}

export const slackOutputPolicy = {
  maxInlineChars: MAX_INLINE_CHARS,
};
