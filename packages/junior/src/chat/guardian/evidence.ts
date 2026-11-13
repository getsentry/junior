import type { PiMessage } from "@/chat/pi/messages";
import {
  getUserMessageInstructionText,
  isAssistantMessage,
  isToolResultMessage,
  normalizeToolNameFromResult,
} from "@/chat/pi/transcript";
import {
  estimateTextTokens,
  textCharsForTokens,
} from "@/chat/services/token-estimate";
import type { ToolActionEvidence } from "@/chat/guardian/proposal";

const MAX_MESSAGE_TRANSCRIPT_TOKENS = 10_000;
const MAX_TOOL_TRANSCRIPT_TOKENS = 10_000;
const MAX_MESSAGE_ENTRY_TOKENS = 2_000;
const MAX_TOOL_ENTRY_TOKENS = 1_000;
const RECENT_NON_USER_ENTRY_LIMIT = 40;

/**
 * Text of each tool result entry. Guardian reads the name and input of each
 * earlier call, which show where data came from, and only that the call
 * returned. A result body is untrusted content, often the largest part of a
 * Run. The Claude Code auto-mode classifier does not read it either.
 */
export const TOOL_RESULT_NOT_SHOWN = "Not shown.";

type EvidenceEntry = ToolActionEvidence["entries"][number];

function truncateText(text: string, maxTokens: number): string {
  const tokenCount = estimateTextTokens(text);
  if (tokenCount <= maxTokens) {
    return text;
  }
  const maxChars = textCharsForTokens(maxTokens);
  const omittedTokens = Math.max(1, tokenCount - maxTokens);
  const marker = `<truncated omitted_approx_tokens="${omittedTokens}" />`;
  if (maxChars <= marker.length) {
    return marker;
  }
  const availableChars = maxChars - marker.length;
  const prefixChars = Math.floor(availableChars / 2);
  const suffixChars = availableChars - prefixChars;
  return `${text.slice(0, prefixChars)}${marker}${text.slice(-suffixChars)}`;
}

function serializedText(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

// Assistant text is agent output, so it is not evidence. The root section
// shows the replies that people saw, with their author.
function toolCallEntries(
  message: PiMessage,
  finishedCallIds: ReadonlySet<string>,
): EvidenceEntry[] {
  if (!isAssistantMessage(message)) {
    return [];
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return [];
  }
  const entries: EvidenceEntry[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") {
      continue;
    }
    const record = part as {
      arguments?: unknown;
      id?: unknown;
      name?: unknown;
      type?: unknown;
    };
    // A call without a result has not run yet. It is the call under review
    // or a call of the same model step, so it must not read as an earlier
    // event.
    if (
      record.type !== "toolCall" ||
      typeof record.name !== "string" ||
      !record.name ||
      typeof record.id !== "string" ||
      !finishedCallIds.has(record.id)
    ) {
      continue;
    }
    const toolInput = serializedText(record.arguments);
    if (toolInput.trim()) {
      entries.push({ role: `tool ${record.name} call`, text: toolInput });
    }
  }
  return entries;
}

function collectEvidenceEntries(
  messages: readonly PiMessage[],
): EvidenceEntry[] {
  const finishedCallIds = new Set(
    messages.flatMap((message) =>
      isToolResultMessage(message) ? [message.toolCallId] : [],
    ),
  );
  const entries: EvidenceEntry[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const text = getUserMessageInstructionText(message);
      if (text) {
        entries.push({ role: "user", text });
      }
      continue;
    }
    if (isAssistantMessage(message)) {
      entries.push(...toolCallEntries(message, finishedCallIds));
      continue;
    }
    if (isToolResultMessage(message)) {
      const toolName = normalizeToolNameFromResult(message) ?? "unknown";
      entries.push({
        role: `tool ${toolName} result`,
        text: TOOL_RESULT_NOT_SHOWN,
      });
    }
  }
  return entries;
}

/**
 * Project the Codex Guardian transcript selection into structured evidence:
 * the Run's user messages, and its tool calls that have a result, with their
 * input but not their result.
 */
export function buildToolActionEvidence(
  messages: readonly PiMessage[],
): ToolActionEvidence {
  const candidates = collectEvidenceEntries(messages).map((entry) => {
    const text = truncateText(
      entry.text,
      entry.role === "user" ? MAX_MESSAGE_ENTRY_TOKENS : MAX_TOOL_ENTRY_TOKENS,
    );
    return {
      entry: { ...entry, text },
      tokens: estimateTextTokens(`${entry.role}: ${text}`),
    };
  });
  const included = candidates.map(() => false);
  let messageTokens = 0;
  let toolTokens = 0;
  const userIndices = candidates.flatMap(({ entry }, index) =>
    entry.role === "user" ? [index] : [],
  );

  const firstUserIndex = userIndices[0];
  if (firstUserIndex !== undefined) {
    included[firstUserIndex] = true;
    messageTokens += candidates[firstUserIndex]!.tokens;
  }
  const lastUserIndex = userIndices.at(-1);
  if (
    lastUserIndex !== undefined &&
    !included[lastUserIndex] &&
    messageTokens + candidates[lastUserIndex]!.tokens <=
      MAX_MESSAGE_TRANSCRIPT_TOKENS
  ) {
    included[lastUserIndex] = true;
    messageTokens += candidates[lastUserIndex]!.tokens;
  }
  for (const index of [...userIndices].reverse()) {
    if (included[index]) {
      continue;
    }
    const tokens = candidates[index]!.tokens;
    if (messageTokens + tokens <= MAX_MESSAGE_TRANSCRIPT_TOKENS) {
      included[index] = true;
      messageTokens += tokens;
    }
  }

  let retainedNonUserEntries = 0;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index]!;
    if (
      candidate.entry.role === "user" ||
      retainedNonUserEntries >= RECENT_NON_USER_ENTRY_LIMIT ||
      toolTokens + candidate.tokens > MAX_TOOL_TRANSCRIPT_TOKENS
    ) {
      continue;
    }
    included[index] = true;
    retainedNonUserEntries += 1;
    toolTokens += candidate.tokens;
  }

  return {
    entries: candidates.flatMap(({ entry }, index) =>
      included[index] ? [entry] : [],
    ),
    omittedEntries: included.filter((value) => !value).length,
  };
}
