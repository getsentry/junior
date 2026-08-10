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
} from "@/chat/services/conversation-memory";
import { clearPendingAuth } from "@/chat/services/pending-auth";

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
  markTurnCompleted({
    conversation,
    nowMs: Date.now(),
    sessionId: args.sessionId,
  });

  return {
    artifacts,
    conversation,
    sandboxRef: args.reply.sandboxRef,
  };
}
