/**
 * Rebuild turn-session routing from durable conversation metadata when the
 * short-lived redis record no longer carries nested source/destination.
 */
import type { Destination, Source } from "@sentry/junior-plugin-api";
import type { ConversationStore } from "@/chat/conversations/store";

export interface TurnSessionRouting {
  destination?: Destination;
  source?: Source;
}

/** Prefer redis turn-session routing; fill gaps from SQL conversation metadata. */
export async function resolveTurnSessionRouting(args: {
  conversationId: string;
  destination?: Destination;
  source?: Source;
  conversationStore?: ConversationStore;
}): Promise<TurnSessionRouting> {
  if (args.destination && args.source) {
    return {
      destination: args.destination,
      source: args.source,
    };
  }

  const conversationStore =
    args.conversationStore ??
    (await import("@/chat/db")).getConversationStore();
  const conversation = await conversationStore.get({
    conversationId: args.conversationId,
  });

  return {
    destination: args.destination ?? conversation?.destination,
    source: args.source ?? conversation?.sessionSource,
  };
}
