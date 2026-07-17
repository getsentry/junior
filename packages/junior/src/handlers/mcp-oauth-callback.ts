/**
 * MCP OAuth callback handler.
 *
 * This handler finalizes provider OAuth, updates pending-auth/event-log state,
 * and resumes the exact Slack turn that parked on MCP auth. Stale callbacks
 * must not resume newer thread work after another user message has superseded
 * the paused request.
 */
import { getStateAdapter } from "@/chat/state/adapter";
import { acquireActiveLock } from "@/chat/state/locks";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { hydrateConversationMessages } from "@/chat/conversations/visible-messages";
import {
  deleteMcpAuthSession,
  getMcpAuthSession,
  getMcpStoredOAuthCredentials,
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
import {
  buildDeliveredTurnStatePatch,
  buildRecoveredDeliveredTurnStatePatch,
} from "@/chat/runtime/delivered-turn-state";
import { recoverSlackDeliveryForTurn } from "@/chat/runtime/slack-delivery-recovery";
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
import {
  ResumeTurnBusyError,
  resumeAuthorizedRequest,
} from "@/chat/runtime/slack-resume";
import { persistAuthPauseTurnState } from "@/chat/runtime/auth-pause-state";
import {
  clearPendingAuth,
  getConversationPendingAuth,
  isPendingAuthLatestRequest,
} from "@/chat/services/pending-auth";
import {
  activateAgentTurnAuthorizationRecovery,
  createAgentTurnAuthorizationCompletionId,
  failAgentTurnSessionRecord,
  abandonAgentTurnSessionRecord,
  getAgentTurnSessionRecord,
} from "@/chat/state/turn-session";
import {
  loadProjection,
  recordAuthorizationCompleted,
} from "@/chat/conversations/projection";
import { markTurnFailed } from "@/chat/runtime/turn";
import {
  activateAndScheduleAgentTurnAuthorizationRecovery,
  prepareAgentTurnAuthorizationRecoveryUnderActiveLock,
  scheduleAgentContinue,
  wakeAuthorizationCompletedAgentTurn,
  type ScheduleAgentContinueOptions,
} from "@/chat/services/agent-continue";
import { htmlCallbackResponse } from "@/handlers/oauth-html";
import type { WaitUntilFn } from "@/handlers/types";
import { createSlackResumeActor, isUserActor, type Actor } from "@/chat/actor";
import { requireSlackDestination } from "@/chat/destination";
import type { ConversationTurnLifecycle } from "@/chat/conversations/turn-lifecycle";
import type { RecoverableSlackDelivery } from "@/chat/slack/recoverable-delivery";

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
      "This authorization link is no longer active. Return to Slack and retry the original request.",
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
  agentContinueOptions?: ScheduleAgentContinueOptions;
  recoverableSlackDelivery?: RecoverableSlackDelivery;
  turnLifecycle?: ConversationTurnLifecycle;
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

function htmlResponse(kind: keyof typeof CALLBACK_PAGES): Response {
  const page = CALLBACK_PAGES[kind];
  return htmlCallbackResponse(page.title, page.message, page.status);
}

async function persistCompletedReplyState(
  channelId: string,
  threadTs: string,
  sessionId: string,
  reply?: AgentRunResult,
): Promise<void> {
  const threadId = `slack:${channelId}:${threadTs}`;
  const currentState = await getPersistedThreadState(threadId);
  const conversation = coerceThreadConversationState(currentState);
  await hydrateConversationMessages({ conversation, conversationId: threadId });
  const artifacts = coerceThreadArtifactsState(currentState);
  const userMessage = getTurnUserMessage(conversation, sessionId);
  const statePatch = reply
    ? buildDeliveredTurnStatePatch({
        artifacts,
        conversation,
        reply,
        sessionId,
        userMessageId: userMessage?.id,
      })
    : buildRecoveredDeliveredTurnStatePatch({
        conversation,
        sessionId,
        inputMessageIds: userMessage ? [userMessage.id] : [],
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
  turnLifecycle?: ConversationTurnLifecycle;
  recoverableSlackDelivery?: RecoverableSlackDelivery;
}): Promise<void> {
  const {
    authSession,
    agentRunner,
    provider,
    recoverableSlackDelivery,
    turnLifecycle,
  } = args;
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
  const recoveredDelivery = await recoverSlackDeliveryForTurn({
    conversationId: authSession.conversationId,
    delivery: recoverableSlackDelivery,
    turnId: authSession.sessionId,
  });
  if (recoveredDelivery) {
    if (recoveredDelivery.outcome === "accepted") {
      await persistCompletedReplyState(
        authSession.channelId,
        authSession.threadTs,
        authSession.sessionId,
      );
    }
    return;
  }
  const sessionRecord = await getAgentTurnSessionRecord(
    authSession.conversationId,
    authSession.sessionId,
  );
  if (sessionRecord?.state === "completed") {
    const userMessage = getTurnUserMessage(conversation, authSession.sessionId);
    await persistThreadStateById(
      threadId,
      buildRecoveredDeliveredTurnStatePatch({
        conversation,
        sessionId: authSession.sessionId,
        inputMessageIds: userMessage ? [userMessage.id] : [],
      }),
    );
    return;
  }
  if (
    sessionRecord?.state === "failed" ||
    sessionRecord?.state === "abandoned"
  ) {
    clearPendingAuth(conversation, authSession.sessionId);
    if (conversation.processing.activeTurnId === authSession.sessionId) {
      conversation.processing.activeTurnId = undefined;
    }
    await persistThreadStateById(threadId, { conversation });
    return;
  }
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

  await resumeAuthorizedRequest({
    messageText: userMessage.text,
    channelId: authSession.channelId,
    threadTs: authSession.threadTs,
    messageTs: getTurnUserSlackMessageTs(userMessage),
    lockKey: threadId,
    connectedText: "",
    agentRunner,
    recoverableSlackDelivery,
    lifecycleCorrelation: {
      conversationId: authSession.conversationId,
      turnId: resolvedSessionId,
    },
    turnLifecycle,
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
        if (lockedConversation.processing.activeTurnId === lockedSessionId) {
          lockedConversation.processing.activeTurnId = undefined;
        }
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
        clearPendingAuth(lockedConversation, lockedSessionId);
        if (lockedConversation.processing.activeTurnId === lockedSessionId) {
          lockedConversation.processing.activeTurnId = undefined;
        }
        await persistThreadStateById(threadId, {
          conversation: lockedConversation,
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
        clearPendingAuth(lockedConversation, lockedSessionId);
        if (lockedConversation.processing.activeTurnId === lockedSessionId) {
          lockedConversation.processing.activeTurnId = undefined;
        }
        await persistThreadStateById(threadId, {
          conversation: lockedConversation,
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
        inputMessageIds: [lockedUserMessage.id],
        sliceId: lockedSessionRecord.sliceId,
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
              lockedConversation.processing.pendingAuth = nextPendingAuth;
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
        onRecoveredSuccess: async () => {
          await persistCompletedReplyState(
            authSession.channelId!,
            authSession.threadTs!,
            lockedSessionId,
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

async function isCurrentMcpAuthorizationAttempt(
  authSession: McpAuthSessionState,
  provider: string,
): Promise<boolean> {
  if (!authSession.channelId || !authSession.threadTs) {
    return false;
  }

  const threadId = `slack:${authSession.channelId}:${authSession.threadTs}`;
  const currentState = await getPersistedThreadState(threadId);
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

/** Exchange and persist one MCP callback while owning its exact parked turn. */
async function finalizeOwnedMcpAuthorization(args: {
  authorizationCode: string;
  pendingSession: McpAuthSessionState;
  provider: string;
  options: McpOAuthCallbackOptions;
  recovery?: {
    authorizationCompletionId: string;
    expectedVersion: number;
  };
}): Promise<McpAuthSessionState> {
  const stateAdapter = getStateAdapter();
  await stateAdapter.connect();
  const lock = await acquireActiveLock(
    stateAdapter,
    args.pendingSession.conversationId,
  );
  if (!lock) {
    throw new Error(
      `Could not acquire MCP OAuth callback lock for ${args.pendingSession.conversationId}`,
    );
  }
  try {
    const current = args.recovery
      ? await getAgentTurnSessionRecord(
          args.pendingSession.conversationId,
          args.pendingSession.sessionId,
        )
      : undefined;
    if (
      !(await isCurrentMcpAuthorizationAttempt(
        args.pendingSession,
        args.provider,
      ))
    ) {
      throw new McpOAuthAttemptExpiredError();
    }
    if (
      args.recovery &&
      (!current ||
        current.state !== "awaiting_resume" ||
        current.resumeReason !== "auth" ||
        current.version !== args.recovery.expectedVersion ||
        current.authorizationRecovery?.authorizationCompletionId !==
          args.recovery.authorizationCompletionId)
    ) {
      throw new McpOAuthAttemptExpiredError();
    }

    const authSession = await finalizeMcpAuthorization(
      args.provider,
      args.pendingSession.authSessionId,
      args.authorizationCode,
      async (mutation) => {
        if (
          !(await isCurrentMcpAuthorizationAttempt(
            args.pendingSession,
            args.provider,
          ))
        ) {
          throw new McpOAuthAttemptExpiredError();
        }
        return await mutation();
      },
      args.recovery?.authorizationCompletionId,
    );
    if (args.recovery) {
      const activated = await activateAgentTurnAuthorizationRecovery({
        authorizationCompletionId: args.recovery.authorizationCompletionId,
        conversationId: args.pendingSession.conversationId,
        expectedVersion: args.recovery.expectedVersion,
        sessionId: args.pendingSession.sessionId,
      });
      if (!activated?.destination) {
        throw new Error("MCP turn changed while activating callback recovery");
      }
      await scheduleAgentContinue(
        {
          conversationId: activated.conversationId,
          destination: activated.destination,
          expectedVersion: activated.version,
          sessionId: activated.sessionId,
        },
        args.options.agentContinueOptions,
      );
    }
    return authSession;
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

    const sessionRecord = await getAgentTurnSessionRecord(
      pendingSession.conversationId,
      pendingSession.sessionId,
    );
    const recoverableSession =
      sessionRecord?.state === "awaiting_resume" &&
      sessionRecord.resumeReason === "auth"
        ? sessionRecord
        : undefined;
    const prepared = recoverableSession
      ? await prepareAgentTurnAuthorizationRecoveryUnderActiveLock({
          authorizationCompletionId: createAgentTurnAuthorizationCompletionId({
            attemptId: state,
            authorizationKind: "mcp",
            provider,
          }),
          authorizationKind: "mcp",
          conversationId: pendingSession.conversationId,
          expectedVersion: recoverableSession.version,
          provider,
          sessionId: pendingSession.sessionId,
          userId: pendingSession.userId,
        })
      : undefined;
    if (recoverableSession && !prepared) {
      throw new Error("MCP turn changed while preparing callback recovery");
    }
    const recovery = prepared?.authorizationRecovery;
    const receiptCommitted = recovery
      ? recovery.active ||
        (await getMcpStoredOAuthCredentials(recovery.userId, recovery.provider))
          ?.authorizationCompletionId === recovery.authorizationCompletionId
      : false;
    let authSession: McpAuthSessionState;
    if (!receiptCommitted) {
      authSession = await finalizeOwnedMcpAuthorization({
        authorizationCode: code,
        pendingSession,
        provider,
        options,
        ...(prepared && recovery
          ? {
              recovery: {
                authorizationCompletionId: recovery.authorizationCompletionId,
                expectedVersion: prepared.version,
              },
            }
          : {}),
      });
    } else {
      authSession = pendingSession;
    }
    if (prepared && recovery && receiptCommitted) {
      const completed = await activateAndScheduleAgentTurnAuthorizationRecovery(
        {
          authorizationCompletionId: recovery.authorizationCompletionId,
          conversationId: prepared.conversationId,
          expectedVersion: prepared.version,
          sessionId: prepared.sessionId,
        },
        options.agentContinueOptions,
      );
      if (!completed) {
        throw new Error("MCP turn changed while activating callback recovery");
      }
    }
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

    waitUntil(async () => {
      try {
        await resumeAuthorizedMcpTurn({
          authSession,
          agentRunner: options.agentRunner,
          provider,
          recoverableSlackDelivery: options.recoverableSlackDelivery,
          turnLifecycle: options.turnLifecycle,
        });
      } catch (resumeError) {
        if (resumeError instanceof ResumeTurnBusyError) {
          await wakeAuthorizationCompletedAgentTurn(
            {
              conversationId: authSession.conversationId,
              provider,
              sessionId: authSession.sessionId,
            },
            options.agentContinueOptions,
          );
          return;
        }
        logException(
          resumeError,
          "mcp_oauth_callback_resume_failed",
          { conversationId: authSession.conversationId },
          {
            "app.ai.session_id": authSession.sessionId,
            "app.credential.provider": provider,
          },
          "Failed to resume MCP OAuth-authorized Slack turn",
        );
      }
    });

    return htmlResponse("success");
  } catch (callbackError) {
    if (callbackError instanceof McpOAuthAttemptExpiredError) {
      await deleteMcpAuthSession(state);
      return htmlResponse("expired");
    }
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
