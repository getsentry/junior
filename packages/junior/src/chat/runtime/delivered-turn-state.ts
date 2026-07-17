import { botConfig } from "@/chat/config";
import type { AgentRunResult } from "@/chat/services/turn-result";
import type { ThreadConversationState } from "@/chat/state/conversation";
import type { ThreadArtifactsState } from "@/chat/state/artifacts";
import {
  mergeArtifactsState,
  type ThreadStatePatch,
} from "@/chat/runtime/thread-state";
import { markTurnCompleted, markTurnFailed } from "@/chat/runtime/turn";
import {
  markConversationMessage,
  normalizeConversationText,
  upsertConversationMessage,
  updateConversationStats,
} from "@/chat/services/conversation-memory";
import { clearPendingAuth } from "@/chat/services/pending-auth";
import { buildDeterministicAssistantMessageId } from "@/chat/state/turn-id";

/** Build the canonical thread-state patch after final Slack delivery succeeds. */
export function buildDeliveredTurnStatePatch(args: {
  artifactStatePatch?: Partial<ThreadArtifactsState>;
  artifacts: ThreadArtifactsState;
  conversation: ThreadConversationState;
  reply: AgentRunResult;
  sessionId: string;
  userMessageId?: string;
}): ThreadStatePatch & { conversation: ThreadConversationState } {
  const conversation = structuredClone(args.conversation);
  const artifactStatePatch = {
    ...(args.reply.artifactStatePatch ?? {}),
    ...(args.artifactStatePatch ?? {}),
  };
  const artifacts =
    Object.keys(artifactStatePatch).length > 0
      ? mergeArtifactsState(args.artifacts, artifactStatePatch)
      : undefined;

  clearPendingAuth(conversation, args.sessionId);
  const assistantText =
    normalizeConversationText(args.reply.text) || "[empty response]";
  markConversationMessage(conversation, args.userMessageId, {
    replied: true,
    skippedReason: undefined,
  });
  const intentionalSilence = args.reply.deliveryPlan?.postThreadText === false;
  if (!intentionalSilence) {
    upsertConversationMessage(conversation, {
      id: buildDeterministicAssistantMessageId(args.sessionId),
      role: "assistant",
      text: assistantText,
      createdAtMs: Date.now(),
      author: {
        userName: botConfig.userName,
        isBot: true,
      },
      meta: {
        replied: true,
      },
    });
  }
  markTurnCompleted({
    conversation,
    nowMs: Date.now(),
    sessionId: args.sessionId,
    updateConversationStats,
  });

  return {
    artifacts,
    conversation,
    sandboxId: args.reply.sandboxId,
    sandboxDependencyProfileHash: args.reply.sandboxDependencyProfileHash,
  };
}

/** Repair derived thread state after canonical SQL proves delivery completed. */
export function buildRecoveredDeliveredTurnStatePatch(args: {
  assistantMessage?: {
    author: { isBot: true; userName: string };
    createdAtMs: number;
    messageId: string;
    text: string;
  };
  conversation: ThreadConversationState;
  sessionId: string;
  inputMessageIds?: readonly string[];
}): { conversation: ThreadConversationState } {
  const conversation = structuredClone(args.conversation);
  clearPendingAuth(conversation, args.sessionId);
  for (const messageId of args.inputMessageIds ?? []) {
    markConversationMessage(conversation, messageId, {
      replied: true,
      skippedReason: undefined,
    });
  }
  if (args.assistantMessage) {
    upsertConversationMessage(conversation, {
      id: args.assistantMessage.messageId,
      role: "assistant",
      text:
        normalizeConversationText(args.assistantMessage.text) ||
        "[empty response]",
      createdAtMs: args.assistantMessage.createdAtMs,
      author: args.assistantMessage.author,
      meta: { replied: true },
    });
  }
  markTurnCompleted({
    conversation,
    nowMs: Date.now(),
    sessionId: args.sessionId,
    updateConversationStats,
  });
  return { conversation };
}

/** Repair derived thread state after canonical SQL proves delivery failed. */
export function buildRecoveredFailedDeliveryStatePatch(args: {
  conversation: ThreadConversationState;
  sessionId: string;
  inputMessageIds?: readonly string[];
}): { conversation: ThreadConversationState } {
  const conversation = structuredClone(args.conversation);
  clearPendingAuth(conversation, args.sessionId);
  for (const messageId of args.inputMessageIds ?? []) {
    markConversationMessage(conversation, messageId, {
      replied: false,
      skippedReason: "reply failed",
    });
  }
  markTurnFailed({
    conversation,
    nowMs: Date.now(),
    sessionId: args.sessionId,
    markConversationMessage,
    updateConversationStats,
  });
  return { conversation };
}
