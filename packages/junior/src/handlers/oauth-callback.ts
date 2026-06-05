import { THREAD_STATE_TTL_MS } from "chat";
import { createUserTokenStore } from "@/chat/capabilities/factory";
import { hasRequiredOAuthScope } from "@/chat/credentials/oauth-scope";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import {
  formatProviderLabel,
  type OAuthStatePayload,
  resolveBaseUrl,
} from "@/chat/oauth-flow";
import { buildConversationContext } from "@/chat/services/conversation-memory";
import {
  markConversationMessage,
  updateConversationStats,
} from "@/chat/services/conversation-memory";
import { postSlackMessage } from "@/chat/slack/outbound";
import {
  ResumeTurnBusyError,
  resumeAuthorizedRequest,
  resumeSlackTurn,
} from "@/chat/runtime/slack-resume";
import { persistAuthPauseTurnState } from "@/chat/runtime/auth-pause-state";
import { logException, logInfo } from "@/chat/logging";
import { htmlCallbackResponse } from "@/handlers/oauth-html";
import {
  getChannelConfigurationServiceById,
  getPersistedSandboxState,
  getPersistedThreadState,
  persistThreadStateById,
} from "@/chat/runtime/thread-state";
import { buildDeliveredTurnStatePatch } from "@/chat/runtime/delivered-turn-state";
import { getPluginOAuthConfig } from "@/chat/plugins/registry";
import {
  buildOAuthTokenRequest,
  parseOAuthTokenResponse,
} from "@/chat/plugins/auth/oauth-request";
import {
  getTurnUserMessage,
  getTurnUserSlackMessageTs,
  getTurnUserReplyAttachmentContext,
} from "@/chat/runtime/turn-user-message";
import { isRetryableTurnError, markTurnFailed } from "@/chat/runtime/turn";
import { publishAppHomeView } from "@/chat/slack/app-home";
import { getSlackClient } from "@/chat/slack/client";
import { lookupSlackActorIdentity } from "@/chat/slack/user";
import { getStateAdapter } from "@/chat/state/adapter";
import { coerceThreadArtifactsState } from "@/chat/state/artifacts";
import {
  failAgentTurnSessionRecord,
  getAgentTurnSessionRecord,
  abandonAgentTurnSessionRecord,
} from "@/chat/state/turn-session";
import { recordAuthorizationCompleted } from "@/chat/state/session-log";
import {
  applyPendingAuthUpdate,
  clearPendingAuth,
  getConversationPendingAuth,
  isPendingAuthLatestRequest,
} from "@/chat/services/pending-auth";
import { escapeXml } from "@/chat/xml";
import type { WaitUntilFn } from "@/handlers/types";
import { scheduleTurnTimeoutResume } from "@/chat/services/timeout-resume";
import type { AssistantReply } from "@/chat/respond";

/**
 * OAuth callback contract for `@sentry/junior`.
 *
 * Providers redirect users to a concrete GET endpoint (`/api/oauth/callback/:provider`).
 * We complete token exchange synchronously for correctness, then use `waitUntil(...)`
 * for best-effort Slack side effects so the browser response returns quickly.
 */
function htmlErrorResponse(
  title: string,
  message: string,
  status: number,
): Response {
  return htmlCallbackResponse(escapeXml(title), escapeXml(message), status);
}

async function persistCompletedOAuthReplyState(args: {
  conversationId: string;
  sessionId: string;
  reply: AssistantReply;
}): Promise<void> {
  const currentState = await getPersistedThreadState(args.conversationId);
  const conversation = coerceThreadConversationState(currentState);
  const artifacts = coerceThreadArtifactsState(currentState);
  const userMessage = getTurnUserMessage(conversation, args.sessionId);
  const statePatch = buildDeliveredTurnStatePatch({
    artifacts,
    conversation,
    reply: args.reply,
    sessionId: args.sessionId,
    userMessageId: userMessage?.id,
  });

  await persistThreadStateById(args.conversationId, {
    ...statePatch,
  });
}

