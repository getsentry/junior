import type { ConversationTranscript, TranscriptViewMessage } from "../types";

/**
 * Whether a transcript message should show the Slack source icon.
 *
 * Dashboard is not a shown provider. In Slack conversations, every user message
 * shows the icon. Assistant messages show it only when the reply is not
 * dashboard-only (`source !== "web"`), which is how Slack-outbound replies are
 * stored today.
 */
export function showsSlackSourceIcon(
  message: Pick<TranscriptViewMessage, "role" | "source">,
  conversation: Pick<ConversationTranscript, "surface">,
): boolean {
  if (conversation.surface !== "slack") return false;
  if (message.role === "user") return true;
  // Dashboard-only assistant replies are tagged source "web".
  if (message.role === "assistant") return message.source !== "web";
  return false;
}
