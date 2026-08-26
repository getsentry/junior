/**
 * Load turn-session routing from durable conversation metadata.
 *
 * Destination and session source bind once on the conversation (set on first
 * activity, then stable). Child conversations inherit through parent lineage.
 * Resume and mailbox wakes use the same bound surface so tools stay consistent
 * for the whole conversation.
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
  source: Source;
}

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

function slackSourceFromThread(args: {
  channelId: string;
  teamId: string;
  threadTs: string;
  visibility?: "public" | "private";
}): SessionSource {
  return {
    platform: "slack",
    teamId: args.teamId,
    channelId: args.channelId,
    threadTs: args.threadTs,
    visibility: args.visibility ?? "public",
  };
}

function slackRoutingFromConversationId(
  conversationId: string,
  teamId: string,
): TurnSessionRouting | undefined {
  const parsed = parseHistoricalSlackThreadId(conversationId);
  if (!parsed || !teamId.trim()) {
    return undefined;
  }
  const destination: SlackDestination = {
    platform: "slack",
    teamId: teamId.trim(),
    channelId: parsed.channelId,
  };
  return {
    destination,
    source: slackSourceFromThread({
      channelId: parsed.channelId,
      teamId: destination.teamId,
      threadTs: parsed.threadTs,
    }),
  };
}

function completeSlackSource(args: {
  destination: SlackDestination;
  source?: SessionSource;
  conversationIds: readonly string[];
}): SessionSource | undefined {
  if (
    args.source?.platform === "slack" &&
    args.source.channelId === args.destination.channelId &&
    args.source.threadTs?.trim()
  ) {
    return {
      ...args.source,
      threadTs: args.source.threadTs.trim(),
      teamId: args.source.teamId?.trim() || args.destination.teamId,
    };
  }

  for (const conversationId of args.conversationIds) {
    const parsed = parseHistoricalSlackThreadId(conversationId);
    if (parsed && parsed.channelId === args.destination.channelId) {
      return slackSourceFromThread({
        channelId: parsed.channelId,
        teamId: args.destination.teamId,
        threadTs: parsed.threadTs,
        ...(args.source?.platform === "slack" && args.source.visibility
          ? { visibility: args.source.visibility }
          : undefined),
      });
    }
  }

  if (
    args.source?.platform === "slack" &&
    args.source.channelId?.trim() &&
    args.source.threadTs?.trim()
  ) {
    return {
      platform: "slack",
      teamId: args.source.teamId?.trim() || args.destination.teamId,
      channelId: args.source.channelId.trim(),
      threadTs: args.source.threadTs.trim(),
      visibility: args.source.visibility ?? "public",
    };
  }

  return undefined;
}

/**
 * Resolve the conversation's bound destination and session source.
 *
 * Walks parent lineage for destinationless children. When a historical Slack
 * conversation id still encodes the thread and no row exists yet, optional
 * `fallbackTeamId` can complete the Slack destination.
 */
export async function resolveConversationRouting(args: {
  conversationId: string;
  conversationStore?: ConversationStore;
  /**
   * Historical only. Used when the conversation id encodes a Slack thread but
   * durable destination metadata is not stored yet.
   */
  fallbackTeamId?: string;
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
    ...chain
      .map((entry) => entry.lineage?.parentConversationId)
      .filter((value): value is string => Boolean(value?.trim())),
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

  if (destination?.platform === "slack") {
    const slackSource = completeSlackSource({
      destination,
      source,
      conversationIds,
    });
    if (!slackSource) {
      return undefined;
    }
    return {
      destination,
      ...(locationId ? { locationId } : undefined),
      source: slackSource,
    };
  }

  if (destination && source) {
    return {
      destination,
      ...(locationId ? { locationId } : undefined),
      source,
    };
  }

  if (destination && destination.platform === "local") {
    return {
      destination,
      ...(locationId ? { locationId } : undefined),
      source: {
        platform: "local",
        visibility: "private",
        conversationId: destination.conversationId,
      },
    };
  }

  return slackRoutingFromConversationId(
    args.conversationId,
    args.fallbackTeamId?.trim() ?? "",
  );
}

/** Require conversation destination and session source from SQL. */
export async function resolveTurnSessionRouting(args: {
  conversationId: string;
  conversationStore?: ConversationStore;
}): Promise<TurnSessionRouting> {
  const routing = await resolveConversationRouting(args);
  if (!routing) {
    throw new Error(
      `Conversation ${args.conversationId} is missing durable routing metadata`,
    );
  }
  return routing;
}
