/**
 * Load turn-session routing from durable conversation metadata.
 *
 * SQL owns destination and session source. Resume paths query this instead of
 * reading nested routing contracts from the short-lived turn-session record.
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
