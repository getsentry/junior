import type { PostableMessage } from "chat";
import { getInterruptionMarker } from "@/chat/interruption-marker";
import { normalizeSlackReplyMarkdown } from "@/chat/slack/mrkdwn";

// Readability budget, measured on the text people see. Link URLs do not count.
const MAX_INLINE_CHARS = 2200;
const MAX_INLINE_LINES = 45;
// Slack limit for the raw source of all markdown blocks in one message.
const MAX_MARKDOWN_BLOCK_CHARS = 12000;
const CONTINUED_MARKER = "\n\n[Continued below]";
// Markdown links `[label](url)` and Slack links `<url|label>`. Slack shows only the label.
const LABELED_LINK_RE = /\[([^\]\n]*)\]\([^)\s]+\)|<[^<>|\s]+\|([^<>\n]*)>/g;

function countSlackLines(text: string): number {
  if (!text) {
    return 0;
  }
  return text.split("\n").length;
}

/** Count the characters Slack shows, with each labeled link counted as its label. */
function countVisibleChars(text: string): number {
  let hiddenChars = 0;
  for (const match of text.matchAll(LABELED_LINK_RE)) {
    hiddenChars += match[0].length - (match[1] ?? match[2] ?? "").length;
  }
  return text.length - hiddenChars;
}

function fitsInlineBudget(
  text: string,
  maxChars = MAX_INLINE_CHARS,
  maxLines = MAX_INLINE_LINES,
  maxRawChars = MAX_MARKDOWN_BLOCK_CHARS,
): boolean {
  return (
    text.length <= maxRawChars &&
    countVisibleChars(text) <= maxChars &&
    countSlackLines(text) <= maxLines
  );
}

/**
 * Return the largest raw index whose prefix fits both budgets. A labeled link
 * is kept whole, so a cut never lands inside its URL.
 */
function findBudgetLimitIndex(
  text: string,
  maxChars: number,
  maxRawChars: number,
): number {
  let visible = 0;
  let raw = 0;
  for (const match of text.matchAll(LABELED_LINK_RE)) {
    const gap = match.index - raw;
    if (visible + gap > maxChars || match.index > maxRawChars) {
      break;
    }
    visible += gap;
    raw = match.index;
    const labelLength = (match[1] ?? match[2] ?? "").length;
    if (
      visible + labelLength > maxChars ||
      raw + match[0].length > maxRawChars
    ) {
      return raw;
    }
    visible += labelLength;
    raw += match[0].length;
  }
  return Math.min(text.length, raw + (maxChars - visible), maxRawChars);
}

function findSplitIndex(
  text: string,
  maxChars: number,
  maxRawChars: number,
): number {
  const limitIndex = findBudgetLimitIndex(text, maxChars, maxRawChars);
  if (limitIndex >= text.length) {
    return text.length;
  }

  const bounded = text.slice(0, limitIndex);
  const newlineIndex = bounded.lastIndexOf("\n");
  if (newlineIndex > 0) {
    return newlineIndex;
  }

  const spaceIndex = bounded.lastIndexOf(" ");
  if (spaceIndex > 0) {
    return spaceIndex;
  }

  return limitIndex;
}

function splitByLineBudget(text: string, maxLines: number): string {
  if (maxLines <= 0) {
    return "";
  }

  const lines = text.split("\n");
  if (lines.length <= maxLines) {
    return text;
  }
  return lines.slice(0, maxLines).join("\n");
}

type InlineBudget = {
  maxChars: number;
  maxLines: number;
  maxRawChars: number;
};

function reserveInlineBudgetForSuffix(
  suffix: string,
  maxChars = MAX_INLINE_CHARS,
  maxLines = MAX_INLINE_LINES,
  maxRawChars = MAX_MARKDOWN_BLOCK_CHARS,
): InlineBudget {
  return {
    maxChars: Math.max(1, maxChars - suffix.length),
    maxLines: Math.max(1, maxLines - Math.max(0, countSlackLines(suffix) - 1)),
    maxRawChars: Math.max(1, maxRawChars - suffix.length),
  };
}

