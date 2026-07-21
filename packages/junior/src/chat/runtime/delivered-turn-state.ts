import { botConfig } from "@/chat/config";
import type { AgentRunResult } from "@/chat/services/turn-result";
import type { ThreadConversationState } from "@/chat/state/conversation";
import type { ThreadArtifactsState } from "@/chat/state/artifacts";
import {
  mergeArtifactsState,
  type ThreadStatePatch,
} from "@/chat/runtime/thread-state";
import { markTurnCompleted } from "@/chat/runtime/turn";
import {
  markConversationMessage,
  normalizeConversationText,
  upsertConversationMessage,
  updateConversationStats,
} from "@/chat/services/conversation-memory";
import { clearPendingAuth } from "@/chat/services/pending-auth";
import { buildDeterministicAssistantMessageId } from "@/chat/state/turn-id";

/** Build state after destination delivery or intentional no-reply completion. */
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
  markConversationMessage(conversation, args.userMessageId, {
    replied: true,
    skippedReason: undefined,
  });
  const intentionalSilence = args.reply.deliveryPlan?.postThreadText === false;
  const terminalMessageId = buildDeterministicAssistantMessageId(
    args.sessionId,
  );
  if (
    !intentionalSilence &&
    !conversation.messages.some((message) => message.id === terminalMessageId)
  ) {
    upsertConversationMessage(conversation, {
      id: terminalMessageId,
      role: "assistant",
      text: normalizeConversationText(args.reply.text) || "[empty response]",
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