function pluginAuthorizationId(args: {
  provider: string;
  sessionId: string;
}): string {
  return `${args.sessionId}:plugin:${args.provider}`;
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
      expectedVersion: args.expectedVersion,
      sessionId: args.sessionId,
      errorMessage: args.errorMessage,
    });
  } catch (error) {
    logException(
      error,
      "oauth_callback_session_record_fail_persist_failed",
      {},
      {
        "app.ai.conversation_id": args.conversationId,
        "app.ai.session_id": args.sessionId,
      },
      "Failed to mark OAuth-resumed turn session record failed",
    );
  }
}

async function persistFailedOAuthReplyState(args: {
  conversationId: string;
  expectedVersion: number;
  sessionId: string;
}): Promise<void> {
  const currentState = await getPersistedThreadState(args.conversationId);
  const conversation = coerceThreadConversationState(currentState);
  clearPendingAuth(conversation, args.sessionId);

  markTurnFailed({
    conversation,
    nowMs: Date.now(),
    sessionId: args.sessionId,
    userMessageId: getTurnUserMessage(conversation, args.sessionId)?.id,
    markConversationMessage,
    updateConversationStats,
  });

  await failSessionRecordBestEffort({
    conversationId: args.conversationId,
    expectedVersion: args.expectedVersion,
    sessionId: args.sessionId,
    errorMessage: "OAuth-resumed turn failed",
  });
  await persistThreadStateById(args.conversationId, {
    conversation,
  });
}

