import { randomBytes } from "node:crypto";
import type { ChannelConfigurationService } from "@/chat/configuration/types";
import { logInfo, logWarn } from "@/chat/logging";
import { getPluginOAuthConfig } from "@/chat/plugins/registry";
import { getSlackClient, isDmChannel } from "@/chat/slack/client";
import {
  postSlackEphemeralMessage,
  postSlackMessage,
} from "@/chat/slack/outbound";
import { getStateAdapter } from "@/chat/state/adapter";
import {
  isToolResultError,
  normalizeToolNameFromResult,
  parseJsonCandidate,
} from "@/chat/respond-helpers";

type PrivateDeliveryResult = "in_context" | "fallback_dm" | false;

export type OAuthStatePayload = {
  userId: string;
  provider: string;
  channelId?: string;
  threadTs?: string;
  pendingMessage?: string;
  configuration?: Record<string, unknown>;
};

type OAuthFlowInput = {
  requesterId: string;
  channelId?: string;
  threadTs?: string;
  userMessage?: string;
  channelConfiguration?: ChannelConfigurationService;
  activeSkillName?: string;
};

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/** Capitalize the first letter of a provider name for display. */
export function formatProviderLabel(provider: string): string {
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

/** Resolve the public base URL from environment variables (JUNIOR_BASE_URL or Vercel). */
export function resolveBaseUrl(): string | undefined {
  const explicit = process.env.JUNIOR_BASE_URL?.trim();
  if (explicit) return explicit;
  const vercelProd = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (vercelProd) return `https://${vercelProd}`;
  const vercelUrl = process.env.VERCEL_URL?.trim();
  if (vercelUrl) return `https://${vercelUrl}`;
  return undefined;
}

/**
 * Authorization links must only be visible to the requesting user.
 * Try in-context private delivery first, then fall back to a DM.
 */
export async function deliverPrivateMessage(input: {
  channelId?: string;
  threadTs?: string;
  userId: string;
  text: string;
}): Promise<PrivateDeliveryResult> {
  let client: ReturnType<typeof getSlackClient>;
  try {
    client = getSlackClient();
  } catch {
    logWarn(
      "oauth_private_delivery_skip",
      {},
      { "app.reason": "missing_bot_token" },
      "Skipped private message delivery — no SLACK_BOT_TOKEN",
    );
    return false;
  }

  if (input.channelId) {
    try {
      if (isDmChannel(input.channelId)) {
        await postSlackMessage({
          channelId: input.channelId,
          text: input.text,
          threadTs: input.threadTs,
        });
      } else {
        await postSlackEphemeralMessage({
          channelId: input.channelId,
          userId: input.userId,
          text: input.text,
          threadTs: input.threadTs,
        });
      }
      return "in_context";
    } catch (error) {
      logWarn(
        "oauth_private_delivery_failed",
        {},
        {
          "app.slack.error":
            error instanceof Error ? error.message : String(error),
          "app.slack.channel": input.channelId,
        },
        "Private message delivery failed, falling back to DM",
      );
    }
  }

  try {
    const dmChannelId = (
      await client.conversations.open({ users: input.userId })
    ).channel?.id;
    if (!dmChannelId) {
      logWarn(
        "oauth_dm_fallback_failed",
        {},
        { "app.reason": "no_dm_channel_id" },
        "conversations.open returned no channel ID",
      );
      return false;
    }

    await postSlackMessage({ channelId: dmChannelId, text: input.text });
    return "fallback_dm";
  } catch (error) {
    logWarn(
      "oauth_dm_fallback_failed",
      {},
      {
        "app.slack.error":
          error instanceof Error ? error.message : String(error),
      },
      "DM fallback delivery failed",
    );
    return false;
  }
}

/** Initiate an OAuth authorization code flow for a provider and deliver the auth link to the user. */
export async function startOAuthFlow(
  provider: string,
  input: OAuthFlowInput,
): Promise<
  { ok: false; error: string } | { ok: true; delivery: PrivateDeliveryResult }
> {
  const providerConfig = getPluginOAuthConfig(provider);
  if (!providerConfig) {
    return {
      ok: false,
      error: `Provider "${provider}" does not support OAuth authorization`,
    };
  }

  const clientId = process.env[providerConfig.clientIdEnv]?.trim();
  if (!clientId) {
    return {
      ok: false,
      error: `Missing ${providerConfig.clientIdEnv} environment variable`,
    };
  }

  const baseUrl = resolveBaseUrl();
  if (!baseUrl) {
    return {
      ok: false,
      error:
        "Cannot determine base URL (set JUNIOR_BASE_URL or deploy to Vercel)",
    };
  }

  const configuration =
    input.userMessage && input.channelConfiguration
      ? await input.channelConfiguration.resolveValues()
      : undefined;
  const state = randomBytes(32).toString("hex");

  await getStateAdapter().set(
    `oauth-state:${state}`,
    {
      userId: input.requesterId,
      provider,
      ...(input.channelId ? { channelId: input.channelId } : {}),
      ...(input.threadTs ? { threadTs: input.threadTs } : {}),
      ...(input.userMessage ? { pendingMessage: input.userMessage } : {}),
      ...(configuration && Object.keys(configuration).length > 0
        ? { configuration }
        : {}),
    } satisfies OAuthStatePayload,
    OAUTH_STATE_TTL_MS,
  );

  const authorizeParams = new URLSearchParams({
    client_id: clientId,
    state,
    redirect_uri: `${baseUrl}${providerConfig.callbackPath}`,
    response_type: "code",
  });
  if (providerConfig.scope) {
    authorizeParams.set("scope", providerConfig.scope);
  }
  for (const [key, value] of Object.entries(
    providerConfig.authorizeParams ?? {},
  )) {
    authorizeParams.set(key, value);
  }

  logInfo(
    "jr_rpc_oauth_start",
    {},
    {
      "app.credential.provider": provider,
      ...(input.activeSkillName
        ? { "app.skill.name": input.activeSkillName }
        : {}),
    },
    "Initiated OAuth authorization code flow",
  );

  return {
    ok: true,
    delivery: await deliverPrivateMessage({
      channelId: input.channelId,
      threadTs: input.threadTs,
      userId: input.requesterId,
      text: `<${providerConfig.authorizeEndpoint}?${authorizeParams.toString()}|Click here to link your ${formatProviderLabel(provider)} account>. Once you've authorized, you'll see a confirmation in Slack.`,
    }),
  };
}

// ---------------------------------------------------------------------------
// Tool result OAuth detection
// ---------------------------------------------------------------------------

function extractOAuthStartedPayload(
  value: unknown,
): { message?: string } | undefined {
  if (typeof value === "string") {
    const parsed = parseJsonCandidate(value);
    return parsed === undefined
      ? undefined
      : extractOAuthStartedPayload(parsed);
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = extractOAuthStartedPayload(entry);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (record.oauth_started === true) {
    const message =
      typeof record.message === "string" ? record.message.trim() : undefined;
    return message ? { message } : {};
  }

  const content = record.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      const text =
        part &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : part;
      const found = extractOAuthStartedPayload(text);
      if (found) {
        return found;
      }
    }
  }

  for (const key of ["details", "output", "result", "stdout"]) {
    if (!(key in record)) {
      continue;
    }
    const found = extractOAuthStartedPayload(record[key]);
    if (found) {
      return found;
    }
  }

  return undefined;
}

/** Scan bash tool results for an OAuth authorization-started signal. */
export function extractOAuthStartedMessageFromToolResults(
  toolResults: unknown[],
): string | undefined {
  for (const result of toolResults) {
    if (
      normalizeToolNameFromResult(result) !== "bash" ||
      isToolResultError(result)
    ) {
      continue;
    }

    const found = extractOAuthStartedPayload(result);
    if (found?.message) {
      return found.message;
    }
  }

  return undefined;
}
