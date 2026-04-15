import { botConfig } from "@/chat/config";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import {
  deleteMcpAuthSession,
  type McpAuthSessionState,
} from "@/chat/mcp/auth-store";
import { finalizeMcpAuthorization } from "@/chat/mcp/oauth";
import { logException, logWarn } from "@/chat/logging";
import type { AssistantReply } from "@/chat/respond";
import {
  getChannelConfigurationServiceById,
  getPersistedSandboxState,
  mergeArtifactsState,
  getPersistedThreadState,
  persistThreadStateById,
} from "@/chat/runtime/thread-state";
import { buildThreadParticipants } from "@/chat/runtime/thread-participants";
import {
  getTurnUserMessage,
  getTurnUserMessageId,
} from "@/chat/runtime/turn-user-message";
import {
  buildConversationContext,
  generateConversationId,
  markConversationMessage,
  normalizeConversationText,
  upsertConversationMessage,
  updateConversationStats,
} from "@/chat/services/conversation-memory";
import { coerceThreadArtifactsState } from "@/chat/state/artifacts";
import { resumeAuthorizedRequest } from "@/chat/slack/resume";
import {
  isRetryableTurnError,
  markTurnCompleted,
  markTurnFailed,
} from "@/chat/runtime/turn";
import {
  canScheduleTurnTimeoutResume,
  scheduleTurnTimeoutResume,
} from "@/chat/services/timeout-resume";
import { htmlCallbackResponse } from "@/handlers/oauth-html";
import type { WaitUntilFn } from "@/handlers/types";

const CALLBACK_PAGES = {
  missing_state: {
    title: "Authorization failed",
    message: "Missing state parameter.",
    status: 400,
  },
  provider_error: {
    title: "Authorization failed",
    message: "The provider returned an authorization error.",
    status: 400,
  },
  missing_code: {
    title: "Authorization failed",
    message: "Missing code parameter.",
    status: 400,
  },
  success: {
    title: "Authorization complete",
    message:
      "Your MCP access is connected. Junior will continue the paused request in Slack.",
    status: 200,
  },
  failure: {
    title: "Authorization failed",
    message:
      "Junior could not finish the authorization callback. Return to Slack and retry the original request.",
    status: 500,
  },
} as const;

function htmlResponse(kind: keyof typeof CALLBACK_PAGES): Response {
  const page = CALLBACK_PAGES[kind];
  return htmlCallbackResponse(page.title, page.message, page.status);
}

async function buildResumeConversationContext(
  channelId: string,
  threadTs: string,
  sessionId: string,
): Promise<string | undefined> {
  const threadId = `slack:${channelId}:${threadTs}`;
  const conversation = coerceThreadConversationState(
    await getPersistedThreadState(threadId),
  );
  const userMessageId = getTurnUserMessageId(conversation, sessionId);
  return buildConversationContext(conversation, {
    excludeMessageId: userMessageId,
  });
}

async function persistCompletedReplyState(
  channelId: string,
  threadTs: string,
  sessionId: string,
  reply: AssistantReply,
): Promise<void> {
  // OAuth resumes only persist completion after the final visible reply has
  // already been delivered to Slack.
  const threadId = `slack:${channelId}:${threadTs}`;
  const currentState = await getPersistedThreadState(threadId);
  const conversation = coerceThreadConversationState(currentState);
  const artifacts = coerceThreadArtifactsState(currentState);
  const nextArtifacts = reply.artifactStatePatch
    ? mergeArtifactsState(artifacts, reply.artifactStatePatch)
    : undefined;
  const userMessageId = getTurnUserMessageId(conversation, sessionId);

  markConversationMessage(conversation, userMessageId, {
    replied: true,
    skippedReason: undefined,
  });
  upsertConversationMessage(conversation, {
    id: generateConversationId("assistant"),
    role: "assistant",
    text: normalizeConversationText(reply.text) || "[empty response]",
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
    updateConversationStats,
  });

  await persistThreadStateById(threadId, {
    artifacts: nextArtifacts,
    conversation,
    sandboxId: reply.sandboxId,
    sandboxDependencyProfileHash: reply.sandboxDependencyProfileHash,
  });
}

async function persistFailedReplyState(
  channelId: string,
  threadTs: string,
  sessionId: string,
): Promise<void> {
  const threadId = `slack:${channelId}:${threadTs}`;
  const currentState = await getPersistedThreadState(threadId);
  const conversation = coerceThreadConversationState(currentState);

  markTurnFailed({
    conversation,
    nowMs: Date.now(),
    userMessageId: getTurnUserMessageId(conversation, sessionId),
    markConversationMessage,
    updateConversationStats,
  });

  await persistThreadStateById(threadId, {
    conversation,
  });
}