async function resumeOAuthSessionRecordTurn(
  stored: OAuthStatePayload,
): Promise<boolean> {
  if (
    !stored.resumeConversationId ||
    !stored.resumeSessionId ||
    !stored.channelId ||
    !stored.threadTs
  ) {
    return false;
  }

  const sessionRecord = await getAgentTurnSessionRecord(
    stored.resumeConversationId,
    stored.resumeSessionId,
  );
  if (!sessionRecord) {
    return false;
  }
  // Terminal session record states are already handled; do not fall through to
  // the pending-message resume which would re-post the original request.
  if (
    sessionRecord.state === "completed" ||
    sessionRecord.state === "failed" ||
    sessionRecord.state === "abandoned"
  ) {
    return true;
  }
  if (
    sessionRecord.state !== "awaiting_resume" ||
    sessionRecord.resumeReason !== "auth"
  ) {
    return true;
  }

  const currentState = await getPersistedThreadState(
    stored.resumeConversationId,
  );
  const conversation = coerceThreadConversationState(currentState);
  const pendingAuth = getConversationPendingAuth({
    conversation,
    kind: "plugin",
    provider: stored.provider,
    requesterId: stored.userId,
  });

  const resolvedSessionId = pendingAuth?.sessionId ?? stored.resumeSessionId;
  const userMessage = resolvedSessionId
    ? getTurnUserMessage(conversation, resolvedSessionId)
    : undefined;
  if (pendingAuth) {
    if (!isPendingAuthLatestRequest(conversation, pendingAuth)) {
      clearPendingAuth(conversation, pendingAuth.sessionId);
      await persistThreadStateById(stored.resumeConversationId, {
        conversation,
      });
      await abandonAgentTurnSessionRecord({
        conversationId: stored.resumeConversationId,
        sessionId: pendingAuth.sessionId,
        errorMessage:
          "Auth completed after a newer thread message abandoned this blocked request.",
      });
      return true;
    }
  } else {
    if (!userMessage?.author?.userId) {
      return false;
    }
    if (conversation.processing.activeTurnId !== stored.resumeSessionId) {
      return true;
    }
  }
  if (!userMessage?.author?.userId || !resolvedSessionId) {
    return false;
  }

  await resumeSlackTurn({
    messageText: stored.pendingMessage ?? userMessage.text,
    channelId: stored.channelId,
    threadTs: stored.threadTs,
    messageTs: getTurnUserSlackMessageTs(userMessage),
    lockKey: stored.resumeConversationId,
    initialText: "",
    beforeStart: async () => {
      const lockedSessionRecord = await getAgentTurnSessionRecord(
        stored.resumeConversationId!,
        stored.resumeSessionId!,
      );
      if (
        !lockedSessionRecord ||
        lockedSessionRecord.state !== "awaiting_resume" ||
        lockedSessionRecord.resumeReason !== "auth"
      ) {
        return false;
      }

      const lockedState = await getPersistedThreadState(
        stored.resumeConversationId!,
      );
      const lockedConversation = coerceThreadConversationState(lockedState);
      const lockedArtifacts = coerceThreadArtifactsState(lockedState);
      const lockedPendingAuth = getConversationPendingAuth({
        conversation: lockedConversation,
        kind: "plugin",
        provider: stored.provider,
        requesterId: stored.userId,
      });
      const lockedSessionId =
        lockedPendingAuth?.sessionId ?? stored.resumeSessionId!;
      if (lockedSessionId !== resolvedSessionId) {
        return false;
      }
      if (lockedPendingAuth) {
        if (
          !isPendingAuthLatestRequest(lockedConversation, lockedPendingAuth)
        ) {
          clearPendingAuth(lockedConversation, lockedPendingAuth.sessionId);
          await persistThreadStateById(stored.resumeConversationId!, {
            conversation: lockedConversation,
          });
          await abandonAgentTurnSessionRecord({
            conversationId: stored.resumeConversationId!,
            sessionId: lockedPendingAuth.sessionId,
            errorMessage:
              "Auth completed after a newer thread message abandoned this blocked request.",
          });
          return false;
        }
      } else if (
        lockedConversation.processing.activeTurnId !== stored.resumeSessionId
      ) {
        return false;
      }

      const lockedUserMessage = getTurnUserMessage(
        lockedConversation,
        lockedSessionId,
      );
      if (!lockedUserMessage?.author?.userId) {
        return false;
      }

      const lockedConversationContext = buildConversationContext(
        lockedConversation,
        {
          excludeMessageId: lockedUserMessage.id,
        },
      );
      const lockedChannelConfiguration = getChannelConfigurationServiceById(
        stored.channelId!,
      );

      await recordAuthorizationCompleted({
        conversationId: stored.resumeConversationId!,
        kind: "plugin",
        provider: stored.provider,
        requesterId: stored.userId,
        authorizationId: pluginAuthorizationId({
          provider: stored.provider,
          sessionId: lockedSessionId,
        }),
        ttlMs: THREAD_STATE_TTL_MS,
      });
      const requester = await lookupSlackActorIdentity(
        lockedUserMessage.author.userId,
      );

      return {
        messageText: stored.pendingMessage ?? lockedUserMessage.text,
        messageTs: getTurnUserSlackMessageTs(lockedUserMessage),
        replyContext: {
          credentialContext: {
            actor: {
              type: "user",
              userId: lockedUserMessage.author.userId,
            },
          },
          requester,
          correlation: {
            conversationId: stored.resumeConversationId!,
            turnId: lockedSessionId,
            channelId: stored.channelId!,
            threadTs: stored.threadTs!,
            requesterId: lockedUserMessage.author.userId,
          },
          toolChannelId:
            lockedArtifacts.assistantContextChannelId ?? stored.channelId!,
          artifactState: lockedArtifacts,
          pendingAuth: lockedPendingAuth,
          conversationContext: lockedConversationContext,
          channelConfiguration: lockedChannelConfiguration,
          piMessages: lockedConversation.piMessages,
          sandbox: getPersistedSandboxState(lockedState),
          onAuthPending: async (nextPendingAuth) => {
            await applyPendingAuthUpdate({
              conversation: lockedConversation,
              conversationId: stored.resumeConversationId!,
              nextPendingAuth,
            });
            await persistThreadStateById(stored.resumeConversationId!, {
              conversation: lockedConversation,
            });
          },
          ...getTurnUserReplyAttachmentContext(lockedUserMessage),
        },
        onSuccess: async (reply: AssistantReply) => {
          logInfo(
            "oauth_callback_resume_complete",
            {},
            {
              "app.credential.provider": stored.provider,
              "app.ai.outcome": reply.diagnostics.outcome,
              "app.ai.tool_calls": reply.diagnostics.toolCalls.length,
            },
            "OAuth callback auto-resumed session record finished replying",
          );
          await persistCompletedOAuthReplyState({
            conversationId: stored.resumeConversationId!,
            sessionId: lockedSessionId,
            reply,
          });
        },
        onPostDeliveryCommitFailure: async () => {
          await failAgentTurnSessionRecord({
            conversationId: stored.resumeConversationId!,
            expectedVersion: lockedSessionRecord.version,
            sessionId: lockedSessionId,
            errorMessage:
              "OAuth-resumed reply was delivered but completion state did not persist",
          });
        },
        onFailure: async () => {
          await persistFailedOAuthReplyState({
            conversationId: stored.resumeConversationId!,
            expectedVersion: lockedSessionRecord.version,
            sessionId: lockedSessionId,
          });
        },
        onAuthPause: async () => {
          await persistAuthPauseTurnState({
            sessionId: lockedSessionId,
            threadStateId: stored.resumeConversationId!,
          });
        },
        onTimeoutPause: async (error: unknown) => {
          if (!isRetryableTurnError(error, "turn_timeout_resume")) {
            throw error;
          }
          const version = error.metadata?.version;
          if (typeof version !== "number") {
            throw new Error(
              "Timed-out OAuth resume did not include a turn-session version",
            );
          }
          await scheduleTurnTimeoutResume({
            conversationId: stored.resumeConversationId!,
            sessionId: lockedSessionId,
            expectedVersion: version,
          });
        },
      };
    },
  });

  return true;
}

