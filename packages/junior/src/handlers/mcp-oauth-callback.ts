/**
 * MCP OAuth callback handler.
 *
 * Public signed callbacks relay to the owning CLI. The loopback callback
 * finalizes local MCP authorization and leaves continuation to that CLI.
 * Slack callbacks finalize authorization, update pending-auth/event-log state,
 * and resume the exact parked turn. Stale callbacks must not resume newer
 * thread work after another user message supersedes the paused request.
 */
import { getStateAdapter } from "@/chat/state/adapter";
import { acquireActiveLock } from "@/chat/state/locks";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { hydrateConversationMessages } from "@/chat/conversations/messages";
import {
  deleteMcpAuthSession,
  getMcpAuthSession,
  type McpAuthSessionState,
} from "@/chat/mcp/auth-store";
import { finalizeMcpAuthorization } from "@/chat/mcp/oauth";
import { getMcpProviderErrorAttributes } from "@/chat/mcp/errors";
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
import { resumeSlackTurn } from "@/chat/runtime/slack-resume";
import { persistAuthPauseTurnState } from "@/chat/runtime/auth-pause-state";
import {
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
  recordAuthenticationLinked,
  recordAuthorizationCompleted,
} from "@/chat/conversations/projection";
import { formatProviderLabel } from "@/chat/oauth-flow";
import { markTurnFailed } from "@/chat/runtime/turn";
import { scheduleAgentContinue } from "@/chat/services/agent-continue";
import {
  resolveTurnSessionRouting,
  type TurnSessionRouting,
} from "@/chat/services/turn-session-routing";
import { htmlCallbackResponse } from "@/handlers/oauth-html";
import type { WaitUntilFn } from "@/handlers/types";
import { createSlackResumeActor, type Actor } from "@/chat/actor";
import { requireSlackDestination } from "@/chat/destination";
import { relayLocalOAuthCallback } from "@/chat/local/oauth-relay";

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
  expired: {
    title: "Authorization expired",
    message:
      "This authorization link is no longer active. Return to Junior and retry the original request.",
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
      "Junior could not finish the authorization callback. Return to Junior and retry the original request.",
    status: 500,
  },
} as const;

interface McpOAuthCallbackOptions {
  agentRunner: AgentRunner;
}

class McpOAuthAttemptExpiredError extends Error {
  constructor() {
    super("MCP OAuth authorization attempt is no longer current");
    this.name = "McpOAuthAttemptExpiredError";
  }
}

function mcpAuthorizationId(args: {
  provider: string;
  sessionId: string;
}): string {
  return `${args.sessionId}:mcp:${args.provider}`;
}