async function resumeAuthorizedMcpTurn(args: {
  authSession: McpAuthSessionState;
  provider: string;
}): Promise<void> {
  const { authSession, provider } = args;
  if (!authSession.channelId || !authSession.threadTs) {
    return;
  }

  const threadId = `slack:${authSession.channelId}:${authSession.threadTs}`;
  const currentState = await getPersistedThreadState(threadId);
  const conversation = coerceThreadConversationState(currentState);
  const artifacts = coerceThreadArtifactsState(currentState);
  const userMessage = getTurnUserMessage(conversation, authSession.sessionId);
  if (conversation.processing.activeTurnId !== authSession.sessionId) {
    return;
  }

  const channelConfiguration = getChannelConfigurationServiceById(
    authSession.channelId,
  );
  const conversationContext = await buildResumeConversationContext(
    authSession.channelId,
    authSession.threadTs,
    authSession.sessionId,
  );

  await resumeAuthorizedRequest({
    messageText: authSession.userMessage,
    channelId: authSession.channelId,
    threadTs: authSession.threadTs,
    lockKey: authSession.conversationId,
    connectedText: `Your ${provider} MCP access is now connected. Continuing the original request...`,
    failureText:
      "MCP authorization completed, but resuming the request failed. Please retry the original command.",
    replyContext: {
      assistant: { userName: botConfig.userName },
      requester: {
        userId: authSession.userId,
        userName: userMessage?.author?.userName,
        fullName: userMessage?.author?.fullName,
      },
      correlation: {
        conversationId: authSession.conversationId,
        turnId: authSession.sessionId,
        channelId: authSession.channelId,
        threadTs: authSession.threadTs,
        requesterId: authSession.userId,
      },
      toolChannelId:
        authSession.toolChannelId ??
        artifacts.assistantContextChannelId ??
        authSession.channelId,
      conversationContext,
      artifactState: artifacts,
      configuration: authSession.configuration,
      channelConfiguration,
      sandbox: getPersistedSandboxState(currentState),
      threadParticipants: buildThreadParticipants(conversation.messages),
    },
    onSuccess: async (reply) => {
      try {
        await persistCompletedReplyState(
          authSession.channelId!,
          authSession.threadTs!,
          authSession.sessionId,
          reply,
        );
      } catch (persistError) {
        logException(
          persistError,
          "mcp_oauth_callback_resume_persist_failed",
          {},
          { "app.credential.provider": provider },
          "Failed to persist resumed MCP turn state",
        );
      }
    },
    onFailure: async (error) => {
      logException(
        error,
        "mcp_oauth_callback_resume_failed",
        {},
        { "app.credential.provider": provider },
        "Failed to resume MCP-authorized turn",
      );
      try {
        await persistFailedReplyState(
          authSession.channelId!,
          authSession.threadTs!,
          authSession.sessionId,
        );
      } catch (persistError) {
        logException(
          persistError,
          "mcp_oauth_callback_resume_failure_persist_failed",
          {},
          { "app.credential.provider": provider },
          "Failed to persist failed MCP resume state",
        );
      }
    },
    onAuthPause: async () => {
      logWarn(
        "mcp_oauth_callback_resume_reparked_for_auth",
        {},
        { "app.credential.provider": provider },
        "Resumed MCP turn requested another authorization flow",
      );
    },
    onTimeoutPause: async (error) => {
      if (!isRetryableTurnError(error, "turn_timeout_resume")) {
        throw error;
      }
      const checkpointVersion = error.metadata?.checkpointVersion;
      const nextSliceId = error.metadata?.sliceId;
      if (typeof checkpointVersion !== "number") {
        throw new Error(
          "Timed-out MCP resume did not include a checkpoint version",
        );
      }
      if (!canScheduleTurnTimeoutResume(nextSliceId)) {
        logWarn(
          "mcp_oauth_callback_resume_slice_limit_reached",
          {},
          {
            "app.credential.provider": provider,
            ...(typeof nextSliceId === "number"
              ? { "app.ai.resume_slice_id": nextSliceId }
              : {}),
          },
          "Skipped automatic timeout resume because the turn exceeded the slice limit",
        );
        throw new Error(
          "Timed-out turn exceeded the automatic resume slice limit",
        );
      }
      await scheduleTurnTimeoutResume({
        conversationId: authSession.conversationId,
        sessionId: authSession.sessionId,
        expectedCheckpointVersion: checkpointVersion,
      });
    },
  });
}

export async function GET(
  request: Request,
  provider: string,
  waitUntil: WaitUntilFn,
): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state")?.trim();
  const code = url.searchParams.get("code")?.trim();
  const error = url.searchParams.get("error")?.trim();

  if (!state) {
    return htmlResponse("missing_state");
  }
  if (error) {
    return htmlResponse("provider_error");
  }
  if (!code) {
    return htmlResponse("missing_code");
  }

  try {
    const authSession = await finalizeMcpAuthorization(provider, state, code);
    try {
      await deleteMcpAuthSession(authSession.authSessionId);
    } catch (cleanupError) {
      logException(
        cleanupError,
        "mcp_oauth_callback_session_cleanup_failed",
        {},
        { "app.credential.provider": provider },
        "Failed to delete completed MCP auth session",
      );
    }

    waitUntil(() =>
      resumeAuthorizedMcpTurn({
        authSession,
        provider,
      }),
    );

    return htmlResponse("success");
  } catch (callbackError) {
    logException(
      callbackError,
      "mcp_oauth_callback_failed",
      {},
      { "app.credential.provider": provider },
      "Failed to process MCP OAuth callback",
    );
    return htmlResponse("failure");
  }
}
