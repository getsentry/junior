import type { ConversationTranscript, TranscriptViewMessage } from "../types";

/** Whether a transcript message has known Slack provenance. */
export function showsSlackSourceIcon(
  message: Pick<TranscriptViewMessage, "role" | "source">,
  conversation: Pick<ConversationTranscript, "surface">,
): boolean {
  if (conversation.surface !== "slack") return false;
  if (message.role !== "user" && message.role !== "assistant") return false;
  return message.source === "slack";
}
