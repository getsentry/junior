/**
 * Load Location, Destination, and session Source from the Conversation record.
 *
 * Destination is set once on the root Conversation. A Conversation with a
 * parent reads through that relation. Later Turns and mailbox wakes use the
 * same Destination so tools stay consistent for the whole Conversation.
 */
import type {
  Destination,
  SlackDestination,
  Source,
} from "@sentry/junior-plugin-api";
import {
  getDispatchConversationId,
  getDispatchRecord,
} from "@/chat/agent-dispatch/store";
import type {
  Conversation,
  ConversationStore,
} from "@/chat/conversations/store";
import type { Location } from "@/chat/conversations/location";
import type { SessionSource } from "@/chat/source";

// TODO(dcramer): Remove TurnSessionRouting and this module after every resume
// reads Source from its Turn and Location from its Conversation, and no caller
// uses Destination as the Conversation place.
export interface TurnSessionRouting {
  destination: Destination;
  location?: Location;
  /** Present when the conversation already stores a session source. */
  source?: SessionSource;
}

/** Conversation data with a required Destination and Source. */
export type RequiredTurnSessionRouting = TurnSessionRouting & {
  source: SessionSource;
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
    cursor = conversation.parentConversationId;
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
  source?: SessionSource | undefined;
}): SessionSource | undefined {
  if (
    args.source?.kind !== "slack" ||
    args.source.channelId !== args.destination.channelId
  ) {
    return undefined;
  }

  const threadTs = args.source.threadTs?.trim();
  return {
    kind: "slack",
    visibility: args.source.visibility ?? "public",
    teamId: args.source.teamId?.trim() || args.destination.teamId,
    channelId: args.source.channelId,
    ...(threadTs ? { threadTs } : undefined),
  };
}

/**
 * Resolve the Conversation Location, Destination, and session Source.
 *
 * Reads parent Conversations when this Conversation has no Destination.
 */
export async function resolveConversationRouting(args: {
  conversationId: string;
  conversationStore?: ConversationStore | undefined;
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
  let location: Conversation["location"];

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
  conversationStore?: ConversationStore | undefined;
}): Promise<RequiredTurnSessionRouting> {
  const routing = await resolveConversationRouting(args);
  if (!routing?.destination || !routing.source) {
    throw new Error(
      `Conversation ${args.conversationId} is missing durable routing metadata`,
    );
  }
  return {
    destination: routing.destination,
    ...(routing.location ? { location: routing.location } : undefined),
    source: routing.source,
  };
}

/** Destination, Location, and Source for a resumed Turn. */
export interface TurnResumeRouting {
  destination: Destination;
  location?: Location;
  source: Source;
}

/**
 * Require the Destination and Source to resume a Turn.
 *
 * A dispatch Conversation stores the dispatch Source, which has no session
 * Source. Its dispatch record owns the Destination and Source.
 */
export async function resolveTurnResumeRouting(args: {
  conversationId: string;
  conversationStore?: ConversationStore | undefined;
  dispatchId?: string | undefined;
}): Promise<TurnResumeRouting> {
  if (!args.dispatchId) {
    return await resolveTurnSessionRouting(args);
  }
  const dispatch = await getDispatchRecord(args.dispatchId);
  if (!dispatch) {
    throw new Error(`Dispatch record is missing for ${args.dispatchId}`);
  }
  const dispatchConversationId = getDispatchConversationId(dispatch);
  if (dispatchConversationId !== args.conversationId) {
    throw new Error(
      `Dispatch ${dispatch.id} belongs to ${dispatchConversationId}, not ${args.conversationId}`,
    );
  }
  const location = (await resolveConversationRouting(args))?.location;
  return {
    destination: dispatch.destination,
    ...(location ? { location } : undefined),
    source: dispatch.source,
  };
}
