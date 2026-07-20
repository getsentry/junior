import type { PiMessage } from "@/chat/pi/messages";
import {
  COMPACTION_SUMMARY_PREFIX,
  isCompactionSummaryText,
} from "@/chat/services/context-compaction-marker";

const LEGACY_COMPACTION_SUMMARY_PREFIX =
  "Context handoff summary for future Junior turns:";

/** Recognize checkpoint text before its old prefix is upgraded. */
export function isLegacyOrCurrentCheckpointText(text: string): boolean {
  return (
    isCompactionSummaryText(text) ||
    text.includes(LEGACY_COMPACTION_SUMMARY_PREFIX)
  );
}

function normalizeText(text: string): string {
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
