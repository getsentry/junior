import type { FileUpload, PostableMessage } from "chat";
import { logWarn } from "@/chat/logging";

const MAX_INLINE_CHARS = 2200;
const MAX_INLINE_LINES = 45;
const CONTINUED_MARKER = "\n\n[Continued below]";
const INTERRUPTED_MARKER = "\n\n[Response interrupted before completion]";

/** Insert blank lines between content blocks so Slack renders them with visual separation. */
export function ensureBlockSpacing(text: string): string {
  const codeBlockPattern = /^```/;
  const listItemPattern = /^[-*•]\s|^\d+\.\s/;
  const lines = text.split("\n");
  const result: string[] = [];
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isCodeFence = codeBlockPattern.test(line.trimStart());

    if (isCodeFence) {
      // Insert blank line before code fence if needed (only outside code blocks)
      if (!inCodeBlock) {
        const prev = result.length > 0 ? result[result.length - 1] : undefined;
        if (prev !== undefined && prev.trim() !== "") {
          result.push("");
        }
      }
      inCodeBlock = !inCodeBlock;
      result.push(line);
      continue;
    }

    if (inCodeBlock) {
      result.push(line);
      continue;
    }

    const prev = result.length > 0 ? result[result.length - 1] : undefined;

    // Insert blank line if: prev is non-empty, current is non-empty,
    // prev is not already a blank line, and they're not both list items
    if (
      prev !== undefined &&
      prev.trim() !== "" &&
      line.trim() !== "" &&
      !(
        listItemPattern.test(prev.trimStart()) &&
        listItemPattern.test(line.trimStart())
      )
    ) {
      result.push("");
    }

    result.push(line);
  }

  return result.join("\n");
}

/**
 * Render model-authored markdown into Slack-friendly `mrkdwn`.
 *
 * This module owns reply-text translation for Slack. Delivery modules should
 * post the returned text without applying Slack-specific formatting rules again.
 */
export function renderSlackMrkdwn(text: string): string {
  let normalized = text.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "");
  normalized = ensureBlockSpacing(normalized);
  return normalized.replace(/\n{3,}/g, "\n\n").trim();
}

function countSlackLines(text: string): number {
  if (!text) {
    return 0;
  }
  return text.split("\n").length;
}

function fitsInlineBudget(
  text: string,
  maxChars = MAX_INLINE_CHARS,
  maxLines = MAX_INLINE_LINES,
): boolean {
  return text.length <= maxChars && countSlackLines(text) <= maxLines;
}

function findSplitIndex(text: string, maxChars: number): number {
  if (text.length <= maxChars) {
    return text.length;
  }

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

function reserveInlineBudgetForSuffix(
  suffix: string,
  maxChars = MAX_INLINE_CHARS,
  maxLines = MAX_INLINE_LINES,
): { maxChars: number; maxLines: number } {
  return {
    maxChars: Math.max(1, maxChars - suffix.length),
    maxLines: Math.max(1, maxLines - Math.max(0, countSlackLines(suffix) - 1)),
  };
}

type InlineBudget = {
  maxChars: number;
  maxLines: number;
};

type FenceContinuation = {
  closeSuffix: string;
  reopenPrefix: string;
};

function forceSplitBudget(text: string, budget: InlineBudget): InlineBudget {
  const lineCount = countSlackLines(text);
  return {
    maxChars:
      text.length <= budget.maxChars
        ? Math.max(1, text.length - 1)
        : budget.maxChars,
    maxLines:
      lineCount <= budget.maxLines
        ? Math.max(1, lineCount - 1)
        : budget.maxLines,
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
    if (!openerMatch) {
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
  },
): { prefix: string; renderedPrefix: string; rest: string } {
  const budget = {
    maxChars: options?.maxChars ?? getSlackContinuationBudget().maxChars,
    maxLines: options?.maxLines ?? getSlackContinuationBudget().maxLines,
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
 * character and line budgets. Returns the consumed prefix plus remaining text.
 */
export function takeSlackInlinePrefix(
  text: string,
  options?: {
    maxChars?: number;
    maxLines?: number;
  },
): { prefix: string; rest: string } {
  const maxChars = options?.maxChars ?? MAX_INLINE_CHARS;
  const maxLines = options?.maxLines ?? MAX_INLINE_LINES;
  const normalized = text.replace(/\r\n?/g, "\n");

  if (!normalized) {
    return { prefix: "", rest: "" };
  }

  if (fitsInlineBudget(normalized, maxChars, maxLines)) {
    return { prefix: normalized, rest: "" };
  }

  const lineBounded = splitByLineBudget(normalized, maxLines);
  const cutIndex = findSplitIndex(lineBounded, maxChars);
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
 * Non-final chunks receive an explicit continuation marker. When
 * `interrupted` is true, the final chunk receives an interruption marker.
 */
export function splitSlackReplyText(
  text: string,
  options?: {
    interrupted?: boolean;
  },
): string[] {
  const normalized = renderSlackMrkdwn(text);
  if (!normalized) {
    return [];
  }

  const chunks: string[] = [];
  const continuationBudget = reserveInlineBudgetForSuffix(CONTINUED_MARKER);
  let remaining = normalized;
  while (remaining) {
    const fitsFinalChunk = options?.interrupted
      ? fitsInlineBudget(appendSlackSuffix(remaining, INTERRUPTED_MARKER))
      : fitsInlineBudget(remaining);
    if (fitsFinalChunk) {
      chunks.push(
        options?.interrupted
          ? appendSlackSuffix(remaining, INTERRUPTED_MARKER)
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

  return chunks;
}

/** Return the marker added to non-final overflow chunks. */
export function getSlackContinuationMarker(): string {
  return CONTINUED_MARKER;
}

/** Return the marker added when a visible reply ended mid-execution. */
export function getSlackInterruptionMarker(): string {
  return INTERRUPTED_MARKER;
}

/**
 * Return true when `text` already fits the repository's inline Slack reply
 * budget without needing continuation messages.
 */
export function fitsSlackInlineBudget(text: string): boolean {
  return fitsInlineBudget(renderSlackMrkdwn(text));
}

/**
 * Reserve enough inline budget for a continuation suffix on the current chunk.
 */
export function getSlackContinuationBudget(): {
  maxChars: number;
  maxLines: number;
} {
  return reserveInlineBudgetForSuffix(CONTINUED_MARKER);
}

/** Normalize text for Slack and wrap it as a PostableMessage with optional file attachments. */
export function buildSlackOutputMessage(
  text: string,
  files?: FileUpload[],
): PostableMessage {
  const normalized = renderSlackMrkdwn(text);
  const fileCount = files?.length ?? 0;

  if (!normalized) {
    if (fileCount > 0) {
      return {
        raw: "",
        files,
      };
    }

    logWarn(
      "slack_output_normalized_empty",
      {},
      {
        "app.output.original_length": text.length,
        "app.output.parsed_length": normalized.length,
        "app.output.file_count": fileCount,
      },
      "Slack output normalized to empty content",
    );
    return {
      markdown: "I couldn't produce a response.",
      files,
    };
  }

  return {
    markdown: normalized,
    files,
  };
}

export const slackOutputPolicy = {
  maxInlineChars: MAX_INLINE_CHARS,
  maxInlineLines: MAX_INLINE_LINES,
};
