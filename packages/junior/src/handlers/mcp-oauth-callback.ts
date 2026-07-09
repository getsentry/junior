/**
 * MCP OAuth callback handler.
 *
 * This handler finalizes provider OAuth, updates pending-auth/session-log state,
 * and resumes the exact Slack turn that parked on MCP auth. Stale callbacks
 * must not resume newer thread work after another user message has superseded
 * the paused request.
 */
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { hydrateConversationMessages } from "@/chat/conversations/visible-messages";
import {
  deleteMcpAuthSession,
  type McpAuthSessionState,
} from "@/chat/mcp/auth-store";
import { finalizeMcpAuthorization } from "@/chat/mcp/oauth";
import { logException, logWarn } from "@/chat/logging";
import type { AgentRunResult } from "@/chat/services/turn-result";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import {
  getChannelConfigurationServiceById,
  getPersistedSandboxState,
  getPersistedThreadState,
  persistThreadStateById,
} from "@/chat/runtime/thread-state";
import { buildDeliveredTurnStatePatch } from "@/chat/runtime/delivered-turn-state";
import {
  getTurnUserMessage,
  getTurnUserReplyAttachmentContext,
  getTurnUserMessageId,
  getTurnUserSlackMessageTs,
} from "@/chat/runtime/turn-user-message";
import {
  buildConversationContext,
  markConversationMessage,
  updateConversationStats,
} from "@/chat/services/conversation-memory";
import { coerceThreadArtifactsState } from "@/chat/state/artifacts";
import { resumeAuthorizedRequest } from "@/chat/runtime/slack-resume";
import { persistAuthPauseTurnState } from "@/chat/runtime/auth-pause-state";
import {
  applyPendingAuthUpdate,
  clearPendingAuth,
  getConversationPendingAuth,
  isPendingAuthLatestRequest,
} from "@/chat/services/pending-auth";
import {
  failAgentTurnSessionRecord,
  abandonAgentTurnSessionRecord,
  getAgentTurnSessionRecord,
} from "@/chat/state/turn-session";
import {
  loadProjection,
  recordAuthorizationCompleted,
} from "@/chat/conversations/projection";
import { markTurnFailed } from "@/chat/runtime/turn";
import { scheduleAgentContinue } from "@/chat/services/agent-continue";
import { htmlCallbackResponse } from "@/handlers/oauth-html";
import type { WaitUntilFn } from "@/handlers/types";
import { createSlackResumeActor, isUserActor, type Actor } from "@/chat/actor";
import { requireSlackDestination } from "@/chat/destination";

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

interface McpOAuthCallbackOptions {
  agentRunner: AgentRunner;
}

function mcpAuthorizationId(args: {
  provider: string;
  sessionId: string;
}): string {
  return `${args.sessionId}:mcp:${args.provider}`;
}

function htmlResponse(kind: keyof typeof CALLBACK_PAGES): Response {
  const page = CALLBACK_PAGES[kind];
  return htmlCallbackResponse(page.title, page.message, page.status);
}

async function persistCompletedReplyState(
  channelId: string,
  threadTs: string,
  sessionId: string,
  reply: AgentRunResult,
): Promise<void> {
  const threadId = `slack:${channelId}:${threadTs}`;
  const currentState = await getPersistedThreadState(threadId);
  const conversation = coerceThreadConversationState(currentState);
  await hydrateConversationMessages({ conversation, conversationId: threadId });
  const artifacts = coerceThreadArtifactsState(currentState);
  const userMessage = getTurnUserMessage(conversation, sessionId);
  const statePatch = buildDeliveredTurnStatePatch({
    artifacts,
    conversation,
    reply,
    sessionId,
    userMessageId: userMessage?.id,
  });

  await persistThreadStateById(threadId, {
    ...statePatch,
  });
}

async function failSessionRecordBestEffort(args: {
  conversationId: string;
  errorMessage: string;
  expectedVersion: number;
  sessionId: string;
}): Promise<void> {
  try {
    await failAgentTurnSessionRecord({
      conversationId: args.conversationId,
      sessionId: args.sessionId,
      errorMessage: args.errorMessage,
      expectedVersion: args.expectedVersion,
    });
  } catch (error) {
    logException(
      error,
      "mcp_oauth_callback_session_record_fail_persist_failed",
      {},
      {
        "app.ai.conversation_id": args.conversationId,
        "app.ai.session_id": args.sessionId,
      },
      "Failed to mark MCP OAuth-resumed turn session record failed",
    );
  }
}

