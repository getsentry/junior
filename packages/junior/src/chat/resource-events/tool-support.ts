import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { ToolRuntimeContext } from "@/chat/tools/types";

/** Default lifetime for temporary resource subscriptions. */
export const RESOURCE_SUBSCRIPTION_DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** Hard upper bound for temporary resource subscriptions. */
export const RESOURCE_SUBSCRIPTION_MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const STOP_WATCHING_TOOL_NAME = "stopWatchingResources";
export const RESOURCE_WATCH_TOOL_SOURCE = {
  id: "resource-watches",
  description: "Inspect or stop resource watches for the current conversation.",
};

/** Require the Slack thread identity that owns a resource watch. */
export function requireResourceWatchConversation(
  context: ToolRuntimeContext,
): string {
  if (!context.conversationId) {
    throw new ToolInputError(
      "Resource event subscriptions require a conversation",
    );
  }
  if (context.destination.platform !== "slack") {
    throw new ToolInputError(
      "Resource event subscriptions currently require Slack delivery",
    );
  }
  if (!isSlackThreadConversationId(context.conversationId)) {
    throw new ToolInputError(
      "Resource event subscriptions require a Slack thread conversation",
    );
  }
  return context.conversationId;
}

/** Return whether the current runtime can safely manage conversation watches. */
export function canUseResourceEventSubscriptionTools(
  context: ToolRuntimeContext,
): boolean {
  return (
    context.destination.platform === "slack" &&
    Boolean(
      context.conversationId &&
      isSlackThreadConversationId(context.conversationId),
    )
  );
}

function isSlackThreadConversationId(conversationId: string): boolean {
  const parts = conversationId.split(":");
  return (
    parts.length === 3 &&
    parts[0] === "slack" &&
    Boolean(parts[1]) &&
    Boolean(parts[2])
  );
}
