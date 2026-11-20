import { randomBytes } from "node:crypto";
import {
  actorSchema,
  destinationSchema,
  sourceSchema,
  type Actor,
  type Destination,
  type Source,
} from "@sentry/junior-plugin-api";
import { logInfo, logWarn } from "@/chat/logging";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
import {
  getSlackClient,
  isDmChannel,
  withSlackRetries,
} from "@/chat/slack/client";
import {
  postSlackEphemeralMessage,
  // ast-grep-ignore: no-raw-slack-turn-post -- private auth link, ephemeral or DM, not Turn output
  postSlackMessage,
} from "@/chat/slack/outbound";
import type {
  OAuthAuthorization,
  OAuthAuthorizationRequest,
} from "@/chat/oauth-authorization";
import { buildSlackOAuthAuthorizationMessage } from "@/chat/slack/oauth-authorization-message";
import type { KnownBlock } from "@slack/types";
import * as z from "zod";
import { getStateAdapter } from "@/chat/state/adapter";

type PrivateDeliveryResult = "in_context" | "fallback_dm" | false;

export type OAuthStatePayload = {
  userId: string;
  provider: string;
  actor?: Actor;
  channelId?: string | undefined;
  destination?: Destination;
  source?: Source;
  threadTs?: string | undefined;
  resumeConversationId?: string | undefined;
  resumeSessionId?: string | undefined;
  scope?: string | undefined;
};

type OAuthFlowInput = {
  actorId: string;
  actor?: Actor;
  channelId?: string | undefined;
  destination?: Destination | undefined;
  source?: Source | undefined;
  threadTs?: string | undefined;
  activeSkillName?: string;
  resumeConversationId?: string | undefined;
  resumeSessionId?: string | undefined;
  scope?: string;
  authorization?: OAuthAuthorization | undefined;
};

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

const optionalStateStringSchema = z.string().min(1).optional().catch(undefined);

const oauthStatePayloadSchema = z.object({
  userId: z.string(),
  provider: z.string(),
  actor: actorSchema.optional(),
  channelId: optionalStateStringSchema,
  destination: destinationSchema.optional(),
  source: sourceSchema.optional(),
  threadTs: optionalStateStringSchema,
  resumeConversationId: optionalStateStringSchema,
  resumeSessionId: optionalStateStringSchema,
  scope: optionalStateStringSchema,
});

/** Parse OAuth callback state that was persisted before a provider redirect. */
export function parseOAuthStatePayload(
  value: unknown,
): OAuthStatePayload | undefined {
  const parsed = oauthStatePayloadSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
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
  const explicit = process.env["JUNIOR_BASE_URL"]?.trim();
  if (explicit) return explicit;
  const vercelProd = process.env["VERCEL_PROJECT_PRODUCTION_URL"]?.trim();
  if (vercelProd) return `https://${vercelProd}`;
  const vercelUrl = process.env["VERCEL_URL"]?.trim();
  if (vercelUrl) return `https://${vercelUrl}`;
  return undefined;
}

/**
 * Authorization links must only be visible to the requesting user.
 * Try in-context private delivery first, then fall back to a DM.
 */
export async function deliverPrivateMessage(input: {
  channelId?: string | undefined;
  threadTs?: string | undefined;
  userId: string;
  text: string;
  blocks?: KnownBlock[];
}): Promise<PrivateDeliveryResult> {
  let client: ReturnType<typeof getSlackClient>;
  try {
    client = getSlackClient();
  } catch {
    logWarn("oauth.private_delivery.skipped", {
      "app.reason": "missing_bot_token",
    });
    return false;
  }

  if (input.channelId) {
    try {
      if (isDmChannel(input.channelId)) {
        // ast-grep-ignore: no-raw-slack-turn-post -- private auth link, ephemeral or DM, not Turn output
        await postSlackMessage({
          channelId: input.channelId,
          text: input.text,
          blocks: input.blocks,
          threadTs: input.threadTs,
        });
      } else {
        await postSlackEphemeralMessage({
          channelId: input.channelId,
          userId: input.userId,
          text: input.text,
          blocks: input.blocks,
          threadTs: input.threadTs,
        });
      }
      return "in_context";
    } catch (error) {
      logWarn("oauth.private_delivery.failed", {
        "app.slack.error":
          error instanceof Error ? error.message : String(error),
        "app.slack.channel": input.channelId,
      });
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
      logWarn("oauth.dm.fallback.failed", { "app.reason": "no_dm_channel_id" });
      return false;
    }

    // ast-grep-ignore: no-raw-slack-turn-post -- private auth link, ephemeral or DM, not Turn output
    await postSlackMessage({
      channelId: dmChannelId,
      text: input.text,
      blocks: input.blocks,
    });
    return "fallback_dm";
  } catch (error) {
    logWarn("oauth.dm.fallback.failed", {
      "app.slack.error": error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** Present one OAuth request through the active surface's private delivery. */
export async function deliverOAuthAuthorization(
  request: OAuthAuthorizationRequest,
  input: {
    authorization?: OAuthAuthorization | undefined;
    channelId?: string | undefined;
    threadTs?: string | undefined;
    userId: string;
  },
): Promise<PrivateDeliveryResult> {
  if (input.authorization) {
    await input.authorization.deliver(request);
    return "in_context";
  }
  return await deliverPrivateMessage({
    channelId: input.channelId,
    threadTs: input.threadTs,
    userId: input.userId,
    ...buildSlackOAuthAuthorizationMessage(request),
  });
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

  const state = input.authorization
    ? await input.authorization.createState()
    : randomBytes(32).toString("hex");
  const requestedScope = input.scope ?? providerConfig.scope;

  await getStateAdapter().set(
    `oauth-state:${state}`,
    {
      userId: input.actorId,
      provider,
      ...(input.actor ? { actor: input.actor } : undefined),
      ...(input.channelId ? { channelId: input.channelId } : undefined),
      ...(input.destination ? { destination: input.destination } : undefined),
      ...(input.source ? { source: input.source } : undefined),
      ...(input.threadTs ? { threadTs: input.threadTs } : undefined),
      ...(input.resumeConversationId
        ? { resumeConversationId: input.resumeConversationId }
        : undefined),
      ...(input.resumeSessionId
        ? { resumeSessionId: input.resumeSessionId }
        : undefined),
      ...(requestedScope ? { scope: requestedScope } : undefined),
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

  logInfo("jr_rpc.oauth.started", {
    "app.credential.provider": provider,
    ...(input.activeSkillName
      ? { "app.skill.name": input.activeSkillName }
      : undefined),
  });

  const authorizationUrl = `${providerConfig.authorizeEndpoint}?${authorizeParams.toString()}`;
  const authorizationRequest = {
    authorizationUrl,
    label: `Connect your ${formatProviderLabel(provider)} account`,
    completionText: input.resumeSessionId
      ? "Once you've authorized, I'll continue automatically."
      : "Once you've authorized, you'll see a confirmation in Slack.",
  };
  return {
    ok: true,
    delivery: await deliverOAuthAuthorization(authorizationRequest, {
      authorization: input.authorization,
      channelId: input.channelId,
      threadTs: input.threadTs,
      userId: input.actorId,
    }),
  };
}
