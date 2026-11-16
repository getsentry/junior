import type { PiMessage } from "@/chat/pi/messages";
import { unwrapCurrentInstruction } from "@/chat/current-instruction";
import type { StaticToolName } from "@/chat/tools/registry";
import { escapeXml } from "@/chat/xml";

export const COMPACTION_SUMMARY_PREFIX =
  "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:";
export const ACTIVE_TURN_COMPACTION_SUMMARY_PREFIX = COMPACTION_SUMMARY_PREFIX;

// `satisfies` fails typecheck when either tool is renamed or removed.
const SEARCH_EVENTS_TOOL = "searchConversationEvents" satisfies StaticToolName;
const READ_EVENT_TOOL = "readConversationEvent" satisfies StaticToolName;
const COMPACTION_READ_BACK_NOTE = `The summary replaced earlier messages and tool results. When you need an exact detail that the summary lacks, read the full text with the ${SEARCH_EVENTS_TOOL} and ${READ_EVENT_TOOL} tools.`;

/**
 * Keep generated text inside the existing evidence-only prompt boundary. The
 * last line says where replaced detail stays readable: without it, the model
 * often decides an exact value from a compacted tool result is gone.
 */
export function renderCompactionSummary(summary: string): string {
  return [
    COMPACTION_SUMMARY_PREFIX,
    '<thread-context authority="evidence-only">',
    escapeXml(summary),
    "</thread-context>",
    COMPACTION_READ_BACK_NOTE,
  ].join("\n");
}

/** Return whether text is one of Junior's durable compacted-context markers. */
export function isCompactionSummaryText(text: string): boolean {
  const normalized = (unwrapCurrentInstruction(text) ?? text).trimStart();
  return (
    normalized.startsWith(COMPACTION_SUMMARY_PREFIX) ||
    normalized.startsWith(ACTIVE_TURN_COMPACTION_SUMMARY_PREFIX)
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
