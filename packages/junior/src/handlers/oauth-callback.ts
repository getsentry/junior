import { THREAD_STATE_TTL_MS } from "chat";
import { createUserTokenStore } from "@/chat/capabilities/factory";
import { hasRequiredOAuthScope } from "@/chat/credentials/oauth-scope";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import {
  formatProviderLabel,
  parseOAuthStatePayload,
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
import { logException, logInfo, logWarn } from "@/chat/logging";
import { htmlCallbackResponse } from "@/handlers/oauth-html";
import {
  getChannelConfigurationServiceById,
  getPersistedSandboxState,
  getPersistedThreadState,
  persistThreadStateById,
} from "@/chat/runtime/thread-state";
import { buildDeliveredTurnStatePatch } from "@/chat/runtime/delivered-turn-state";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
import {
  buildOAuthTokenRequest,
  parseOAuthTokenResponse,
} from "@/chat/plugins/auth/oauth-request";
import { resolvePluginOAuthAccount } from "@/chat/plugins/credential-hooks";
import {
  getTurnUserMessage,
  getTurnUserSlackMessageTs,
  getTurnUserReplyAttachmentContext,
} from "@/chat/runtime/turn-user-message";
import { markTurnFailed } from "@/chat/runtime/turn";
import { publishAppHomeView } from "@/chat/slack/app-home";
import { getSlackClient } from "@/chat/slack/client";
import { createSlackResumeActor, isUserActor, type Actor } from "@/chat/actor";
import { lookupSlackActor } from "@/chat/slack/user";
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
import { scheduleAgentContinue } from "@/chat/services/agent-continue";
import type { AgentRunResult } from "@/chat/services/turn-result";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import { requireSlackDestination } from "@/chat/destination";

interface OAuthCallbackOptions {
  agentRunner: AgentRunner;
}

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
  reply: AgentRunResult;
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
  options: OAuthCallbackOptions,
): Promise<boolean> {
  if (
    !stored.resumeConversationId ||
    !stored.resumeSessionId ||
    !stored.channelId ||
    !stored.destination ||
    !stored.source ||
    !stored.threadTs
  ) {
    return false;
  }
  const destination = requireSlackDestination(
    stored.destination,
    "OAuth resume",
  );

  const currentState = await getPersistedThreadState(
    stored.resumeConversationId,
  );
  const conversation = coerceThreadConversationState(currentState);
  const pendingAuth = getConversationPendingAuth({
    conversation,
    kind: "plugin",
    provider: stored.provider,
    actorId: stored.userId,
    ...(stored.scope ? { scope: stored.scope } : {}),
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
  }

  const sessionRecord = await getAgentTurnSessionRecord(
    stored.resumeConversationId,
    resolvedSessionId,
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
  if (!userMessage?.author?.userId) {
    return false;
  }
  if (
    !pendingAuth &&
    conversation.processing.activeTurnId !== stored.resumeSessionId
  ) {
    return true;
  }

  await resumeSlackTurn({
    messageText: pendingAuth
      ? userMessage.text
      : (stored.pendingMessage ?? userMessage.text),
    channelId: stored.channelId,
    threadTs: stored.threadTs,
    messageTs: getTurnUserSlackMessageTs(userMessage),
    lockKey: stored.resumeConversationId,
    initialText: "",
    agentRunner: options.agentRunner,
    beforeStart: async () => {
      const lockedState = await getPersistedThreadState(
        stored.resumeConversationId!,
      );
      const lockedConversation = coerceThreadConversationState(lockedState);
      const lockedArtifacts = coerceThreadArtifactsState(lockedState);
      const lockedPendingAuth = getConversationPendingAuth({
        conversation: lockedConversation,
        kind: "plugin",
        provider: stored.provider,
        actorId: stored.userId,
        ...(stored.scope ? { scope: stored.scope } : {}),
      });
      const lockedSessionId =
        lockedPendingAuth?.sessionId ?? stored.resumeSessionId!;
      if (lockedSessionId !== resolvedSessionId) {
        return false;
      }
      const lockedSessionRecord = await getAgentTurnSessionRecord(
        stored.resumeConversationId!,
        lockedSessionId,
      );
      if (
        !lockedSessionRecord ||
        lockedSessionRecord.state !== "awaiting_resume" ||
        lockedSessionRecord.resumeReason !== "auth"
      ) {
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
      let actor: Actor;
      try {
        actor = createSlackResumeActor({
          actor: isUserActor(lockedSessionRecord.actor)
            ? lockedSessionRecord.actor
            : undefined,
          teamId: destination.teamId,
          userId: lockedUserMessage.author.userId,
        });
      } catch {
        await failAgentTurnSessionRecord({
          conversationId: stored.resumeConversationId!,
          expectedVersion: lockedSessionRecord.version,
          sessionId: lockedSessionId,
          errorMessage: "Stored Slack actor identity did not match OAuth actor",
        });
        return false;
      }
      if (!lockedSessionRecord.source) {
        await failAgentTurnSessionRecord({
          conversationId: stored.resumeConversationId!,
          expectedVersion: lockedSessionRecord.version,
          sessionId: lockedSessionId,
          errorMessage: "Stored Slack source missing for OAuth resume",
        });
        return false;
      }

      await recordAuthorizationCompleted({
        conversationId: stored.resumeConversationId!,
        kind: "plugin",
        provider: stored.provider,
        actorId: stored.userId,
        authorizationId: pluginAuthorizationId({
          provider: stored.provider,
          sessionId: lockedSessionId,
        }),
        ttlMs: THREAD_STATE_TTL_MS,
      });

      const lockedMessageTs = getTurnUserSlackMessageTs(lockedUserMessage);
      return {
        messageText: lockedPendingAuth
          ? lockedUserMessage.text
          : (stored.pendingMessage ?? lockedUserMessage.text),
        messageTs: lockedMessageTs,
        replyContext: {
          input: {
            conversationContext: lockedConversationContext,
            piMessages: lockedConversation.piMessages,
            ...getTurnUserReplyAttachmentContext(lockedUserMessage),
          },
          routing: {
            credentialContext: {
              actor: {
                type: "user",
                userId: actor.userId,
              },
            },
            actor,
            destination,
            source: lockedSessionRecord.source,
            correlation: {
              conversationId: stored.resumeConversationId!,
              turnId: lockedSessionId,
              channelId: stored.channelId!,
              threadTs: stored.threadTs!,
              actorId: actor.userId,
            },
            toolChannelId:
              lockedArtifacts.assistantContextChannelId ?? stored.channelId!,
          },
          policy: {
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
                conversationId: stored.resumeConversationId!,
                nextPendingAuth,
              });
              await persistThreadStateById(stored.resumeConversationId!, {
                conversation: lockedConversation,
              });
            },
          },
        },
        onSuccess: async (reply: AgentRunResult) => {
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
        onTimeoutPause: async ({ resumeVersion }) => {
          await scheduleAgentContinue({
            conversationId: stored.resumeConversationId!,
            destination,
            sessionId: lockedSessionId,
            expectedVersion: resumeVersion,
          });
        },
      };
    },
  });

  return true;
}

async function resumePendingOAuthMessage(
  stored: OAuthStatePayload,
  options: OAuthCallbackOptions,
): Promise<void> {
  const source = stored.source;
  if (
    !stored.pendingMessage ||
    !stored.channelId ||
    !stored.destination ||
    !source ||
    !stored.threadTs
  ) {
    return;
  }

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
  const destination = requireSlackDestination(
    stored.destination,
    "OAuth pending message resume",
  );
  const actor = await lookupSlackActor(destination.teamId, stored.userId);
  const messageTs = getTurnUserSlackMessageTs(latestUserMessage);
  await resumeAuthorizedRequest({
    messageText: stored.pendingMessage,
    channelId: stored.channelId,
    threadTs: stored.threadTs,
    messageTs,
    connectedText: "",
    agentRunner: options.agentRunner,
    replyContext: {
      input: {
        conversationContext,
        piMessages: conversation.piMessages,
      },
      routing: {
        credentialContext: {
          actor: { type: "user", userId: stored.userId },
        },
        actor,
        destination: stored.destination,
        source,
        correlation: {
          conversationId: threadId,
          channelId: stored.channelId,
          threadTs: stored.threadTs,
          actorId: stored.userId,
        },
      },
      policy: {
        configuration: stored.configuration,
      },
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
  options: OAuthCallbackOptions,
): Promise<Response> {
  const providerConfig = pluginCatalogRuntime.getOAuthConfig(provider);
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
  const stored = parseOAuthStatePayload(await stateAdapter.get(stateKey));
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
  const requestedScope = stored.scope ?? providerConfig.scope;

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

  let parsedTokenResponse;
  try {
    const tokenData = (await tokenResponse.json()) as Record<string, unknown>;
    parsedTokenResponse = parseOAuthTokenResponse(tokenData, requestedScope, {
      treatEmptyScopeAsUnreported: providerConfig.treatEmptyScopeAsUnreported,
    });
  } catch {
    return htmlErrorResponse(
      "Connection failed",
      "The provider returned an incomplete token response. Please try again.",
      500,
    );
  }

  if (!hasRequiredOAuthScope(parsedTokenResponse.scope, requestedScope)) {
    return htmlErrorResponse(
      "Connection failed",
      `The ${providerLabel} authorization did not grant the access Junior requires. Return to Slack and ask Junior to connect your ${providerLabel} account again.`,
      400,
    );
  }

  const userTokenStore = createUserTokenStore();
  let account: Awaited<ReturnType<typeof resolvePluginOAuthAccount>>;
  try {
    account = await resolvePluginOAuthAccount({
      provider,
      tokens: parsedTokenResponse,
    });
  } catch {
    return htmlErrorResponse(
      "Connection failed",
      `Junior could not verify the connected ${providerLabel} account. Please try again.`,
      500,
    );
  }
  await userTokenStore.set(stored.userId, provider, {
    ...parsedTokenResponse,
    ...(account ? { account } : {}),
  });

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
        const resumed = await resumeOAuthSessionRecordTurn(stored, options);
        if (!resumed) {
          await resumePendingOAuthMessage(stored, options);
        }
      } catch (error) {
        if (error instanceof ResumeTurnBusyError) {
          logWarn(
            "oauth_callback_resume_busy",
            {
              ...(stored.resumeConversationId && {
                conversationId: stored.resumeConversationId,
              }),
              ...(stored.userId && { actorId: stored.userId }),
              ...(stored.channelId && { channelId: stored.channelId }),
            },
            {
              "app.credential.provider": stored.provider,
              ...(stored.resumeSessionId && {
                "app.ai.session_id": stored.resumeSessionId,
              }),
            },
            "OAuth callback resume was busy; user must send another message to continue",
          );
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
