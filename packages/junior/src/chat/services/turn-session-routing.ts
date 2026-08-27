/**
 * Load Location, Destination, and session Source from the Conversation record.
 *
 * Destination is set once on the root conversation. Child conversations
 * inherit through parent lineage. Later turns and mailbox wakes use that
 * same destination so tools stay consistent for the whole conversation.
 */
import type {
  Destination,
  SlackDestination,
  Source,
} from "@sentry/junior-plugin-api";
import type {
  Conversation,
  ConversationStore,
} from "@/chat/conversations/store";
import type { Location } from "@/chat/conversations/location";
import type { SessionSource } from "@/chat/source";

export interface TurnSessionRouting {
  destination: Destination;
  location?: Location;
  /** Present when the conversation already stores a session source. */
  source?: Source;
}

/** Conversation data with a required Destination and Source. */
export type RequiredTurnSessionRouting = TurnSessionRouting & {
  source: Source;
};

async function loadConversationChain(
  conversationId: string,
  conversationStore: ConversationStore,
): Promise<Conversation[]> {
  const chain: Conversation[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined = conversationId;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const conversation = await conversationStore.get({
      conversationId: cursor,
    });
    if (!conversation) {
      break;
    }
    chain.push(conversation);
    cursor = conversation.lineage?.parentConversationId;
  }
  return chain;
}

/**
 * Normalize a stored Slack session source against the conversation destination.
 *
 * Does not create channel or thread values from the conversation id.
 */
function slackSourceForDestination(args: {
  destination: SlackDestination;
  source?: SessionSource;
}): SessionSource | undefined {
  if (
    args.source?.platform !== "slack" ||
    args.source.channelId !== args.destination.channelId
  ) {
    return undefined;
  }

  const threadTs = args.source.threadTs?.trim();
  return {
    platform: "slack",
    visibility: args.source.visibility ?? "public",
    teamId: args.source.teamId?.trim() || args.destination.teamId,
    channelId: args.source.channelId,
    ...(threadTs ? { threadTs } : undefined),
  };
}

/**
 * Resolve the Conversation's Location, Destination, and session Source.
 *
 * Walks parent lineage when the conversation has no destination of its own.
 */
export async function resolveConversationRouting(args: {
  conversationId: string;
  conversationStore?: ConversationStore;
}): Promise<TurnSessionRouting | undefined> {
  const conversationStore =
    args.conversationStore ??
    (await import("@/chat/db")).getConversationStore();
  const chain = await loadConversationChain(
    args.conversationId,
    conversationStore,
  );

  let destination: Destination | undefined;
  let source: SessionSource | undefined;
  let location: Location | undefined;

  for (const conversation of chain) {
    destination ??= conversation.destination;
    source ??= conversation.sessionSource;
    location ??= conversation.location;
    if (destination && source) {
      break;
    }
  }

  if (!destination) {
    return undefined;
  }

  if (destination.platform === "slack") {
    const slackSource = slackSourceForDestination({ destination, source });
    return {
      destination,
      ...(location ? { location } : undefined),
      ...(slackSource ? { source: slackSource } : undefined),
    };
  }

  return {
    destination,
    ...(location ? { location } : undefined),
    ...(source ? { source } : undefined),
  };
}

/** Require the Conversation Destination and Source from SQL. */
export async function resolveTurnSessionRouting(args: {
  conversationId: string;
  conversationStore?: ConversationStore;
}): Promise<RequiredTurnSessionRouting> {
  const routing = await resolveConversationRouting(args);
  if (!routing?.destination || !routing.source) {
    throw new Error(
      `Conversation ${args.conversationId} is missing durable routing metadata`,
    );
  }
  return {
    destination: routing.destination,
    source: routing.source,
    ...(routing.location ? { location: routing.location } : undefined),
  };
}
