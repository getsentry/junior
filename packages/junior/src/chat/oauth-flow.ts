import { randomBytes } from "node:crypto";
import {
  actorSchema,
  sourceSchema,
  type Actor,
  type Destination,
  type Source,
} from "@sentry/junior-plugin-api";
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
import type {
  OAuthAuthorization,
  OAuthAuthorizationRequest,
} from "@/chat/oauth-authorization";
import { formatOAuthAuthorizationMessage } from "@/chat/slack/oauth-authorization-message";
import { isRecord } from "@/chat/coerce";
import { getStateAdapter } from "@/chat/state/adapter";
import { StateAdapterInstallationTokenStore } from "@/chat/credentials/state-adapter-token-store";
import { isSlackWorkspaceAdmin } from "@/chat/slack/admin";

type PrivateDeliveryResult = "in_context" | "fallback_dm" | false;

export type OAuthStatePayload = {
  userId: string;
  provider: string;
  actor?: Actor;
  channelId?: string;
  destination?: Destination;
  source?: Source;
  threadTs?: string;
  resumeConversationId?: string;
  resumeSessionId?: string;
  scope?: string;
};

type OAuthFlowInput = {
  actorId: string;
  actor?: Actor;
  channelId?: string;
  destination?: Destination;
  source?: Source;
  threadTs?: string;
  activeSkillName?: string;
  resumeConversationId?: string;
  resumeSessionId?: string;
  scope?: string;
  authorization?: OAuthAuthorization;
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
  const actor =
    value.actor === undefined ? undefined : actorSchema.safeParse(value.actor);
  if (value.actor !== undefined && (!actor || !actor.success)) {
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
  return {
    userId: value.userId,
    provider: value.provider,
    ...(actor?.success ? { actor: actor.data } : undefined),
    ...(optionalString(value.channelId)
      ? { channelId: optionalString(value.channelId) }
      : undefined),
    ...(destination ? { destination } : undefined),
    ...(source?.success ? { source: source.data } : undefined),
    ...(optionalString(value.threadTs)
      ? { threadTs: optionalString(value.threadTs) }
      : undefined),
    ...(optionalString(value.resumeConversationId)
      ? { resumeConversationId: optionalString(value.resumeConversationId) }
      : undefined),
    ...(optionalString(value.resumeSessionId)
      ? { resumeSessionId: optionalString(value.resumeSessionId) }
      : undefined),
    ...(optionalString(value.scope)
      ? { scope: optionalString(value.scope) }
      : undefined),
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
    logWarn("oauth.private_delivery.skipped", {
      "app.reason": "missing_bot_token",
    });
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

    await postSlackMessage({ channelId: dmChannelId, text: input.text });
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
    authorization?: OAuthAuthorization;
    channelId?: string;
    threadTs?: string;
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
    text: formatOAuthAuthorizationMessage(request),
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

  if (providerConfig.tokenSubject === "installation") {
    if (
      input.actor?.platform !== "slack" ||
      !(await isSlackWorkspaceAdmin(input.actorId))
    ) {
      return {
        ok: false,
        error: `Only a Slack workspace admin can install ${formatProviderLabel(provider)}`,
      };
    }
    if (
      await new StateAdapterInstallationTokenStore(
        getStateAdapter(),
        input.actor.teamId,
      ).get(provider)
    ) {
      return {
        ok: false,
        error: `${formatProviderLabel(provider)} is already installed. Disconnect it before installing it again`,
      };
    }
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
    label:
      providerConfig.tokenSubject === "installation"
        ? `Click here to install ${formatProviderLabel(provider)}`
        : `Click here to link your ${formatProviderLabel(provider)} account`,
    completionText: input.resumeSessionId
      ? "Once you've authorized, Junior will continue automatically."
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
