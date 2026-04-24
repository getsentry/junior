import { createUserTokenStore } from "@/chat/capabilities/factory";
import { botConfig } from "@/chat/config";
import { hasRequiredOAuthScope } from "@/chat/credentials/oauth-scope";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import {
  formatProviderLabel,
  type OAuthStatePayload,
  resolveBaseUrl,
} from "@/chat/oauth-flow";
import { buildConversationContext } from "@/chat/services/conversation-memory";
import {
  generateConversationId,
  markConversationMessage,
  normalizeConversationText,
  updateConversationStats,
  upsertConversationMessage,
} from "@/chat/services/conversation-memory";
import { postSlackMessage } from "@/chat/slack/outbound";
import {
  ResumeTurnBusyError,
  resumeAuthorizedRequest,
  resumeSlackTurn,
} from "@/chat/slack/resume";
import { deliverAuthPauseReply } from "@/chat/runtime/auth-pause-reply";
import { logException, logInfo } from "@/chat/logging";
import { htmlCallbackResponse } from "@/handlers/oauth-html";
import {
  getChannelConfigurationServiceById,
  getPersistedSandboxState,
  getPersistedThreadState,
  mergeArtifactsState,
  persistThreadStateById,
} from "@/chat/runtime/thread-state";
import { getPluginOAuthConfig } from "@/chat/plugins/registry";
import {
  buildOAuthTokenRequest,
  parseOAuthTokenResponse,
} from "@/chat/plugins/auth/oauth-request";
import { buildThreadParticipants } from "@/chat/runtime/thread-participants";
import {
  getTurnUserMessage,
  getTurnUserReplyAttachmentContext,
} from "@/chat/runtime/turn-user-message";
import {
  isRetryableTurnError,
  markTurnCompleted,
  markTurnFailed,
} from "@/chat/runtime/turn";
import { publishAppHomeView } from "@/chat/slack/app-home";
import { getSlackClient } from "@/chat/slack/client";
import { getStateAdapter } from "@/chat/state/adapter";
import { coerceThreadArtifactsState } from "@/chat/state/artifacts";
import { getAgentTurnSessionCheckpoint } from "@/chat/state/turn-session-store";
import { supersedeAgentTurnSessionCheckpoint } from "@/chat/state/turn-session-store";
import {
  applyPendingAuthUpdate,
  clearPendingAuth,
  getConversationPendingAuth,
  isPendingAuthLatestRequest,
} from "@/chat/services/pending-auth";
import { escapeXml } from "@/chat/xml";
import type { WaitUntilFn } from "@/handlers/types";
import {
  canScheduleTurnTimeoutResume,
  scheduleTurnTimeoutResume,
} from "@/chat/services/timeout-resume";

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

async function buildResumeConversationContext(
  channelId: string,
  threadTs: string,
): Promise<string | undefined> {
  const conversation = coerceThreadConversationState(
    await getPersistedThreadState(`slack:${channelId}:${threadTs}`),
  );
  const latestUserMessageId = [...conversation.messages]
    .reverse()
    .find((message) => message.role === "user")?.id;
  return buildConversationContext(conversation, {
    excludeMessageId: latestUserMessageId,
  });
}

async function buildCheckpointConversationContext(
  conversationId: string,
  sessionId: string,
): Promise<string | undefined> {
  const conversation = coerceThreadConversationState(
    await getPersistedThreadState(conversationId),
  );
  const userMessage = getTurnUserMessage(conversation, sessionId);
  return buildConversationContext(conversation, {
    excludeMessageId: userMessage?.id,
  });
}

