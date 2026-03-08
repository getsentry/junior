import { after } from "next/server";
import { getUserTokenStore } from "@/chat/capabilities/factory";
import { getOAuthProviderConfig, resolveBaseUrl, type OAuthStatePayload } from "@/chat/capabilities/jr-rpc-command";
import { botConfig } from "@/chat/config";
import type { ChannelConfigurationService } from "@/chat/configuration/types";
import { logException, logInfo } from "@/chat/observability";
import { generateAssistantReply } from "@/chat/respond";
import { publishAppHomeView } from "@/chat/app-home";
import { getSlackClient } from "@/chat/slack-actions/client";
import { getStateAdapter } from "@/chat/state";
import { truncateStatusText } from "@/chat/status-format";
import { escapeXml } from "@/chat/xml";

function htmlErrorResponse(title: string, message: string, status: number): Response {
  const safeTitle = escapeXml(title);
  const safeMessage = escapeXml(message);
  const html = `<!DOCTYPE html>
<html>
<head><title>${safeTitle}</title></head>
<body style="font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0;">
  <div style="text-align: center; max-width: 480px;">
    <h1>${safeTitle}</h1>
    <p>${safeMessage}</p>
    <p style="margin-top: 2rem; color: #666; font-size: 0.9em;">You can close this tab and return to Slack to try again.</p>
  </div>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
}

async function postSlackMessage(channelId: string, threadTs: string, text: string): Promise<void> {
  try {
    await getSlackClient().chat.postMessage({ channel: channelId, thread_ts: threadTs, text });
  } catch {
    // Best effort.
  }
}

async function setAssistantStatus(channelId: string, threadTs: string, status: string): Promise<void> {
  try {
    await getSlackClient().assistant.threads.setStatus({ channel_id: channelId, thread_ts: threadTs, status });
  } catch {
    // Best effort.
  }
}

const STATUS_DEBOUNCE_MS = 1000;

function createDebouncedStatusPoster(channelId: string, threadTs: string) {
  let lastPostAt = 0;
  let currentStatus = "";
  let pendingStatus: string | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const flush = async () => {
    if (stopped || !pendingStatus) return;
    const status = pendingStatus;
    pendingStatus = null;
    pendingTimer = null;
    lastPostAt = Date.now();
    currentStatus = status;
    await setAssistantStatus(channelId, threadTs, status);
  };

  const post = async (status: string) => {
    if (stopped) return;
    const truncated = truncateStatusText(status);
    if (!truncated || truncated === currentStatus) return;

    const now = Date.now();
    const elapsed = now - lastPostAt;

    if (elapsed >= STATUS_DEBOUNCE_MS) {
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      pendingStatus = null;
      lastPostAt = now;
      currentStatus = truncated;
      await setAssistantStatus(channelId, threadTs, truncated);
      return;
    }

    pendingStatus = truncated;
    if (!pendingTimer) {
      pendingTimer = setTimeout(() => {
        void flush();
      }, Math.max(1, STATUS_DEBOUNCE_MS - elapsed));
    }
  };

  post.stop = () => {
    stopped = true;
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    pendingStatus = null;
  };

  return post;
}

function createReadOnlyConfigService(values: Record<string, unknown>): ChannelConfigurationService {
  const entries = Object.entries(values).map(([key, value]) => ({
    key,
    value,
    scope: "conversation" as const,
    updatedAt: new Date().toISOString()
  }));

  return {
    get: async (key) => entries.find((e) => e.key === key),
    set: async () => {
      throw new Error("Read-only configuration in resumed context");
    },
    unset: async () => false,
    list: async ({ prefix } = {}) => entries.filter((e) => !prefix || e.key.startsWith(prefix)),
    resolve: async (key) => values[key],
    resolveValues: async ({ keys, prefix } = {}) => {
      const filtered: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(values)) {
        if (prefix && !key.startsWith(prefix)) continue;
        if (keys && !keys.includes(key)) continue;
        filtered[key] = value;
      }
      return filtered;
    }
  };
}

async function resumePendingMessage(stored: OAuthStatePayload): Promise<void> {
  if (!stored.pendingMessage || !stored.channelId || !stored.threadTs) return;

  const providerLabel = stored.provider.charAt(0).toUpperCase() + stored.provider.slice(1);
  await postSlackMessage(
    stored.channelId,
    stored.threadTs,
    `Your ${providerLabel} account is now connected. Processing your request...`
  );

  const postStatus = createDebouncedStatusPoster(stored.channelId, stored.threadTs);
  await setAssistantStatus(stored.channelId, stored.threadTs, "Thinking...");

  try {
    const reply = await generateAssistantReply(stored.pendingMessage, {
      assistant: { userName: botConfig.userName },
      requester: { userId: stored.userId },
      correlation: {
        channelId: stored.channelId,
        threadTs: stored.threadTs,
        requesterId: stored.userId
      },
      configuration: stored.configuration,
      channelConfiguration: stored.configuration
        ? createReadOnlyConfigService(stored.configuration)
        : undefined,
      onStatus: postStatus
    });

    postStatus.stop();

    if (reply.text) {
      await postSlackMessage(stored.channelId, stored.threadTs, reply.text);
    }

    logInfo(
      "oauth_callback_resume_complete",
      {},
      {
        "app.credential.provider": stored.provider,
        "app.ai.outcome": reply.diagnostics.outcome,
        "app.ai.tool_calls": reply.diagnostics.toolCalls.length
      },
      "Auto-resumed pending message after OAuth callback"
    );
  } catch (error) {
    postStatus.stop();

    logException(
      error,
      "oauth_callback_resume_failed",
      {},
      { "app.credential.provider": stored.provider },
      "Failed to auto-resume pending message after OAuth callback"
    );

    await postSlackMessage(
      stored.channelId,
      stored.threadTs,
      `I connected your account but hit an error processing your request. Please try \`${stored.pendingMessage}\` again.`
    );
  }
}