async function persistFailedReplyState(
  channelId: string,
  threadTs: string,
  sessionId: string,
  expectedVersion: number,
): Promise<void> {
  const threadId = `slack:${channelId}:${threadTs}`;
  const currentState = await getPersistedThreadState(threadId);
  const conversation = coerceThreadConversationState(currentState);
  await hydrateConversationMessages({ conversation, conversationId: threadId });
  clearPendingAuth(conversation, sessionId);

  markTurnFailed({
    conversation,
    nowMs: Date.now(),
    sessionId,
    userMessageId: getTurnUserMessageId(conversation, sessionId),
    markConversationMessage,
    updateConversationStats,
  });

  await failSessionRecordBestEffort({
    conversationId: threadId,
    sessionId,
    errorMessage: "OAuth-resumed MCP turn failed",
    expectedVersion,
  });
  await persistThreadStateById(threadId, {
    conversation,
  });
}

async function resumeAuthorizedMcpTurn(args: {
  authSession: McpAuthSessionState;
  agentRunner: AgentRunner;
  provider: string;
}): Promise<void> {
  const { authSession, agentRunner, provider } = args;
  if (
    !authSession.channelId ||
    !authSession.destination ||
    !authSession.threadTs
  ) {
    return;
  }
  const destination = requireSlackDestination(
    authSession.destination,
    "MCP OAuth resume",
  );

  const threadId = `slack:${authSession.channelId}:${authSession.threadTs}`;
  const currentState = await getPersistedThreadState(threadId);
  const conversation = coerceThreadConversationState(currentState);
  await hydrateConversationMessages({ conversation, conversationId: threadId });
  const pendingAuth = getConversationPendingAuth({
    conversation,
    kind: "mcp",
    provider,
    actorId: authSession.userId,
  });
  const resolvedSessionId = pendingAuth?.sessionId ?? authSession.sessionId;
  const userMessage = getTurnUserMessage(conversation, resolvedSessionId);
  if (pendingAuth) {
    if (!isPendingAuthLatestRequest(conversation, pendingAuth)) {
      clearPendingAuth(conversation, pendingAuth.sessionId);
      await persistThreadStateById(threadId, { conversation });
      await abandonAgentTurnSessionRecord({
        conversationId: authSession.conversationId,
        sessionId: pendingAuth.sessionId,
        errorMessage:
          "Auth completed after a newer thread message abandoned this blocked request.",
      });
      return;
    }
  } else if (conversation.processing.activeTurnId !== authSession.sessionId) {
    return;
  }
  if (!userMessage) {
    return;
  }

  await resumeAuthorizedRequest({
    messageText: userMessage.text,
    channelId: authSession.channelId,
    threadTs: authSession.threadTs,
    messageTs: getTurnUserSlackMessageTs(userMessage),
    lockKey: threadId,
    connectedText: "",
    agentRunner,
    beforeStart: async () => {
      const lockedState = await getPersistedThreadState(threadId);
      const lockedConversation = coerceThreadConversationState(lockedState);
      await hydrateConversationMessages({
        conversation: lockedConversation,
        conversationId: threadId,
      });
      const lockedArtifacts = coerceThreadArtifactsState(lockedState);
      const lockedPendingAuth = getConversationPendingAuth({
        conversation: lockedConversation,
        kind: "mcp",
        provider,
        actorId: authSession.userId,
      });
      const lockedSessionId =
        lockedPendingAuth?.sessionId ?? authSession.sessionId;
      if (lockedSessionId !== resolvedSessionId) {
        return false;
      }
      if (lockedPendingAuth) {
        if (
          !isPendingAuthLatestRequest(lockedConversation, lockedPendingAuth)
        ) {
          clearPendingAuth(lockedConversation, lockedPendingAuth.sessionId);
          await persistThreadStateById(threadId, {
            conversation: lockedConversation,
          });
          await abandonAgentTurnSessionRecord({
            conversationId: authSession.conversationId,
            sessionId: lockedPendingAuth.sessionId,
            errorMessage:
              "Auth completed after a newer thread message abandoned this blocked request.",
          });
          return false;
        }
      } else if (
        lockedConversation.processing.activeTurnId !== authSession.sessionId
      ) {
        return false;
      }

      const lockedUserMessage = getTurnUserMessage(
        lockedConversation,
        lockedSessionId,
      );
      if (!lockedUserMessage) {
        return false;
      }
      const lockedSessionRecord = await getAgentTurnSessionRecord(
        authSession.conversationId,
        lockedSessionId,
      );
      if (
        !lockedSessionRecord ||
        lockedSessionRecord.state !== "awaiting_resume" ||
        lockedSessionRecord.resumeReason !== "auth"
      ) {
        return false;
      }

      const lockedConversationContext = buildConversationContext(
        lockedConversation,
        {
          excludeMessageId: lockedUserMessage.id,
        },
      );
      const lockedChannelConfiguration = getChannelConfigurationServiceById(
        authSession.channelId!,
      );
      let actor: Actor;
      try {
        actor = createSlackResumeActor({
          actor: isUserActor(lockedSessionRecord.actor)
            ? lockedSessionRecord.actor
            : undefined,
          teamId: destination.teamId,
          userId: authSession.userId,
        });
      } catch {
        await failAgentTurnSessionRecord({
          conversationId: authSession.conversationId,
          expectedVersion: lockedSessionRecord.version,
          sessionId: lockedSessionId,
          errorMessage: "Stored Slack actor identity did not match OAuth actor",
        });
        return false;
      }
      if (!lockedSessionRecord.source) {
        await failAgentTurnSessionRecord({
          conversationId: authSession.conversationId,
          expectedVersion: lockedSessionRecord.version,
          sessionId: lockedSessionId,
          errorMessage: "Stored Slack source missing for MCP OAuth resume",
        });
        return false;
      }

      await recordAuthorizationCompleted({
        conversationId: authSession.conversationId,
        kind: "mcp",
        provider,
        actorId: authSession.userId,
        authorizationId: mcpAuthorizationId({
          provider,
          sessionId: lockedSessionId,
        }),
      });

      const lockedMessageTs = getTurnUserSlackMessageTs(lockedUserMessage);
      return {
        messageText: lockedUserMessage.text,
        messageTs: lockedMessageTs,
        replyContext: {
          input: {
            conversationContext: lockedConversationContext,
            // Pi history is SQL-authoritative: the resumed run reads its
            // session record first and falls back to the step projection.
            piMessages: await loadProjection({ conversationId: threadId }),
            ...getTurnUserReplyAttachmentContext(lockedUserMessage),
          },
          routing: {
            credentialContext: {
              actor: { type: "user", userId: actor.userId },
            },
            actor,
            destination,
            source: lockedSessionRecord.source,
            correlation: {
              conversationId: authSession.conversationId,
              turnId: lockedSessionId,
              channelId: authSession.channelId,
              threadTs: authSession.threadTs,
              actorId: actor.userId,
            },
            toolChannelId:
              authSession.toolChannelId ??
              lockedArtifacts.assistantContextChannelId ??
              authSession.channelId,
          },
          policy: {
            configuration: authSession.configuration,
            channelConfiguration: lockedChannelConfiguration,
          },
          state: {
            artifactState: lockedArtifacts,
            pendingAuth: lockedPendingAuth,
            sandbox: getPersistedSandboxState(lockedState),
          },
          durability: {
            recordPendingAuth: async (nextPendingAuth) => {
              await applyPendingAuthUpdate({
                conversation: lockedConversation,
                conversationId: authSession.conversationId,
                nextPendingAuth,
              });
              await persistThreadStateById(threadId, {
                conversation: lockedConversation,
              });
            },
          },
        },
        onSuccess: async (reply: AgentRunResult) => {
          await persistCompletedReplyState(
            authSession.channelId!,
            authSession.threadTs!,
            lockedSessionId,
            reply,
          );
        },
        onPostDeliveryCommitFailure: async () => {
          await failAgentTurnSessionRecord({
            conversationId: authSession.conversationId,
            expectedVersion: lockedSessionRecord.version,
            sessionId: lockedSessionId,
            errorMessage:
              "OAuth-resumed MCP reply was delivered but completion state did not persist",
          });
        },
        onFailure: async () => {
          try {
            await persistFailedReplyState(
              authSession.channelId!,
              authSession.threadTs!,
              lockedSessionId,
              lockedSessionRecord.version,
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
          await persistAuthPauseTurnState({
            sessionId: lockedSessionId,
            threadStateId: threadId,
          });
          logWarn(
            "mcp_oauth_callback_resume_reparked_for_auth",
            {},
            { "app.credential.provider": provider },
            "Resumed MCP turn requested another authorization flow",
          );
        },
        onTimeoutPause: async ({ resumeVersion }) => {
          await scheduleAgentContinue({
            conversationId: authSession.conversationId,
            destination,
            sessionId: lockedSessionId,
            expectedVersion: resumeVersion,
          });
        },
      };
    },
  });
}

export async function GET(
  request: Request,
  provider: string,
  waitUntil: WaitUntilFn,
  options: McpOAuthCallbackOptions,
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
        agentRunner: options.agentRunner,
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
