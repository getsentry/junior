import type { ConversationTranscript, TranscriptViewMessage } from "../types";

/** A provider whose mark the dashboard can show on a transcript message. */
export type SourceProvider = "github" | "slack";

/** Plugins without a mark stay unmarked. */
function pluginSource(plugin: string | undefined): SourceProvider | undefined {
  return plugin === "github" ? "github" : undefined;
}

/** Return the provider a chat message is known to come from or go to. */
export function transcriptMessageSource(
  message: Pick<TranscriptViewMessage, "postedTo" | "role" | "source">,
  conversation: Pick<ConversationTranscript, "surface">,
): SourceProvider | undefined {
  if (message.postedTo) return pluginSource(message.postedTo);
  if (conversation.surface !== "slack") return undefined;
  if (message.role !== "user" && message.role !== "assistant") return undefined;
  return message.source === "slack" ? "slack" : undefined;
}

/** Return the provider an Event message comes from. */
export function eventMessageSource(
  message: Pick<TranscriptViewMessage, "eventNamespace">,
): SourceProvider | undefined {
  return pluginSource(message.eventNamespace);
}
