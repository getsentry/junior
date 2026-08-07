import { createUserTokenStore } from "@/chat/capabilities/factory";
import { hasRequiredOAuthScope } from "@/chat/credentials/oauth-scope";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { hydrateConversationMessages } from "@/chat/conversations/messages";
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
  resumeSlackTurn,
} from "@/chat/runtime/slack-resume";
import { persistAuthPauseTurnState } from "@/chat/runtime/auth-pause-state";
import { logException, logInfo, logWarn, withLogContext } from "@/chat/logging";
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
import { createSlackResumeActor, type Actor } from "@/chat/actor";
import { getStateAdapter } from "@/chat/state/adapter";
import { coerceThreadArtifactsState } from "@/chat/state/artifacts";
import {
  failAgentTurnSessionRecord,
  getAgentTurnSessionRecord,
  abandonAgentTurnSessionRecord,
} from "@/chat/state/turn-session";
import {
  loadProjection,
  recordAuthenticationLinked,
  recordAuthorizationCompleted,
} from "@/chat/conversations/projection";
import {
  clearPendingAuth,
  getConversationPendingAuth,
  isPendingAuthLatestRequest,
} from "@/chat/services/pending-auth";
import { escapeXml } from "@/chat/xml";
import type { WaitUntilFn } from "@/handlers/types";
import { scheduleAgentContinue } from "@/chat/services/agent-continue";
import {
  resolveTurnSessionRouting,
  type TurnSessionRouting,
} from "@/chat/services/turn-session-routing";
import type { AgentRunResult } from "@/chat/services/turn-result";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import { requireSlackDestination } from "@/chat/destination";
import { relayLocalOAuthCallback } from "@/chat/local/oauth-relay";

interface OAuthCallbackOptions {
  agentRunner: AgentRunner;
}

/**
 * OAuth callback contract for `@sentry/junior`.
 *
 * Providers redirect users to `/api/oauth/callback/:provider`. A public signed
 * callback relays to the owning CLI; the loopback callback exchanges and stores
 * the local credential while the CLI owns continuation. Slack callbacks
 * exchange credentials synchronously, then use `waitUntil(...)` for
 * best-effort resume side effects.
 */
function htmlErrorResponse(
  title: string,
  message: string,
  status: number,
): Response {
  return htmlCallbackResponse(escapeXml(title), escapeXml(message), status);
}

function oauthTokenErrorAttributes(
  provider: string,
  endpoint: string,
  status?: number,
): Record<string, string | number> {
  return {
    "app.credential.provider": provider,
    "app.oauth.error.phase": "token_exchange",
    "server.address": new URL(endpoint).hostname,
    ...(status !== undefined ? { "http.response.status_code": status } : {}),
  };
}