async function resumePendingOAuthMessage(
  stored: OAuthStatePayload,
): Promise<void> {
  if (!stored.pendingMessage || !stored.channelId || !stored.threadTs) return;

  const threadId = `slack:${stored.channelId}:${stored.threadTs}`;
  const conversation = coerceThreadConversationState(
    await getPersistedThreadState(threadId),
  );
  const latestUserMessage = [...conversation.messages]
    .reverse()
    .find((message) => message.role === "user");
  const conversationContext = buildConversationContext(conversation, {
    excludeMessageId: latestUserMessage?.id,
  });
  const requester = await lookupSlackActorIdentity(stored.userId);
  await resumeAuthorizedRequest({
    messageText: stored.pendingMessage,
    channelId: stored.channelId,
    threadTs: stored.threadTs,
    messageTs: getTurnUserSlackMessageTs(latestUserMessage),
    connectedText: "",
    replyContext: {
      credentialContext: {
        actor: { type: "user", userId: stored.userId },
      },
      requester,
      conversationContext,
      piMessages: conversation.piMessages,
      configuration: stored.configuration,
    },
    onSuccess: async (reply) => {
      logInfo(
        "oauth_callback_resume_complete",
        {},
        {
          "app.credential.provider": stored.provider,
          "app.ai.outcome": reply.diagnostics.outcome,
          "app.ai.tool_calls": reply.diagnostics.toolCalls.length,
        },
        "OAuth callback auto-resumed pending message finished replying",
      );
    },
  });
}