async function persistCompletedOAuthReplyState(args: {
  conversationId: string;
  sessionId: string;
  reply: {
    text: string;
    sandboxId?: string;
    sandboxDependencyProfileHash?: string;
    artifactStatePatch?: Record<string, unknown>;
  };
}): Promise<void> {
  const currentState = await getPersistedThreadState(args.conversationId);
  const conversation = coerceThreadConversationState(currentState);
  const artifacts = coerceThreadArtifactsState(currentState);
  const nextArtifacts = args.reply.artifactStatePatch
    ? mergeArtifactsState(artifacts, args.reply.artifactStatePatch)
    : undefined;
  const userMessage = getTurnUserMessage(conversation, args.sessionId);
  clearPendingAuth(conversation, args.sessionId);

  markConversationMessage(conversation, userMessage?.id, {
    replied: true,
    skippedReason: undefined,
  });
  upsertConversationMessage(conversation, {
    id: generateConversationId("assistant"),
    role: "assistant",
    text: normalizeConversationText(args.reply.text) || "[empty response]",
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

  await persistThreadStateById(args.conversationId, {
    artifacts: nextArtifacts,
    conversation,
    sandboxId: args.reply.sandboxId,
    sandboxDependencyProfileHash: args.reply.sandboxDependencyProfileHash,
  });
}

async function persistFailedOAuthReplyState(args: {
  conversationId: string;
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

  await persistThreadStateById(args.conversationId, {
    conversation,
  });
}

async function resumeCheckpointedOAuthTurn(
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

  const checkpoint = await getAgentTurnSessionCheckpoint(
    stored.resumeConversationId,
    stored.resumeSessionId,
  );
  if (!checkpoint) {
    return false;
  }
  // Terminal checkpoint states are already handled — do not fall through to
  // the pending-message resume which would re-post the original request.
  if (
    checkpoint.state === "completed" ||
    checkpoint.state === "failed" ||
    checkpoint.state === "superseded"
  ) {
    return true;
  }
  if (
    checkpoint.state !== "awaiting_resume" ||
    checkpoint.resumeReason !== "auth"
  ) {
    return true;
  }

  const currentState = await getPersistedThreadState(
    stored.resumeConversationId,
  );
  const conversation = coerceThreadConversationState(currentState);
  const artifacts = coerceThreadArtifactsState(currentState);
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
      await supersedeAgentTurnSessionCheckpoint({
        conversationId: stored.resumeConversationId,
        sessionId: pendingAuth.sessionId,
        errorMessage:
          "Auth completed after a newer thread message superseded this blocked request.",
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

  const conversationContext = await buildCheckpointConversationContext(
    stored.resumeConversationId,
    resolvedSessionId,
  );
  const channelConfiguration = getChannelConfigurationServiceById(
    stored.channelId,
  );

  await resumeSlackTurn({
    messageText: stored.pendingMessage ?? userMessage.text,
    channelId: stored.channelId,
    threadTs: stored.threadTs,
    lockKey: stored.resumeConversationId,
    initialText: "",
    failureText:
      "I connected your account but hit an error processing your request. Please try the command again.",
    replyContext: {
      assistant: { userName: botConfig.userName },
      requester: {
        userId: userMessage.author.userId,
        userName: userMessage.author.userName,
        fullName: userMessage.author.fullName,
      },
      correlation: {
        channelId: stored.channelId,
        threadTs: stored.threadTs,
        requesterId: userMessage.author.userId,
      },
      toolChannelId: artifacts.assistantContextChannelId ?? stored.channelId,
      artifactState: artifacts,
      pendingAuth,
      conversationContext,
      channelConfiguration,
      sandbox: getPersistedSandboxState(currentState),
      threadParticipants: buildThreadParticipants(conversation.messages),
      onAuthPending: async (nextPendingAuth) => {
        await applyPendingAuthUpdate({
          conversation,
          conversationId: stored.resumeConversationId,
          nextPendingAuth,
        });
        await persistThreadStateById(stored.resumeConversationId!, {
          conversation,
        });
      },
      ...getTurnUserReplyAttachmentContext(userMessage),
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
        "OAuth callback auto-resumed checkpoint finished replying",
      );
      await persistCompletedOAuthReplyState({
        conversationId: stored.resumeConversationId!,
        sessionId: resolvedSessionId,
        reply,
      });
    },
    onFailure: async (error) => {
      logException(
        error,
        "oauth_callback_resume_failed",
        {},
        { "app.credential.provider": stored.provider },
        "Failed to auto-resume checkpointed turn after OAuth callback",
      );
      await persistFailedOAuthReplyState({
        conversationId: stored.resumeConversationId!,
        sessionId: resolvedSessionId,
      });
    },
    onAuthPause: async (error) => {
      await deliverAuthPauseReply({
        channelId: stored.channelId!,
        conversationId: stored.resumeConversationId,
        error,
        fallbackProvider: stored.provider,
        sessionId: resolvedSessionId,
        threadStateId: stored.resumeConversationId!,
        threadTs: stored.threadTs!,
      });
    },
    onTimeoutPause: async (error) => {
      if (!isRetryableTurnError(error, "turn_timeout_resume")) {
        throw error;
      }
      const checkpointVersion = error.metadata?.checkpointVersion;
      const nextSliceId = error.metadata?.sliceId;
      if (typeof checkpointVersion !== "number") {
        throw new Error(
          "Timed-out OAuth resume did not include a checkpoint version",
        );
      }
      if (!canScheduleTurnTimeoutResume(nextSliceId)) {
        throw new Error(
          "Timed-out turn exceeded the automatic resume slice limit",
        );
      }
      await scheduleTurnTimeoutResume({
        conversationId: stored.resumeConversationId!,
        sessionId: resolvedSessionId,
        expectedCheckpointVersion: checkpointVersion,
      });
    },
  });

  return true;
}

async function resumePendingOAuthMessage(
  stored: OAuthStatePayload,
): Promise<void> {
  if (!stored.pendingMessage || !stored.channelId || !stored.threadTs) return;

  const conversationContext = await buildResumeConversationContext(
    stored.channelId,
    stored.threadTs,
  );
  await resumeAuthorizedRequest({
    messageText: stored.pendingMessage,
    channelId: stored.channelId,
    threadTs: stored.threadTs,
    connectedText: "",
    failureText: `I connected your account but hit an error processing your request. Please try \`${stored.pendingMessage}\` again.`,
    replyContext: {
      requester: { userId: stored.userId },
      conversationContext,
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
    onFailure: async (error) => {
      logException(
        error,
        "oauth_callback_resume_failed",
        {},
        { "app.credential.provider": stored.provider },
        "Failed to auto-resume pending message after OAuth callback",
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
        const resumed = await resumeCheckpointedOAuthTurn(stored);
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
