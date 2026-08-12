import type { ConversationTranscript, TranscriptViewMessage } from "../types";

/**
 * Whether a transcript message should show the Slack source icon.
 *
 * Dashboard is not a shown provider. In Slack conversations, only messages that
 * are not dashboard-authored (`source !== "web"`) show the icon. Web continues
 * and dashboard-only assistant replies stay unmarked even when the root surface
 * is Slack.
 */
export function showsSlackSourceIcon(
  message: Pick<TranscriptViewMessage, "role" | "source">,
  conversation: Pick<ConversationTranscript, "surface">,
): boolean {
  if (conversation.surface !== "slack") return false;
  if (message.role !== "user" && message.role !== "assistant") return false;
  // Dashboard-authored turns are tagged source "web".
  return message.source !== "web";
}
