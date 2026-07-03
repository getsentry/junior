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
  generateConversationId,
  markConversationMessage,
  normalizeConversationText,
  upsertConversationMessage,
  updateConversationStats,
} from "@/chat/services/conversation-memory";
import { clearPendingAuth } from "@/chat/services/pending-auth";

const NO_VISIBLE_REPLY_CONVERSATION_TEXT = "[no visible reply]";

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
    normalizeConversationText(args.reply.text) ||
    (args.reply.deliveryPlan?.postThreadText === false
      ? NO_VISIBLE_REPLY_CONVERSATION_TEXT
      : "[empty response]");
  markConversationMessage(conversation, args.userMessageId, {
    replied: true,
    skippedReason: undefined,
  });
  upsertConversationMessage(conversation, {
    id: generateConversationId("assistant"),
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
