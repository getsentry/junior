/**
 * Load turn-session routing from durable conversation metadata.
 *
 * Destination and session source bind once on the conversation. Child
 * conversations inherit through parent lineage. Resume and mailbox wakes use
 * the same bound surface so tools stay consistent for the whole conversation.
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
import { parseSlackMessageTs } from "@/chat/slack/timestamp";
import type { SessionSource } from "@/chat/source";

export interface TurnSessionRouting {
  destination: Destination;
  locationId?: string;
  /** Present when session source is known or can be completed. */
  source?: Source;
}

/** Full turn routing: destination plus a completed session source. */
export type RequiredTurnSessionRouting = TurnSessionRouting & {
  source: Source;
};

const SLACK_CHANNEL_ID_RE = /^[CDG][A-Z0-9]+$/;

/**
 * Read channel + thread from a historical `slack:<channel>:<ts>` conversation id.
 *
 * Services may only import Slack timestamp parsing. Keep this local so routing
 * does not depend on Slack infrastructure modules.
 */
function parseHistoricalSlackThreadId(
  conversationId: string | undefined,
): { channelId: string; threadTs: string } | undefined {
  const normalized = conversationId?.trim();
  if (!normalized) {
    return undefined;
  }

  const parts = normalized.split(":");
  if (parts.length !== 3 || parts[0] !== "slack") {
    return undefined;
  }

  const channelId = parts[1]?.trim() ?? "";
  const threadTs = parseSlackMessageTs(parts[2]);
  if (!SLACK_CHANNEL_ID_RE.test(channelId) || !threadTs) {
    return undefined;
  }

  return { channelId, threadTs };
}

async function loadConversationChain(
  conversationId: string,
  conversationStore: ConversationStore,
): Promise<Conversation[]> {
  const chain: Conversation[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined = conversationId;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const conversation = await conversationStore.get({ conversationId: cursor });
    if (!conversation) {
      break;
    }
    chain.push(conversation);
    cursor = conversation.lineage?.parentConversationId;
  }
  return chain;
}

/**
 * Fill a Slack session source when destination is bound but threadTs is missing.
 *
 * Prefer the stored session source. Otherwise read threadTs from a historical
 * `slack:<channel>:<ts>` conversation id in the lineage.
 */
function completeSlackSource(args: {
  destination: SlackDestination;
  source?: SessionSource;
  conversationIds: readonly string[];
}): SessionSource | undefined {
  if (
    args.source?.platform === "slack" &&
    args.source.channelId === args.destination.channelId
  ) {
    // Keep channel-level sessions without inventing threadTs. Threaded
    // sessions keep their stored anchor when present.
    const threadTs = args.source.threadTs?.trim();
    return {
      platform: "slack",
      visibility: args.source.visibility ?? "public",
      teamId: args.source.teamId?.trim() || args.destination.teamId,
      channelId: args.source.channelId,
      ...(threadTs ? { threadTs } : undefined),
    };
  }

  for (const conversationId of args.conversationIds) {
    const parsed = parseHistoricalSlackThreadId(conversationId);
    if (parsed && parsed.channelId === args.destination.channelId) {
      return {
        platform: "slack",
        teamId: args.destination.teamId,
        channelId: parsed.channelId,
        threadTs: parsed.threadTs,
        visibility:
          args.source?.platform === "slack"
            ? (args.source.visibility ?? "public")
            : "public",
      };
    }
  }

  return undefined;
}

/**
 * Resolve the conversation's bound destination and session source.
 *
 * Walks parent lineage for destinationless children.
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

  const conversationIds = [
    args.conversationId,
    ...chain.map((entry) => entry.conversationId),
  ];

  let destination: Destination | undefined;
  let source: SessionSource | undefined;
  let locationId: string | undefined;

  for (const conversation of chain) {
    destination ??= conversation.destination;
    source ??= conversation.sessionSource;
    locationId ??= conversation.location?.id;
    if (destination && source) {
      break;
    }
  }

  if (!destination) {
    return undefined;
  }

  if (destination.platform === "slack") {
    const slackSource = completeSlackSource({
      destination,
      source,
      conversationIds,
    });
    return {
      destination,
      ...(locationId ? { locationId } : undefined),
      ...(slackSource ? { source: slackSource } : undefined),
    };
  }

  if (destination.platform === "local") {
    // Dashboard roots often bind a local destination with a durable web
    // session source. Keep that identity; only invent local when missing.
    const localSource =
      source?.platform === "web" || source?.platform === "local"
        ? source
        : {
            platform: "local" as const,
            visibility: "private" as const,
            conversationId: destination.conversationId,
          };
    return {
      destination,
      ...(locationId ? { locationId } : undefined),
      source: localSource,
    };
  }

  return {
    destination,
    ...(locationId ? { locationId } : undefined),
    ...(source ? { source } : undefined),
  };
}

/** Require conversation destination and session source from SQL. */
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
    ...(routing.locationId ? { locationId: routing.locationId } : undefined),
  };
}
