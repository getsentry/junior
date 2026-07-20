import type { PiMessage } from "@/chat/pi/messages";
import { unwrapCurrentInstruction } from "@/chat/current-instruction";
import {
  COMPACTION_SUMMARY_PREFIX,
  isCompactionSummaryText,
} from "@/chat/services/context-compaction-marker";

// TODO(v0.107.0): Remove the pre-rename compaction prefix after its
// conversation-history retention horizon passes.
const LEGACY_COMPACTION_SUMMARY_PREFIX =
  "Context handoff summary for future Junior turns:";

function isLegacyCheckpointText(text: string): boolean {
  const normalized = (unwrapCurrentInstruction(text) ?? text).trimStart();
  return normalized.startsWith(LEGACY_COMPACTION_SUMMARY_PREFIX);
}

/** Recognize checkpoint text before its old prefix is upgraded. */
export function isLegacyOrCurrentCheckpointText(text: string): boolean {
  return isCompactionSummaryText(text) || isLegacyCheckpointText(text);
}

function normalizeText(text: string): string {
  if (!isLegacyCheckpointText(text)) return text;
  return text.replace(
    LEGACY_COMPACTION_SUMMARY_PREFIX,
    COMPACTION_SUMMARY_PREFIX,
  );
}

/** Replace the old compaction label while preserving the message's meaning. */
export function normalizeLegacyContextMessage(message: PiMessage): PiMessage {
  const record = message as unknown as Record<string, unknown>;
  if (typeof record.content === "string") {
    const content = normalizeText(record.content);
    return content === record.content
      ? message
      : ({ ...record, content } as unknown as PiMessage);
  }
  if (!Array.isArray(record.content)) return message;
  let changed = false;
  const content = record.content.map((part) => {
    if (
      !part ||
      typeof part !== "object" ||
      typeof (part as { text?: unknown }).text !== "string"
    ) {
      return part;
    }
    const text = normalizeText((part as { text: string }).text);
    if (text === (part as { text: string }).text) return part;
    changed = true;
    return { ...part, text };
  });
  return changed ? ({ ...record, content } as unknown as PiMessage) : message;
}

/** Return whether one message contains a generated context checkpoint marker. */
export function isLegacyOrCurrentCheckpointMessage(
  message: PiMessage,
): boolean {
  const record = message as unknown as Record<string, unknown>;
  if (typeof record.content === "string") {
    return isLegacyOrCurrentCheckpointText(record.content);
  }
  if (!Array.isArray(record.content)) return false;
  return record.content.some(
    (part) =>
      part !== null &&
      typeof part === "object" &&
      typeof (part as { text?: unknown }).text === "string" &&
      isLegacyOrCurrentCheckpointText((part as { text: string }).text),
  );
}
