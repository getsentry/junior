import { createUserTokenStore } from "@/chat/capabilities/factory";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import {
  formatProviderLabel,
  type OAuthStatePayload,
  resolveBaseUrl,
} from "@/chat/oauth-flow";
import { buildConversationContext } from "@/chat/services/conversation-memory";
import {
  resumeAuthorizedRequest,
  postSlackMessage,
} from "@/handlers/oauth-resume";
import { logException, logInfo } from "@/chat/logging";
import { htmlCallbackResponse } from "@/handlers/html";
import { getPersistedThreadState } from "@/chat/runtime/thread-state";
import { getPluginOAuthConfig } from "@/chat/plugins/registry";
import {
  buildOAuthTokenRequest,
  parseOAuthTokenResponse,
} from "@/chat/plugins/auth/oauth-request";
import { publishAppHomeView } from "@/chat/slack/app-home";
import { getSlackClient } from "@/chat/slack/client";
import { getStateAdapter } from "@/chat/state/adapter";
import { escapeXml } from "@/chat/xml";
import type { WaitUntilFn } from "@/handlers/types";

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

async function resumePendingOAuthMessage(
  stored: OAuthStatePayload,
): Promise<void> {
  if (!stored.pendingMessage || !stored.channelId || !stored.threadTs) return;

  const providerLabel = formatProviderLabel(stored.provider);
  const conversationContext = await buildResumeConversationContext(
    stored.channelId,
    stored.threadTs,
  );
  await resumeAuthorizedRequest({
    messageText: stored.pendingMessage,
    requesterUserId: stored.userId,
    provider: stored.provider,
    channelId: stored.channelId,
    threadTs: stored.threadTs,
    connectedText: `Your ${providerLabel} account is now connected. Processing your request...`,
    failureText: `I connected your account but hit an error processing your request. Please try \`${stored.pendingMessage}\` again.`,
    conversationContext,
    configuration: stored.configuration,
    onSuccess: async (reply) => {
      logInfo(
        "oauth_callback_resume_complete",
        {},
        {
          "app.credential.provider": stored.provider,
          "app.ai.outcome": reply.diagnostics.outcome,
          "app.ai.tool_calls": reply.diagnostics.toolCalls.length,
        },
        "Auto-resumed pending message after OAuth callback",
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
    parsedTokenResponse = parseOAuthTokenResponse(tokenData);
  } catch {
    return htmlErrorResponse(
      "Connection failed",
      "The provider returned an incomplete token response. Please try again.",
      500,
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
    waitUntil(() => resumePendingOAuthMessage(stored));
  } else if (stored.channelId && stored.threadTs) {
    const { channelId, threadTs } = stored;
    waitUntil(() =>
      postSlackMessage(
        channelId,
        threadTs,
        `Your ${providerLabel} account is now connected. You can start using ${providerLabel} commands.`,
      ),
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