export async function GET(
  request: Request,
  context: { params: Promise<{ provider: string }> }
): Promise<Response> {
  const { provider } = await context.params;
  const providerConfig = getOAuthProviderConfig(provider);
  if (!providerConfig) {
    return htmlErrorResponse("Unknown provider", "The OAuth provider in this link is not recognized.", 404);
  }

  const providerLabel = provider.charAt(0).toUpperCase() + provider.slice(1);
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
        `You declined the ${providerLabel} authorization request. Return to Slack and run the auth command again if you change your mind.`,
        400
      );
    }
    return htmlErrorResponse(
      "Authorization failed",
      `${providerLabel} returned an error: ${escapeXml(errorParam)}. Return to Slack and try again.`,
      400
    );
  }

  if (!code || !state) {
    return htmlErrorResponse("Invalid request", "This authorization link is missing required parameters.", 400);
  }

  const stateAdapter = getStateAdapter();
  const stateKey = `oauth-state:${state}`;
  const stored = await stateAdapter.get<OAuthStatePayload>(stateKey);
  if (!stored) {
    return htmlErrorResponse(
      "Link expired",
      `This authorization link has expired (links are valid for 10 minutes). Return to Slack and ask to connect your ${providerLabel} account again, or retry your original command to get a new link.`,
      400
    );
  }

  if (stored.provider !== provider) {
    return htmlErrorResponse("Provider mismatch", "This authorization link does not match the expected provider.", 400);
  }

  await stateAdapter.delete(stateKey);

  const clientId = process.env[providerConfig.clientIdEnv]?.trim();
  const clientSecret = process.env[providerConfig.clientSecretEnv]?.trim();
  if (!clientId || !clientSecret) {
    return htmlErrorResponse("Configuration error", "OAuth client credentials are not configured on the server.", 500);
  }

  const baseUrl = resolveBaseUrl();
  if (!baseUrl) {
    return htmlErrorResponse("Configuration error", "The server cannot determine its base URL.", 500);
  }

  const redirectUri = `${baseUrl}${providerConfig.callbackPath}`;

  let tokenResponse: Response;
  try {
    tokenResponse = await fetch(providerConfig.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri
      })
    });
  } catch {
    return htmlErrorResponse("Connection failed", "Failed to exchange the authorization code. Please try again.", 500);
  }

  if (!tokenResponse.ok) {
    return htmlErrorResponse("Connection failed", "The token exchange with the provider failed. Please try again.", 500);
  }

  const tokenData = (await tokenResponse.json()) as Record<string, unknown>;

  if (
    !tokenData.access_token ||
    !tokenData.refresh_token ||
    typeof tokenData.expires_in !== "number"
  ) {
    return htmlErrorResponse("Connection failed", "The provider returned an incomplete token response. Please try again.", 500);
  }

  const accessToken = tokenData.access_token as string;
  const refreshToken = tokenData.refresh_token as string;
  const expiresAt = Date.now() + (tokenData.expires_in as number) * 1000;
  const userTokenStore = getUserTokenStore();
  await userTokenStore.set(stored.userId, provider, {
    accessToken,
    refreshToken,
    expiresAt
  });

  after(async () => {
    try {
      await publishAppHomeView(getSlackClient(), stored.userId, userTokenStore);
    } catch {
      // best effort
    }
  });

  if (stored.pendingMessage && stored.channelId && stored.threadTs) {
    after(() => resumePendingMessage(stored));
  } else if (stored.channelId && stored.threadTs) {
    const { channelId, threadTs } = stored;
    after(async () => {
      await postSlackMessage(
        channelId,
        threadTs,
        `Your ${providerLabel} account is now connected. You can start using ${providerLabel} commands.`
      );
    });
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
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
}
