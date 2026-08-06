/**
 * Load turn-session routing from durable conversation metadata.
 *
 * SQL owns destination and session source. Resume paths query this instead of
 * reading nested routing contracts from the short-lived turn-session record.
 */
import {
  createLocalSource,
  createSlackSource,
  type Destination,
  type Source,
} from "@sentry/junior-plugin-api";
import type {
  Conversation,
  ConversationStore,
} from "@/chat/conversations/store";
import { parseSlackThreadId } from "@/chat/slack/context";

export interface TurnSessionRouting {
  destination?: Destination;
  source?: Source;
}

/** Rebuild a session source from durable destination metadata when needed. */
function sourceFromConversation(
  conversation: Conversation | undefined,
): Source | undefined {
  if (conversation?.sessionSource) {
    return conversation.sessionSource;
  }
  const destination = conversation?.destination;
  if (!destination) {
    return undefined;
  }
  if (destination.platform === "local") {
    return createLocalSource(destination.conversationId);
  }
  const thread = parseSlackThreadId(conversation.conversationId);
  return createSlackSource({
    teamId: destination.teamId,
    channelId: destination.channelId,
    visibility: conversation.visibility === "public" ? "public" : "private",
    ...(thread?.threadTs ? { threadTs: thread.threadTs } : {}),
  });
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
    source: sourceFromConversation(conversation),
  };
}
