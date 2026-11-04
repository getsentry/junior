/**
 * Read access to a Conversation's durable event log for model-facing tools.
 * The current Conversation tree is always readable. Other Conversations are
 * readable only when they are public and in the same Slack workspace.
 */
import {
  canExposeConversationPayload,
  type ConversationPrivacy,
} from "@/chat/conversation-privacy";
import type { ConversationEvent } from "@/chat/conversations/history";
import type { ConversationStore } from "@/chat/conversations/store";
import { getConversationStore } from "@/chat/db";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { ToolRuntimeContext } from "@/chat/tools/types";

interface ConversationEventAccessScope {
  currentConversationId: string;
  currentRootConversationId?: string;
  provider?: string;
  providerTenantId?: string;
}

/**
 * Throw a repairable tool error unless the active context may read the event
 * log of `conversationId`.
 */
export async function assertCanReadConversationEvents(
  context: ToolRuntimeContext,
  conversationId: string,
): Promise<void> {
  const conversationStore = getConversationStore();
  const target = await conversationStore.get({ conversationId });
  if (!target) {
    throw new ToolInputError(`Conversation not found: ${conversationId}`);
  }
  if (target.transcriptPurgedAtMs !== undefined) {
    throw new ToolInputError(
      `Conversation transcript was purged: ${conversationId}`,
    );
  }

  const accessScope = await resolveAccessScope(
    conversationStore,
    context,
    context.conversationId,
  );
  // A Conversation with a parent uses the root privacy boundary.
  const targetRootConversationId = await resolveRootConversationId(
    conversationStore,
    conversationId,
    target.parentConversationId,
  );
  const targetRoot =
    targetRootConversationId === conversationId
      ? target
      : await conversationStore.get({
          conversationId: targetRootConversationId,
        });
  assertScopeCanReadTarget({
    accessScope,
    targetConversationId: conversationId,
    targetRootConversationId,
    targetVisibility: targetRoot?.visibility ?? target.visibility,
    targetDestination: targetRoot?.destination ?? target.destination,
  });
}

async function resolveAccessScope(
  conversationStore: ConversationStore,
  context: ToolRuntimeContext,
  currentConversationId: string,
): Promise<ConversationEventAccessScope> {
  const current = await conversationStore.get({
    conversationId: currentConversationId,
  });
  const currentRootConversationId = current
    ? await resolveRootConversationId(
        conversationStore,
        currentConversationId,
        current.parentConversationId,
      )
    : currentConversationId;

  if (context.location?.provider === "slack") {
    return {
      currentConversationId,
      currentRootConversationId,
      provider: "slack",
      providerTenantId: context.location.teamId,
    };
  }

  // TODO(dcramer): Remove the Source and Destination fallbacks after every
  // deployed Slack Conversation has a stored Location and AgentRun no longer
  // has Destination.
  if (context.source.kind === "slack") {
    return {
      currentConversationId,
      currentRootConversationId,
      provider: "slack",
      providerTenantId: context.source.teamId,
    };
  }

  if (
    context.destination.platform === "slack" &&
    "teamId" in context.destination
  ) {
    return {
      currentConversationId,
      currentRootConversationId,
      provider: "slack",
      providerTenantId: context.destination.teamId,
    };
  }

  return {
    currentConversationId,
    currentRootConversationId,
  };
}

async function resolveRootConversationId(
  conversationStore: ConversationStore,
  conversationId: string,
  parentConversationId: string | undefined,
): Promise<string> {
  if (!parentConversationId) {
    return conversationId;
  }

  let cursor: string | undefined = parentConversationId;
  const seen = new Set<string>([conversationId]);
  while (cursor) {
    if (seen.has(cursor)) {
      // Fail closed on cycles; callers treat missing root as unauthorized.
      return conversationId;
    }
    seen.add(cursor);
    const parent = await conversationStore.get({ conversationId: cursor });
    if (!parent) {
      return conversationId;
    }
    if (!parent.parentConversationId) {
      return parent.conversationId;
    }
    cursor = parent.parentConversationId;
  }
  return conversationId;
}

function assertScopeCanReadTarget(args: {
  accessScope: ConversationEventAccessScope;
  targetConversationId: string;
  targetRootConversationId?: string;
  targetVisibility?: ConversationPrivacy;
  targetDestination?: {
    platform: string;
    teamId?: string;
    channelId?: string;
    conversationId?: string;
  };
}): void {
  const {
    accessScope,
    targetConversationId,
    targetRootConversationId,
    targetVisibility,
    targetDestination,
  } = args;

  if (
    targetConversationId === accessScope.currentConversationId ||
    (targetRootConversationId !== undefined &&
      targetRootConversationId === accessScope.currentRootConversationId)
  ) {
    return;
  }

  const publicPayloadAllowed = canExposeConversationPayload(
    targetVisibility ? { visibility: targetVisibility } : {},
  );
  if (!publicPayloadAllowed) {
    throw new ToolInputError(
      `Conversation events are not accessible: ${targetConversationId}`,
    );
  }

  if (
    accessScope.provider === "slack" &&
    targetDestination?.platform === "slack" &&
    accessScope.providerTenantId &&
    targetDestination.teamId === accessScope.providerTenantId
  ) {
    return;
  }

  throw new ToolInputError(
    `Conversation events are not accessible: ${targetConversationId}`,
  );
}

/** Replace replacement history with its item count; the original events stay readable by seq. */
export function stripReplacementHistory(
  data: ConversationEvent["data"],
): ConversationEvent["data"] | Record<string, unknown> {
  if (data.type === "unknown") {
    return {
      ...data,
      payload: stripReplacementHistoryField(data.payload),
    };
  }
  if (data.type === "compaction" || data.type === "handoff") {
    return stripReplacementHistoryField(data) as Record<string, unknown>;
  }
  return data;
}

function stripReplacementHistoryField(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const { replacementHistory, ...rest } = value as Record<string, unknown>;
  if (replacementHistory === undefined) {
    return value;
  }
  return {
    ...rest,
    replacement_history_count: Array.isArray(replacementHistory)
      ? replacementHistory.length
      : 0,
  };
}