type FenceContinuation = {
  closeSuffix: string;
  reopenPrefix: string;
};

function forceSplitBudget(text: string, budget: InlineBudget): InlineBudget {
  const lineCount = countSlackLines(text);
  const visibleChars = countVisibleChars(text);
  return {
    maxChars:
      visibleChars <= budget.maxChars
        ? Math.max(1, visibleChars - 1)
        : budget.maxChars,
    maxLines:
      lineCount <= budget.maxLines
        ? Math.max(1, lineCount - 1)
        : budget.maxLines,
    maxRawChars:
      text.length <= budget.maxRawChars
        ? Math.max(1, text.length - 1)
        : budget.maxRawChars,
  };
}

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

function appendSlackSuffix(text: string, marker: string): string {
  const carryover = getFenceContinuation(text);
  return `${text}${carryover?.closeSuffix ?? ""}${marker}`;
}

function stripTrailingContinuationMarker(text: string): string {
  return text.endsWith(CONTINUED_MARKER)
    ? text.slice(0, -CONTINUED_MARKER.length)
    : text;
}

function takeSlackContinuationChunk(
  text: string,
  budget: InlineBudget,
): { prefix: string; rest: string } {
  let { prefix, rest } = takeSlackInlinePrefix(text, budget);
  if (!rest) {
    ({ prefix, rest } = takeSlackInlinePrefix(
      text,
      forceSplitBudget(text, budget),
    ));
  }

  let carryover = rest ? getFenceContinuation(prefix) : null;
  if (!carryover) {
    return { prefix, rest };
  }

  const carryoverBudget = reserveInlineBudgetForSuffix(
    `${carryover.closeSuffix}${CONTINUED_MARKER}`,
  );
  ({ prefix, rest } = takeSlackInlinePrefix(text, carryoverBudget));
  if (!rest) {
    ({ prefix, rest } = takeSlackInlinePrefix(
      text,
      forceSplitBudget(text, carryoverBudget),
    ));
  }

  carryover = rest ? getFenceContinuation(prefix) : null;
  if (!carryover) {
    return { prefix, rest };
  }

  return {
    prefix,
    rest: `${carryover.reopenPrefix}${rest}`,
  };
}

/** Return the first continuation-safe chunk plus any remaining text. */
export function takeSlackContinuationPrefix(
  text: string,
  options?: {
    forceSplit?: boolean;
    maxChars?: number;
    maxLines?: number;
    maxRawChars?: number;
  },
): { prefix: string; renderedPrefix: string; rest: string } {
  const defaults = getSlackContinuationBudget();
  const budget = {
    maxChars: options?.maxChars ?? defaults.maxChars,
    maxLines: options?.maxLines ?? defaults.maxLines,
    maxRawChars: options?.maxRawChars ?? defaults.maxRawChars,
  };
  const { prefix, rest } = (() => {
    if (options?.forceSplit) {
      return takeSlackContinuationChunk(text, budget);
    }
    const initial = takeSlackInlinePrefix(text, budget);
    return initial.rest ? takeSlackContinuationChunk(text, budget) : initial;
  })();
  return {
    prefix,
    renderedPrefix: rest ? appendSlackSuffix(prefix, CONTINUED_MARKER) : prefix,
    rest,
  };
}

/**
 * Take the largest Slack-safe inline prefix from `text` under the configured
 * budgets. `maxChars` counts visible characters, so link URLs do not count.
 * `maxRawChars` counts the raw markdown source. Returns the consumed prefix
 * plus remaining text.
 */
