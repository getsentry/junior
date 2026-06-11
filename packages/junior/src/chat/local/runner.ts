/**
 * Local agent turn runtime.
 *
 * This module owns the Slack-free execution boundary for CLI-originated turns:
 * it persists local conversation state, invokes the shared reply generator with
 * a local destination, and only commits assistant delivery after the CLI sink
 * accepts the final output.
 */
import {
  generateAssistantReply as generateAssistantReplyImpl,
  type AssistantReply,
} from "@/chat/respond";
import { buildDeliveredTurnStatePatch } from "@/chat/runtime/delivered-turn-state";
import {
  getPersistedSandboxState,
  getPersistedThreadState,
  persistThreadStateById,
} from "@/chat/runtime/thread-state";
import { startActiveTurn, markTurnFailed } from "@/chat/runtime/turn";
import {
  buildConversationContext,
  markConversationMessage,
  normalizeConversationText,
  updateConversationStats,
  upsertConversationMessage,
} from "@/chat/services/conversation-memory";
import { coerceThreadArtifactsState } from "@/chat/state/artifacts";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import type { Destination } from "@sentry/junior-plugin-api";

export interface LocalAgentTurnInput {
  conversationAlias: string;
  conversationId: string;
  message: string;
  mode: "interactive" | "once";
}

export interface LocalAgentTurnDeps {
  deliverReply: (reply: AssistantReply) => Promise<void>;
  generateAssistantReply?: typeof generateAssistantReplyImpl;
  now?: () => number;
  onStatus?: (status: string) => void | Promise<void>;
  onTextDelta?: (deltaText: string) => void | Promise<void>;
}

export interface LocalAgentTurnResult {
  conversationId: string;
  reply: AssistantReply;
}

function localDestination(conversationId: string): Destination {
  return {
    platform: "local",
    conversationId,
  };
}

function localTurnId(sequence: number): string {
  return `local-turn-${sequence}`;
}

function nextUserMessageSequence(
  conversation: ReturnType<typeof coerceThreadConversationState>,
): number {
  return (
    conversation.messages.filter((message) => message.role === "user").length +
    1
  );
}

/** Run one local CLI message through Junior's shared agent reply boundary. */
export async function runLocalAgentTurn(
  input: LocalAgentTurnInput,
  deps: LocalAgentTurnDeps,
): Promise<LocalAgentTurnResult> {
  const text = input.message.trim();
  if (!text) {
    throw new Error("Local agent message must not be empty");
  }
  if (!deps.deliverReply) {
    throw new Error("Local reply delivery is required");
  }

  const generateAssistantReply =
    deps.generateAssistantReply ?? generateAssistantReplyImpl;
  const now = deps.now ?? (() => Date.now());
  const persisted = await getPersistedThreadState(input.conversationId);
  const conversation = coerceThreadConversationState(persisted);
  let artifacts = coerceThreadArtifactsState(persisted);
  let { sandboxId, sandboxDependencyProfileHash } =
    getPersistedSandboxState(persisted);

  const sequence = nextUserMessageSequence(conversation);
  const turnId = localTurnId(sequence);
  const userMessageId = `${turnId}:user`;
  const startedAtMs = now();
  upsertConversationMessage(conversation, {
    id: userMessageId,
    role: "user",
    text: normalizeConversationText(text),
    createdAtMs: startedAtMs,
    author: {
      fullName: "Local CLI",
      userId: "local-cli",
      userName: "local",
    },
    meta: {
      explicitMention: true,
      replied: false,
    },
  });
  startActiveTurn({
    conversation,
    nextTurnId: turnId,
    updateConversationStats,
  });
  await persistThreadStateById(input.conversationId, { conversation });

  try {
    const reply = await generateAssistantReply(text, {
      authorizationFlowMode: "disabled",
      conversationContext: buildConversationContext(conversation, {
        excludeMessageId: userMessageId,
      }),
      artifactState: artifacts,
      credentialContext: {
        actor: { type: "system", id: "local-cli" },
      },
      destination: localDestination(input.conversationId),
      piMessages: conversation.piMessages,
      surface: "internal",
      correlation: {
        conversationId: input.conversationId,
        threadId: input.conversationId,
        turnId,
        runId: turnId,
      },
      sandbox: {
        sandboxId,
        sandboxDependencyProfileHash,
      },
      onArtifactStateUpdated: async (nextArtifacts) => {
        artifacts = nextArtifacts;
        await persistThreadStateById(input.conversationId, {
          artifacts,
          conversation,
          sandboxId,
          sandboxDependencyProfileHash,
        });
      },
      onSandboxAcquired: async (sandbox) => {
        sandboxId = sandbox.sandboxId;
        sandboxDependencyProfileHash = sandbox.sandboxDependencyProfileHash;
        await persistThreadStateById(input.conversationId, {
          artifacts,
          conversation,
          sandboxId,
          sandboxDependencyProfileHash,
        });
      },
      onStatus: async (status) => {
        await deps.onStatus?.(status.text);
      },
      onTextDelta: deps.onTextDelta,
    });

    await deps.deliverReply(reply);

    const completedState = buildDeliveredTurnStatePatch({
      artifacts,
      conversation,
      reply,
      sessionId: turnId,
      userMessageId,
    });
    await persistThreadStateById(input.conversationId, {
      artifacts: completedState.artifacts ?? artifacts,
      conversation: completedState.conversation,
      sandboxId: reply.sandboxId ?? sandboxId,
      sandboxDependencyProfileHash:
        reply.sandboxDependencyProfileHash ?? sandboxDependencyProfileHash,
    });

    return {
      conversationId: input.conversationId,
      reply,
    };
  } catch (error) {
    markTurnFailed({
      conversation,
      nowMs: now(),
      sessionId: turnId,
      userMessageId,
      markConversationMessage,
      updateConversationStats,
    });
    await persistThreadStateById(input.conversationId, { conversation });
    throw error;
  }
}
