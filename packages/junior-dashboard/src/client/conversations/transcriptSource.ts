import type { ConversationTranscript, TranscriptViewMessage } from "../types";

/**
 * Whether a transcript message should show the Slack source icon.
 *
 * Web is native Junior, not a shown provider. Provider marks are positive
 * matches only: show Slack when the message is Slack-origin, never when it is
 * web. Durable history only positively tags native web (`source: "web"`); Slack
 * history usually omits `source`. Pending mailbox rows may set `source:
 * "slack"` explicitly.
 */
export function showsSlackSourceIcon(
  message: Pick<TranscriptViewMessage, "role" | "source">,
  conversation: Pick<ConversationTranscript, "surface">,
): boolean {
  if (conversation.surface !== "slack") return false;
  if (message.role !== "user" && message.role !== "assistant") return false;
  // Native dashboard turns are tagged source "web".
  if (message.source === "web") return false;
  // Positive Slack match only. Unknown future sources stay unmarked here.
  return message.source === "slack" || message.source == null;
}