function htmlResponse(
  kind: keyof typeof CALLBACK_PAGES,
  options?: { local?: boolean },
): Response {
  const page =
    kind === "success" && options?.local
      ? {
          ...CALLBACK_PAGES.success,
          message:
            "Your MCP access is connected. Junior will continue the paused request in the local client.",
        }
      : CALLBACK_PAGES[kind];
  const footerMessage =
    kind === "success" && !options?.local
      ? "You can close this tab and return to Slack."
      : undefined;
  return htmlCallbackResponse(page.title, page.message, page.status, {
    footerMessage,
  });
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
      "mcp.oauth_callback.session_record.failure_persistence.failed",
      {
        "app.ai.conversation_id": args.conversationId,
        "app.ai.session_id": args.sessionId,
      },
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
  if (pendingAuth?.authSessionId !== authSession.authSessionId) {
    return;
  }
  const resolvedSessionId = pendingAuth.sessionId;
  const userMessage = getTurnUserMessage(conversation, resolvedSessionId);
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
  if (!userMessage) {
    return;
  }

  await resumeSlackTurn({
    messageText: userMessage.text,
    conversationId: authSession.conversationId,
    turnId: resolvedSessionId,
    channelId: authSession.channelId,
    threadTs: authSession.threadTs,
    messageTs: getTurnUserSlackMessageTs(userMessage),
    lockKey: threadId,
    initialText: "",
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
      if (lockedPendingAuth?.authSessionId !== authSession.authSessionId) {
        return false;
      }
      const lockedSessionId = lockedPendingAuth.sessionId;
      if (lockedSessionId !== resolvedSessionId) {
        return false;
      }
      if (!isPendingAuthLatestRequest(lockedConversation, lockedPendingAuth)) {
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
          teamId: destination.teamId,
          userId: authSession.userId,
        });
      } catch {
        await failAgentTurnSessionRecord({
          conversationId: authSession.conversationId,
          expectedVersion: lockedSessionRecord.version,
          sessionId: lockedSessionId,
          errorMessage: "Unable to rebuild Slack actor for OAuth resume",
        });
        return false;
      }
      let routing: TurnSessionRouting;
      try {
        routing = await resolveTurnSessionRouting({
          conversationId: authSession.conversationId,
        });
      } catch (error) {
        await failAgentTurnSessionRecord({
          conversationId: authSession.conversationId,
          expectedVersion: lockedSessionRecord.version,
          sessionId: lockedSessionId,
          errorMessage: error instanceof Error ? error.message : String(error),
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
        sliceId: lockedSessionRecord.sliceId,
        messageTs: lockedMessageTs,
        inputMessageIds: [lockedUserMessage.id],
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
            source: routing.source,
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
            sandboxRef: getPersistedSandboxState(lockedState),
          },
          durability: {
            recordPendingAuth: async (nextPendingAuth) => {
              lockedConversation.processing.pendingAuth = nextPendingAuth;
              await persistThreadStateById(threadId, {
                conversation: lockedConversation,
              });
            },
          },
        },
        commitResult: async (reply: AgentRunResult) => {
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
              "mcp.oauth_callback.resume_failure_persist.failed",
              { "app.credential.provider": provider },
            );
          }
        },
        onAuthPause: async () => {
          await persistAuthPauseTurnState({
            sessionId: lockedSessionId,
            threadStateId: threadId,
          });
          logWarn("mcp.oauth_callback.resume.reparked_for_auth", {
            "app.credential.provider": provider,
          });
        },
        onSuspend: async (resumeVersion) => {
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

async function isCurrentMcpAuthorizationAttempt(
  authSession: McpAuthSessionState,
  provider: string,
): Promise<boolean> {
  const conversationId = mcpConversationId(authSession);
  if (!conversationId) {
    return false;
  }

  const currentState = await getPersistedThreadState(conversationId);
  const conversation = coerceThreadConversationState(currentState);
  const pendingAuth = getConversationPendingAuth({
    conversation,
    kind: "mcp",
    provider,
    actorId: authSession.userId,
  });

  return (
    pendingAuth?.authSessionId === authSession.authSessionId &&
    pendingAuth.sessionId === authSession.sessionId
  );
}

function mcpConversationId(
  authSession: McpAuthSessionState,
): string | undefined {
  if (authSession.destination?.platform === "local") {
    return authSession.conversationId;
  }
  if (authSession.channelId && authSession.threadTs) {
    return `slack:${authSession.channelId}:${authSession.threadTs}`;
  }
  return undefined;
}

/** Commit one shared credential mutation only while this attempt owns the thread. */
async function runCurrentMcpCredentialMutation<T>(
  authSession: McpAuthSessionState,
  provider: string,
  mutation: () => Promise<T>,
): Promise<T> {
  const conversationId = mcpConversationId(authSession);
  if (!conversationId) {
    throw new McpOAuthAttemptExpiredError();
  }

  const stateAdapter = getStateAdapter();
  await stateAdapter.connect();
  const lock = await acquireActiveLock(stateAdapter, conversationId);
  if (!lock) {
    throw new Error(
      `Could not acquire MCP OAuth callback lock for ${conversationId}`,
    );
  }
  try {
    if (!(await isCurrentMcpAuthorizationAttempt(authSession, provider))) {
      throw new McpOAuthAttemptExpiredError();
    }
    return await mutation();
  } finally {
    await stateAdapter.releaseLock(lock);
  }
}

export async function GET(
  request: Request,
  provider: string,
  waitUntil: WaitUntilFn,
  options: McpOAuthCallbackOptions,
): Promise<Response> {
  const localRelay = await relayLocalOAuthCallback(request);
  if (localRelay) {
    return localRelay;
  }
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
    const pendingSession = await getMcpAuthSession(state);
    if (
      !pendingSession ||
      pendingSession.provider !== provider ||
      !(await isCurrentMcpAuthorizationAttempt(pendingSession, provider))
    ) {
      if (pendingSession) {
        await deleteMcpAuthSession(pendingSession.authSessionId);
      }
      return htmlResponse("expired");
    }

    const authSession = await finalizeMcpAuthorization(
      provider,
      state,
      code,
      async (mutation) =>
        await runCurrentMcpCredentialMutation(
          pendingSession,
          provider,
          mutation,
        ),
    );
    let providerLabel: string | undefined;
    try {
      providerLabel = formatProviderLabel(provider);
    } catch {
      providerLabel = undefined;
    }
    try {
      await recordAuthenticationLinked({
        conversationId: authSession.conversationId,
        provider,
        actorId: authSession.userId,
        authorizationId: mcpAuthorizationId({
          provider,
          sessionId: authSession.sessionId,
        }),
        turnId: authSession.sessionId,
        ...(providerLabel ? { providerLabel } : {}),
      });
    } catch (error) {
      logException(error, "mcp.oauth_callback.authentication_event.failed", {
        "app.credential.provider": provider,
      });
    }
    try {
      await deleteMcpAuthSession(authSession.authSessionId);
    } catch (cleanupError) {
      logException(cleanupError, "mcp.oauth_callback.session_cleanup.failed", {
        "app.credential.provider": provider,
      });
    }

    if (authSession.destination?.platform !== "local") {
      waitUntil(() =>
        resumeAuthorizedMcpTurn({
          authSession,
          agentRunner: options.agentRunner,
          provider,
        }),
      );
    }

    return htmlResponse("success", {
      local: authSession.destination?.platform === "local",
    });
  } catch (callbackError) {
    if (callbackError instanceof McpOAuthAttemptExpiredError) {
      await deleteMcpAuthSession(state);
      return htmlResponse("expired");
    }
    logException(callbackError, "mcp.oauth_callback.failed", {
      "app.credential.provider": provider,
      ...getMcpProviderErrorAttributes(callbackError),
    });
    return htmlResponse("failure");
  }
}
