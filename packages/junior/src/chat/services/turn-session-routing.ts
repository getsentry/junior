/**
 * Load turn-session routing from durable conversation metadata.
 *
 * SQL owns destination and session source. Resume paths query those columns
 * directly — no redis fallback and no derived rebuild of missing fields.
 */
import type { Destination, Source } from "@sentry/junior-plugin-api";
import type { ConversationStore } from "@/chat/conversations/store";

export interface TurnSessionRouting {
  destination?: Destination;
  source?: Source;
}

/** Return conversation destination and session source from SQL. */
export async function resolveTurnSessionRouting(args: {
  conversationId: string;
  conversationStore?: ConversationStore;
}): Promise<TurnSessionRouting> {
  const conversationStore =
    args.conversationStore ??
    (await import("@/chat/db")).getConversationStore();
  const conversation = await conversationStore.get({
    conversationId: args.conversationId,
  });

  return {
    destination: conversation?.destination,
    source: conversation?.sessionSource,
  };
}
