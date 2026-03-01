import { after } from "next/server";
import { getUserTokenStore } from "@/chat/capabilities/factory";
import { OAUTH_PROVIDERS, resolveBaseUrl, type OAuthStatePayload } from "@/chat/capabilities/jr-rpc-command";
import { botConfig } from "@/chat/config";
import type { ChannelConfigurationService } from "@/chat/configuration/types";
import { logException, logInfo } from "@/chat/observability";
import { generateAssistantReply } from "@/chat/respond";
import { getStateAdapter } from "@/chat/state";

export const runtime = "nodejs";

async function postSlackMessage(channelId: string, threadTs: string, text: string): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN?.trim();
  if (!token) return;

  try {
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        channel: channelId,
        thread_ts: threadTs,
        text
      })
    });
  } catch {
    // Best effort.
  }
}

function createReadOnlyConfigService(values: Record<string, unknown>): ChannelConfigurationService {
  const entries = Object.entries(values).map(([key, value]) => ({
    key,
    value,
    scope: "channel" as const,
    updatedAt: new Date().toISOString()
  }));

  return {
    get: async (key) => entries.find((e) => e.key === key),
    set: async () => {
      throw new Error("Read-only configuration in resumed context");
    },
    unset: async () => false,
    list: async ({ prefix } = {}) =>
      entries.filter((e) => !prefix || e.key.startsWith(prefix)),
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
        : undefined
    });

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
      "I connected your account but hit an error processing your request. Please try your command again."
    );
  }
}

export async function GET(
  request: Request,
  context: { params: Promise<{ provider: string }> }
): Promise<Response> {
  const { provider } = await context.params;
  const providerConfig = OAUTH_PROVIDERS[provider];
  if (!providerConfig) {
    return new Response("Unknown OAuth provider", { status: 404 });
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return new Response("Missing code or state parameter", { status: 400 });
  }

  const stateAdapter = getStateAdapter();
  const stateKey = `oauth-state:${state}`;
  const stored = await stateAdapter.get<OAuthStatePayload>(stateKey);
  if (!stored) {
    return new Response("Invalid or expired OAuth state", { status: 400 });
  }

  if (stored.provider !== provider) {
    return new Response("OAuth state provider mismatch", { status: 400 });
  }

  // Delete state key (one-time use)
  await stateAdapter.delete(stateKey);

  const clientId = process.env[providerConfig.clientIdEnv]?.trim();
  const clientSecret = process.env[providerConfig.clientSecretEnv]?.trim();
  if (!clientId || !clientSecret) {
    return new Response("OAuth client credentials not configured", { status: 500 });
  }

  const baseUrl = resolveBaseUrl();
  if (!baseUrl) {
    return new Response("Cannot determine base URL (set JUNIOR_BASE_URL or deploy to Vercel)", { status: 500 });
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
    return new Response("Failed to exchange authorization code", { status: 500 });
  }

  if (!tokenResponse.ok) {
    return new Response("Token exchange failed", { status: 500 });
  }

  const tokenData = (await tokenResponse.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (!tokenData.access_token || !tokenData.refresh_token || !tokenData.expires_in) {
    return new Response("Token response missing required fields", { status: 500 });
  }

  const expiresAt = Date.now() + tokenData.expires_in * 1000;
  const userTokenStore = getUserTokenStore();
  await userTokenStore.set(stored.userId, provider, {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresAt
  });

  if (stored.pendingMessage && stored.channelId && stored.threadTs) {
    // Auto-resume: run agent turn in background after HTTP response
    after(() => resumePendingMessage(stored));
  } else if (stored.channelId && stored.threadTs) {
    // No pending message — post confirmation best-effort after HTTP response
    const confirmChannelId = stored.channelId;
    const confirmThreadTs = stored.threadTs;
    const providerLabel = provider.charAt(0).toUpperCase() + provider.slice(1);
    after(async () => {
      await postSlackMessage(
        confirmChannelId,
        confirmThreadTs,
        `Your ${providerLabel} account is now connected. You can start using ${providerLabel} commands.`
      );
    });
  }

  const providerLabel = provider.charAt(0).toUpperCase() + provider.slice(1);
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