export function takeSlackInlinePrefix(
  text: string,
  options?: {
    maxChars?: number;
    maxLines?: number;
    maxRawChars?: number;
  },
): { prefix: string; rest: string } {
  const maxChars = options?.maxChars ?? MAX_INLINE_CHARS;
  const maxLines = options?.maxLines ?? MAX_INLINE_LINES;
  const maxRawChars = options?.maxRawChars ?? MAX_MARKDOWN_BLOCK_CHARS;
  const normalized = text.replace(/\r\n?/g, "\n");

  if (!normalized) {
    return { prefix: "", rest: "" };
  }

  if (fitsInlineBudget(normalized, maxChars, maxLines, maxRawChars)) {
    return { prefix: normalized, rest: "" };
  }

  const lineBounded = splitByLineBudget(normalized, maxLines);
  const cutIndex = findSplitIndex(lineBounded, maxChars, maxRawChars);
  const prefix = lineBounded.slice(0, cutIndex).trimEnd();
  if (prefix) {
    return {
      prefix,
      rest: normalized.slice(prefix.length).trimStart(),
    };
  }

  const hardPrefix = normalized.slice(0, Math.max(1, maxChars)).trimEnd();
  return {
    prefix: hardPrefix || normalized.slice(0, Math.max(1, maxChars)),
    rest: normalized
      .slice(hardPrefix.length || Math.max(1, maxChars))
      .trimStart(),
  };
}

/**
 * Split a normalized Slack reply into multiple inline-safe thread messages.
 *
 * Replies split across more than two messages receive explicit continuation
 * markers on non-final chunks. When
 * `interrupted` is true, the final chunk receives an interruption marker.
 */
export function splitSlackReplyText(
  text: string,
  options?: {
    interrupted?: boolean;
  },
): string[] {
  const normalized = normalizeSlackReplyMarkdown(text);
  if (!normalized) {
    return [];
  }

  const chunks: string[] = [];
  const continuationBudget = reserveInlineBudgetForSuffix(CONTINUED_MARKER);
  let remaining = normalized;
  while (remaining) {
    const fitsFinalChunk = options?.interrupted
      ? fitsInlineBudget(appendSlackSuffix(remaining, getInterruptionMarker()))
      : fitsInlineBudget(remaining);
    if (fitsFinalChunk) {
      chunks.push(
        options?.interrupted
          ? appendSlackSuffix(remaining, getInterruptionMarker())
          : remaining,
      );
      break;
    }

    const { renderedPrefix, rest } = takeSlackContinuationPrefix(remaining, {
      ...continuationBudget,
      forceSplit: true,
    });
    chunks.push(renderedPrefix);
    remaining = rest;
  }

  if (chunks.length === 2) {
    chunks[0] = stripTrailingContinuationMarker(chunks[0] ?? "");
  }

  return chunks;
}

/** Return the marker added to non-final overflow chunks. */
export function getSlackContinuationMarker(): string {
  return CONTINUED_MARKER;
}

/** Return the marker added when a visible reply ended mid-execution. */
export function getSlackInterruptionMarker(): string {
  return getInterruptionMarker();
}

/**
 * Return true when `text` already fits the repository's inline Slack reply
 * budget without needing continuation messages.
 */
export function fitsSlackInlineBudget(text: string): boolean {
  return fitsInlineBudget(normalizeSlackReplyMarkdown(text));
}

/**
 * Reserve enough inline budget for a continuation suffix on the current chunk.
 */
export function getSlackContinuationBudget(): InlineBudget {
  return reserveInlineBudgetForSuffix(CONTINUED_MARKER);
}

/** Normalize text for Slack and wrap it as a PostableMessage. */
export function buildSlackOutputMessage(text: string): PostableMessage {
  const normalized = normalizeSlackReplyMarkdown(text);

  if (!normalized) {
    throw new Error(
      `Slack output normalized to empty content: original_length=${text.length} parsed_length=${normalized.length}`,
    );
  }

  return {
    markdown: normalized,
  };
}

export const slackOutputPolicy = {
  maxInlineChars: MAX_INLINE_CHARS,
  maxInlineLines: MAX_INLINE_LINES,
  maxMarkdownBlockChars: MAX_MARKDOWN_BLOCK_CHARS,
};
