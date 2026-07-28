import type { PiMessage } from "@/chat/pi/messages";
import {
  extractAssistantText,
  getUserMessageInstructionText,
  isAssistantMessage,
} from "@/chat/pi/transcript";
import type { ToolActionEvidence } from "@/chat/tool-support/action-review";

const MAX_EVIDENCE_ENTRIES = 12;
const MAX_ENTRY_CHARS = 2_000;
const MAX_TOTAL_CHARS = 12_000;
const TRUNCATION_MARKER = "\n[truncated]";

function boundedText(text: string, remaining: number): string {
  const limit = Math.min(MAX_ENTRY_CHARS, remaining);
  if (text.length <= limit) {
    return text;
  }
  if (limit <= TRUNCATION_MARKER.length) {
    return TRUNCATION_MARKER.slice(0, limit);
  }
  return `${text.slice(0, limit - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

/**
 * Project recent visible user and assistant text into a bounded Guardian transcript.
 *
 * Tool results and assistant reasoning are intentionally excluded. The exact
 * pending tool action is supplied separately by the action proposal.
 */
export function buildToolActionEvidence(
  messages: readonly PiMessage[],
): ToolActionEvidence {
  const candidates: ToolActionEvidence["entries"] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const text = getUserMessageInstructionText(message);
      if (text) {
        candidates.push({ role: "user", text });
      }
    } else if (isAssistantMessage(message)) {
      const text = extractAssistantText(message).trim();
      if (text) {
        candidates.push({ role: "assistant", text });
      }
    }
  }
  const selected = candidates.slice(-MAX_EVIDENCE_ENTRIES);
  let remaining = MAX_TOTAL_CHARS;
  const entries = [...selected]
    .reverse()
    .flatMap((entry) => {
      if (remaining <= 0) {
        return [];
      }
      const text = boundedText(entry.text, remaining);
      remaining -= text.length;
      return [{ ...entry, text }];
    })
    .reverse();
  return {
    entries,
    omittedEntries: candidates.length - entries.length,
  };
}
