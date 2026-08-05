import type { PiMessage } from "@/chat/pi/messages";
import {
  extractAssistantText,
  getUserMessageInstructionText,
  isAssistantMessage,
  isToolResultMessage,
  normalizeToolNameFromResult,
} from "@/chat/pi/transcript";
import { estimateTextTokens } from "@/chat/services/context-budget";
import type { ToolActionEvidence } from "@/chat/tool-support/action-review";

const MAX_MESSAGE_TRANSCRIPT_TOKENS = 10_000;
const MAX_TOOL_TRANSCRIPT_TOKENS = 10_000;
const MAX_MESSAGE_ENTRY_TOKENS = 2_000;
const MAX_TOOL_ENTRY_TOKENS = 1_000;
const RECENT_NON_USER_ENTRY_LIMIT = 40;

type EvidenceEntry = ToolActionEvidence["entries"][number];

function isToolEntry(entry: EvidenceEntry): boolean {
  return entry.role.startsWith("tool ");
}

function truncateText(text: string, maxTokens: number): string {
  const tokenCount = estimateTextTokens(text);
  if (tokenCount <= maxTokens) {
    return text;
  }
  const maxChars = maxTokens * 4;
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

function contentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return serializedText(content);
  }
  return content
    .flatMap((part) => {
      if (!part || typeof part !== "object") {
        return [];
      }
      const record = part as { text?: unknown };
      return typeof record.text === "string" ? [record.text] : [];
    })
    .join("\n");
}

function assistantEntries(message: PiMessage): EvidenceEntry[] {
  if (!isAssistantMessage(message)) {
    return [];
  }
  const entries: EvidenceEntry[] = [];
  const text = extractAssistantText(message).trim();
  if (text) {
    entries.push({ role: "assistant", text });
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return entries;
  }
  for (const part of content) {
    if (!part || typeof part !== "object") {
      continue;
    }
    const record = part as {
      arguments?: unknown;
      name?: unknown;
      type?: unknown;
    };
    if (
      record.type !== "toolCall" ||
      typeof record.name !== "string" ||
      !record.name
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
      entries.push(...assistantEntries(message));
      continue;
    }
    if (isToolResultMessage(message)) {
      const toolName = normalizeToolNameFromResult(message) ?? "unknown";
      const text = contentText(
        (message as { content?: unknown }).content,
      ).trim();
      if (text) {
        entries.push({ role: `tool ${toolName} result`, text });
      }
    }
  }
  return entries;
}

/** Project the Codex Guardian transcript selection into structured evidence. */
export function buildToolActionEvidence(
  messages: readonly PiMessage[],
): ToolActionEvidence {
  const candidates = collectEvidenceEntries(messages).map((entry) => {
    const text = truncateText(
      entry.text,
      isToolEntry(entry) ? MAX_TOOL_ENTRY_TOKENS : MAX_MESSAGE_ENTRY_TOKENS,
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
      retainedNonUserEntries >= RECENT_NON_USER_ENTRY_LIMIT
    ) {
      continue;
    }
    const toolEntry = isToolEntry(candidate.entry);
    const withinBudget = toolEntry
      ? toolTokens + candidate.tokens <= MAX_TOOL_TRANSCRIPT_TOKENS
      : messageTokens + candidate.tokens <= MAX_MESSAGE_TRANSCRIPT_TOKENS;
    if (!withinBudget) {
      continue;
    }
    included[index] = true;
    retainedNonUserEntries += 1;
    if (toolEntry) {
      toolTokens += candidate.tokens;
    } else {
      messageTokens += candidate.tokens;
    }
  }

  return {
    entries: candidates.flatMap(({ entry }, index) =>
      included[index] ? [entry] : [],
    ),
    omittedEntries: included.filter((value) => !value).length,
  };
}