async function persistCompletedOAuthReplyState(args: {
  conversationId: string;
  sessionId: string;
  reply: AgentRunResult;
}): Promise<void> {
  const currentState = await getPersistedThreadState(args.conversationId);
  const conversation = coerceThreadConversationState(currentState);
  await hydrateConversationMessages({
    conversation,
    conversationId: args.conversationId,
  });
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
      "oauth.callback.session_record.failure_persistence.failed",
      {
        "app.ai.conversation_id": args.conversationId,
        "app.ai.session_id": args.sessionId,
      },
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
  await hydrateConversationMessages({
    conversation,
    conversationId: args.conversationId,
  });
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
): Promise<void> {
  if (
    !stored.resumeConversationId ||
    !stored.resumeSessionId ||
    !stored.channelId ||
    !stored.destination ||
    !stored.source ||
    !stored.threadTs
  ) {
    return;
  }
  const destination = requireSlackDestination(
    stored.destination,
    "OAuth resume",
  );

  const currentState = await getPersistedThreadState(
    stored.resumeConversationId,
  );
  const conversation = coerceThreadConversationState(currentState);
  await hydrateConversationMessages({
    conversation,
    conversationId: stored.resumeConversationId,
  });
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
      return;
    }
  }

  const sessionRecord = await getAgentTurnSessionRecord(
    stored.resumeConversationId,
    resolvedSessionId,
  );
  if (!sessionRecord) {
    return;
  }
  // Terminal session record states are already handled.
  if (
    sessionRecord.state === "completed" ||
    sessionRecord.state === "failed" ||
    sessionRecord.state === "abandoned"
  ) {
    return;
  }
  if (
    sessionRecord.state !== "awaiting_resume" ||
    sessionRecord.resumeReason !== "auth"
  ) {
    return;
  }
  if (!userMessage?.author?.userId) {
    return;
  }
  if (
    !pendingAuth &&
    conversation.processing.activeTurnId !== stored.resumeSessionId
  ) {
    return;
  }

  await resumeSlackTurn({
    messageText: userMessage.text,
    conversationId: stored.resumeConversationId,
    turnId: resolvedSessionId,
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
      await hydrateConversationMessages({
        conversation: lockedConversation,
        conversationId: stored.resumeConversationId!,
      });
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
          teamId: destination.teamId,
          userId: lockedUserMessage.author.userId,
        });
      } catch {
        await failAgentTurnSessionRecord({
          conversationId: stored.resumeConversationId!,
          expectedVersion: lockedSessionRecord.version,
          sessionId: lockedSessionId,
          errorMessage: "Unable to rebuild Slack actor for OAuth resume",
        });
        return false;
      }
      let routing: TurnSessionRouting;
      try {
        routing = await resolveTurnSessionRouting({
          conversationId: stored.resumeConversationId!,
        });
      } catch (error) {
        await failAgentTurnSessionRecord({
          conversationId: stored.resumeConversationId!,
          expectedVersion: lockedSessionRecord.version,
          sessionId: lockedSessionId,
          errorMessage: error instanceof Error ? error.message : String(error),
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
            piMessages: await loadProjection({
              conversationId: stored.resumeConversationId!,
            }),
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
            source: routing.source,
            toolChannelId:
              lockedArtifacts.assistantContextChannelId ?? stored.channelId!,
          },
          policy: {
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
              await persistThreadStateById(stored.resumeConversationId!, {
                conversation: lockedConversation,
              });
            },
          },
        },
        commitResult: async (reply: AgentRunResult) => {
          logInfo("oauth.callback.resume.completed", {
            "app.credential.provider": stored.provider,
            "app.ai.outcome": reply.diagnostics.outcome,
            "app.ai.tool_calls": reply.diagnostics.toolCalls.length,
          });
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
        onSuspend: async (resumeVersion) => {
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
}

export async function GET(
  request: Request,
  provider: string,
  waitUntil: WaitUntilFn,
  options: OAuthCallbackOptions,
): Promise<Response> {
  const localRelay = await relayLocalOAuthCallback(request);
  if (localRelay) {
    return localRelay;
  }
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
        `You declined the ${providerLabel} authorization request. Return to Junior and connect your ${providerLabel} account again if you change your mind.`,
        400,
      );
    }
    return htmlErrorResponse(
      "Authorization failed",
      `${providerLabel} returned an error: ${errorParam}. Return to Junior and try again.`,
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
      `This authorization link has expired (links are valid for 10 minutes). Return to Junior and connect your ${providerLabel} account again to get a new link.`,
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
    logWarn(
      "oauth.token_exchange.failed",
      oauthTokenErrorAttributes(provider, providerConfig.tokenEndpoint),
    );
    return htmlErrorResponse(
      "Connection failed",
      "Failed to exchange the authorization code. Please try again.",
      500,
    );
  }

  if (!tokenResponse.ok) {
    logWarn(
      "oauth.token_exchange.failed",
      oauthTokenErrorAttributes(
        provider,
        providerConfig.tokenEndpoint,
        tokenResponse.status,
      ),
    );
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
    logWarn(
      "oauth.token_exchange.failed",
      oauthTokenErrorAttributes(
        provider,
        providerConfig.tokenEndpoint,
        tokenResponse.status,
      ),
    );
    return htmlErrorResponse(
      "Connection failed",
      "The provider returned an incomplete token response. Please try again.",
      500,
    );
  }

  if (!hasRequiredOAuthScope(parsedTokenResponse.scope, requestedScope)) {
    return htmlErrorResponse(
      "Connection failed",
      `The ${providerLabel} authorization did not grant the access Junior requires. Return to Junior and connect your ${providerLabel} account again.`,
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

  if (stored.resumeConversationId) {
    try {
      await recordAuthenticationLinked({
        conversationId: stored.resumeConversationId,
        provider,
        actorId: stored.userId,
        providerLabel,
        ...(account?.label ? { accountLabel: account.label } : {}),
        ...(stored.resumeSessionId
          ? {
              authorizationId: pluginAuthorizationId({
                provider,
                sessionId: stored.resumeSessionId,
              }),
              turnId: stored.resumeSessionId,
            }
          : {}),
      });
    } catch (error) {
      logException(error, "oauth.callback.authentication_event.failed", {
        "app.credential.provider": provider,
      });
    }
  }

  if (stored.destination?.platform !== "local") {
    waitUntil(async () => {
      try {
        await publishAppHomeView(
          getSlackClient(),
          stored.userId,
          userTokenStore,
        );
      } catch {
        // best effort
      }
    });
  }

  const resumesAgentTurn = Boolean(
    stored.destination?.platform !== "local" &&
    stored.resumeConversationId &&
    stored.resumeSessionId,
  );
  if (resumesAgentTurn) {
    waitUntil(() =>
      withLogContext(
        { conversationId: stored.resumeConversationId },
        async () => {
          try {
            // Agent OAuth links resume their durable session record. Do not
            // rebuild a turn from pending message text when that record is
            // missing.
            await resumeOAuthSessionRecordTurn(stored, options);
          } catch (error) {
            if (error instanceof ResumeTurnBusyError) {
              logWarn("oauth.callback.resume.busy", {
                "app.credential.provider": stored.provider,
                ...(stored.resumeSessionId && {
                  "app.ai.session_id": stored.resumeSessionId,
                }),
              });
              return;
            }
            throw error;
          }
        },
      ),
    );
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

  const statusMessage =
    stored.destination?.platform === "local"
      ? "Your request is continuing in the local Junior client."
      : resumesAgentTurn
        ? "Your request is being processed in Slack."
        : `Your ${providerLabel} account is connected.`;
  const footerMessage =
    stored.destination?.platform === "local"
      ? "You can close this tab and return to Junior."
      : "You can close this tab and return to Slack.";
  return htmlCallbackResponse(
    escapeXml(`${providerLabel} account connected`),
    escapeXml(statusMessage),
    200,
    { footerMessage: escapeXml(footerMessage) },
  );
}
