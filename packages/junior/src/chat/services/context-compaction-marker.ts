import type { PiMessage } from "@/chat/pi/messages";
import { unwrapCurrentInstruction } from "@/chat/current-instruction";

export const COMPACTION_SUMMARY_PREFIX =
  "Context compaction summary for future Junior turns:";
export const ACTIVE_TURN_COMPACTION_SUMMARY_PREFIX =
  "Active-turn context checkpoint. If no newer user instruction follows this checkpoint, continue the same unfinished task now using the authoritative instructions above and this summary as internal continuation state. If a newer user instruction follows, treat this checkpoint as prior context and follow that newer instruction. Do not reply with a plan or summary solely because this checkpoint appeared:";
export const MODEL_HANDOFF_SUMMARY_PREFIX =
  "Model handoff checkpoint. Continue the outstanding request now using this summary as the complete prior context:";

/** Return whether text is one of Junior's durable compacted-context markers. */
export function isCompactionSummaryText(text: string): boolean {
  const normalized = (unwrapCurrentInstruction(text) ?? text).trimStart();
  return (
    normalized.startsWith(COMPACTION_SUMMARY_PREFIX) ||
    normalized.startsWith(ACTIVE_TURN_COMPACTION_SUMMARY_PREFIX) ||
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
