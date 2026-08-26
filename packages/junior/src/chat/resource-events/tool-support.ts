import type {
  Destination,
  SlackDestination,
  Source,
} from "@sentry/junior-plugin-api";
import { parseSlackThreadId } from "@/chat/slack/context";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

/** Default lifetime for temporary resource subscriptions. */
export const RESOURCE_SUBSCRIPTION_DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** Hard upper bound for temporary resource subscriptions. */
export const RESOURCE_SUBSCRIPTION_MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const STOP_WATCHING_TOOL_NAME = "stopWatchingResources";
export const RESOURCE_WATCH_TOOL_SOURCE = {
  id: "resource-watches",
  description: "Inspect or stop resource watches for the current conversation.",
};

export const RESOURCE_WATCH_THREAD_REQUIRED_MESSAGE =
  "Resource watches require a Slack thread. Open or continue a thread, then try again.";

/** Slack thread coordinates used to store and deliver temporary resource watches. */
export interface ResourceWatchThreadBinding {
  conversationId: string;
  destination: SlackDestination;
}

/** Build the durable `slack:{channel}:{threadTs}` conversation id for one thread. */
export function slackThreadConversationId(
  channelId: string,
  threadTs: string,
): string {
  return `slack:${channelId}:${threadTs}`;
}

/**
 * Resolve the Slack thread every temporary resource watch must bind to.
 *
 * Watches deliver into a thread mailbox, not the turn's opaque conversation id.
 * Prefer the live Slack source thread, then a `slack:{channel}:{threadTs}`
 * conversation id (including web continues of Slack roots).
 */
export function resolveResourceWatchThread(input: {
  conversationId: string;
  destination: Destination;
  source?: Source;
}): ResourceWatchThreadBinding | undefined {
  if (input.destination.platform !== "slack") {
    return undefined;
  }
  const destination = input.destination;

  if (input.source?.platform === "slack") {
    const threadTs = input.source.threadTs?.trim();
    if (threadTs && input.source.channelId === destination.channelId) {
      return {
        conversationId: slackThreadConversationId(
          destination.channelId,
          threadTs,
        ),
        destination,
      };
    }
  }

  const fromConversationId = parseSlackThreadId(input.conversationId);
  if (
    fromConversationId &&
    fromConversationId.channelId === destination.channelId
  ) {
    return {
      conversationId: slackThreadConversationId(
        fromConversationId.channelId,
        fromConversationId.threadTs,
      ),
      destination,
    };
  }

  if (input.source?.platform === "web") {
    const fromWebSource = parseSlackThreadId(input.source.conversationId);
    if (
      fromWebSource &&
      fromWebSource.channelId === destination.channelId
    ) {
      return {
        conversationId: slackThreadConversationId(
          fromWebSource.channelId,
          fromWebSource.threadTs,
        ),
        destination,
      };
    }
  }

  return undefined;
}

/** Require a Slack thread binding for temporary resource-watch tools. */
export function requireResourceWatchThread(input: {
  conversationId: string;
  destination: Destination;
  source?: Source;
}): ResourceWatchThreadBinding {
  const binding = resolveResourceWatchThread(input);
  if (!binding) {
    throw new ToolInputError(RESOURCE_WATCH_THREAD_REQUIRED_MESSAGE);
  }
  return binding;
}

/** Return whether one conversation id can receive temporary resource-watch delivery. */
export function canDeliverResourceWatchConversation(
  conversationId: string,
): boolean {
  return Boolean(parseSlackThreadId(conversationId));
}
