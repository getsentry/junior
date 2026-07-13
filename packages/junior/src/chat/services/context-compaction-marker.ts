import type { PiMessage } from "@/chat/pi/messages";
import { unwrapCurrentInstruction } from "@/chat/current-instruction";

export const COMPACTION_SUMMARY_PREFIX =
  "Context compaction summary for future Junior turns:";
// TODO(v0.97.0): Remove support for the deployed "Context handoff summary"
// prefix after pre-rename rows pass the conversation-history retention horizon.
export const LEGACY_COMPACTION_SUMMARY_PREFIX =
  "Context handoff summary for future Junior turns:";
export const MODEL_HANDOFF_SUMMARY_PREFIX =
  "Model handoff checkpoint. Continue the outstanding request now using this summary as the complete prior context:";

/** Return whether text is one of Junior's durable compacted-context markers. */
export function isCompactionSummaryText(text: string): boolean {
  const normalized = (unwrapCurrentInstruction(text) ?? text).trimStart();
  return (
    normalized.startsWith(COMPACTION_SUMMARY_PREFIX) ||
    normalized.startsWith(LEGACY_COMPACTION_SUMMARY_PREFIX) ||
    normalized.startsWith(MODEL_HANDOFF_SUMMARY_PREFIX)
  );
}

/** Return whether model-visible history contains a durable compacted context marker. */
export function hasCompactedConversationContext(
  messages: PiMessage[],
): boolean {
  return messages.some((message) => {
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") {
      return isCompactionSummaryText(content);
    }
    if (!Array.isArray(content)) {
      return false;
    }
    return content.some(
      (part) =>
        part &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string" &&
        isCompactionSummaryText((part as { text: string }).text),
    );
  });
}
