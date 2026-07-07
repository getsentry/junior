import { randomBytes } from "node:crypto";
import {
  sourceSchema,
  type Destination,
  type Source,
} from "@sentry/junior-plugin-api";
import type { ChannelConfigurationService } from "@/chat/configuration/types";
import { parseDestination } from "@/chat/destination";
import { logInfo, logWarn } from "@/chat/logging";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
import {
  getSlackClient,
  isDmChannel,
  withSlackRetries,
} from "@/chat/slack/client";
import {
  postSlackEphemeralMessage,
  postSlackMessage,
} from "@/chat/slack/outbound";
import { formatOAuthAuthorizationMessage } from "@/chat/oauth-authorization-message";
import { isRecord } from "@/chat/coerce";
import { getStateAdapter } from "@/chat/state/adapter";

type PrivateDeliveryResult = "in_context" | "fallback_dm" | false;

export type OAuthStatePayload = {
  userId: string;
  provider: string;
  channelId?: string;
  destination?: Destination;
  source?: Source;
  threadTs?: string;
  pendingMessage?: string;
  configuration?: Record<string, unknown>;
  resumeConversationId?: string;
  resumeSessionId?: string;
  scope?: string;
};

type OAuthFlowInput = {
  actorId: string;
  channelId?: string;
  destination?: Destination;
  source?: Source;
  threadTs?: string;
  userMessage?: string;
  channelConfiguration?: ChannelConfigurationService;
  activeSkillName?: string;
  resumeConversationId?: string;
  resumeSessionId?: string;
  scope?: string;
};

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Parse OAuth callback state that was persisted before a provider redirect. */
export function parseOAuthStatePayload(
  value: unknown,
): OAuthStatePayload | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (typeof value.userId !== "string" || typeof value.provider !== "string") {
    return undefined;
  }
  const destination = parseDestination(value.destination);
  if (value.destination !== undefined && !destination) {
    return undefined;
  }
  const source =
    value.source === undefined
      ? undefined
      : sourceSchema.safeParse(value.source);
  if (value.source !== undefined && (!source || !source.success)) {
    return undefined;
  }
  const pendingMessage = optionalString(value.pendingMessage);
  if (pendingMessage && !source?.success) {
    return undefined;
  }
  return {
    userId: value.userId,
    provider: value.provider,
    ...(optionalString(value.channelId)
      ? { channelId: optionalString(value.channelId) }
      : {}),
    ...(destination ? { destination } : {}),
    ...(source?.success ? { source: source.data } : {}),
    ...(optionalString(value.threadTs)
      ? { threadTs: optionalString(value.threadTs) }
      : {}),
    ...(pendingMessage ? { pendingMessage } : {}),
    ...(isRecord(value.configuration)
      ? { configuration: value.configuration }
      : {}),
    ...(optionalString(value.resumeConversationId)
      ? { resumeConversationId: optionalString(value.resumeConversationId) }
      : {}),
    ...(optionalString(value.resumeSessionId)
      ? { resumeSessionId: optionalString(value.resumeSessionId) }
      : {}),
    ...(optionalString(value.scope)
      ? { scope: optionalString(value.scope) }
      : {}),
  };
}

/** Return the manifest-owned display label for a provider. */
export function formatProviderLabel(provider: string): string {
  const displayName = pluginCatalogRuntime.getDisplayName(provider);
  if (!displayName) {
    throw new Error(`Unknown plugin provider display name: "${provider}"`);
  }
  return displayName;
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
      await withSlackRetries(
        () => client.conversations.open({ users: input.userId }),
        3,
        {
          action: "conversations.open",
          spanAttributes: { "app.slack.user_id": input.userId },
        },
      )
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
  const providerConfig = pluginCatalogRuntime.getOAuthConfig(provider);
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
  const requestedScope = input.scope ?? providerConfig.scope;

  await getStateAdapter().set(
    `oauth-state:${state}`,
    {
      userId: input.actorId,
      provider,
      ...(input.channelId ? { channelId: input.channelId } : {}),
      ...(input.destination ? { destination: input.destination } : {}),
      ...(input.source ? { source: input.source } : {}),
      ...(input.threadTs ? { threadTs: input.threadTs } : {}),
      ...(input.userMessage ? { pendingMessage: input.userMessage } : {}),
      ...(configuration && Object.keys(configuration).length > 0
        ? { configuration }
        : {}),
      ...(input.resumeConversationId
        ? { resumeConversationId: input.resumeConversationId }
        : {}),
      ...(input.resumeSessionId
        ? { resumeSessionId: input.resumeSessionId }
        : {}),
      ...(requestedScope ? { scope: requestedScope } : {}),
    } satisfies OAuthStatePayload,
    OAUTH_STATE_TTL_MS,
  );

  const authorizeParams = new URLSearchParams({
    client_id: clientId,
    state,
    redirect_uri: `${baseUrl}${providerConfig.callbackPath}`,
    response_type: "code",
  });
  if (requestedScope) {
    authorizeParams.set("scope", requestedScope);
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

  const authorizationUrl = `${providerConfig.authorizeEndpoint}?${authorizeParams.toString()}`;
  return {
    ok: true,
    delivery: await deliverPrivateMessage({
      channelId: input.channelId,
      threadTs: input.threadTs,
      userId: input.actorId,
      text: formatOAuthAuthorizationMessage({
        authorizationUrl,
        label: `Click here to link your ${formatProviderLabel(provider)} account`,
        completionText:
          "Once you've authorized, you'll see a confirmation in Slack.",
      }),
    }),
  };
}