export async function GET(
  request: Request,
  provider: string,
  waitUntil: WaitUntilFn,
): Promise<Response> {
  const providerConfig = getPluginOAuthConfig(provider);
  if (!providerConfig) {
    return htmlErrorResponse(
      "Unknown provider",
      "The OAuth provider in this link is not recognized.",
      404,
    );
  }

  const providerLabel = formatProviderLabel(provider);
  const url = new URL(request.url);
  const errorParam = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (errorParam) {
    if (state) {
      const cleanupAdapter = getStateAdapter();
      await cleanupAdapter.delete(`oauth-state:${state}`);
    }

    if (errorParam === "access_denied") {
      return htmlErrorResponse(
        "Authorization declined",
        `You declined the ${providerLabel} authorization request. Return to Slack and ask Junior to connect your ${providerLabel} account again if you change your mind.`,
        400,
      );
    }
    return htmlErrorResponse(
      "Authorization failed",
      `${providerLabel} returned an error: ${errorParam}. Return to Slack and try again.`,
      400,
    );
  }

  if (!code || !state) {
    return htmlErrorResponse(
      "Invalid request",
      "This authorization link is missing required parameters.",
      400,
    );
  }

  const stateAdapter = getStateAdapter();
  const stateKey = `oauth-state:${state}`;
  const stored = await stateAdapter.get<OAuthStatePayload>(stateKey);
  if (!stored) {
    return htmlErrorResponse(
      "Link expired",
      `This authorization link has expired (links are valid for 10 minutes). Return to Slack and ask Junior to connect your ${providerLabel} account again to get a new link.`,
      400,
    );
  }

  if (stored.provider !== provider) {
    return htmlErrorResponse(
      "Provider mismatch",
      "This authorization link does not match the expected provider.",
      400,
    );
  }

  await stateAdapter.delete(stateKey);

  const clientId = process.env[providerConfig.clientIdEnv]?.trim();
  const clientSecret = process.env[providerConfig.clientSecretEnv]?.trim();
  if (!clientId || !clientSecret) {
    return htmlErrorResponse(
      "Configuration error",
      "OAuth client credentials are not configured on the server.",
      500,
    );
  }

  const baseUrl = resolveBaseUrl();
  if (!baseUrl) {
    return htmlErrorResponse(
      "Configuration error",
      "The server cannot determine its base URL.",
      500,
    );
  }

  const redirectUri = `${baseUrl}${providerConfig.callbackPath}`;

  let tokenResponse: Response;
  try {
    const tokenRequest = buildOAuthTokenRequest({
      clientId,
      clientSecret,
      payload: {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      },
      tokenAuthMethod: providerConfig.tokenAuthMethod,
      tokenExtraHeaders: providerConfig.tokenExtraHeaders,
    });
    tokenResponse = await fetch(providerConfig.tokenEndpoint, {
      method: "POST",
      headers: tokenRequest.headers,
      body: tokenRequest.body,
    });
  } catch {
    return htmlErrorResponse(
      "Connection failed",
      "Failed to exchange the authorization code. Please try again.",
      500,
    );
  }

  if (!tokenResponse.ok) {
    return htmlErrorResponse(
      "Connection failed",
      "The token exchange with the provider failed. Please try again.",
      500,
    );
  }

  const tokenData = (await tokenResponse.json()) as Record<string, unknown>;
  let parsedTokenResponse;
  try {
    parsedTokenResponse = parseOAuthTokenResponse(
      tokenData,
      providerConfig.scope,
    );
  } catch {
    return htmlErrorResponse(
      "Connection failed",
      "The provider returned an incomplete token response. Please try again.",
      500,
    );
  }

  if (!hasRequiredOAuthScope(parsedTokenResponse.scope, providerConfig.scope)) {
    return htmlErrorResponse(
      "Connection failed",
      `The ${providerLabel} authorization did not grant the access Junior requires. Return to Slack and ask Junior to connect your ${providerLabel} account again.`,
      400,
    );
  }

  const userTokenStore = createUserTokenStore();
  await userTokenStore.set(stored.userId, provider, parsedTokenResponse);

  waitUntil(async () => {
    try {
      await publishAppHomeView(getSlackClient(), stored.userId, userTokenStore);
    } catch {
      // best effort
    }
  });

  if (stored.pendingMessage && stored.channelId && stored.threadTs) {
    waitUntil(async () => {
      try {
        const resumed = await resumeOAuthSessionRecordTurn(stored);
        if (!resumed) {
          await resumePendingOAuthMessage(stored);
        }
      } catch (error) {
        if (error instanceof ResumeTurnBusyError) {
          return;
        }
        throw error;
      }
    });
  } else if (stored.channelId && stored.threadTs) {
    const { channelId, threadTs } = stored;
    waitUntil(() =>
      postSlackMessage({
        channelId,
        threadTs,
        text: `Your ${providerLabel} account is now connected. You can start using ${providerLabel} commands.`,
      }),
    );
  }

  const statusMessage = stored.pendingMessage
    ? "Your request is being processed in Slack."
    : "You can close this tab and return to Slack.";
  const html = `<!DOCTYPE html>
<html>
<head><title>${providerLabel} Connected</title></head>
<body style="font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0;">
  <div style="text-align: center;">
    <h1>${providerLabel} account connected</h1>
    <p>${statusMessage}</p>
  </div>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
