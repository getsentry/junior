/**
 * OAuth callbacks exchange and store credentials. Public signed callbacks
 * relay to the owning CLI, which controls local continuation. Slack callbacks
 * save readiness and wake the conversation worker. They do not run the agent
 * or change its history.
 */
import { createUserTokenStore } from "@/chat/capabilities/factory";
import { hasRequiredOAuthScope } from "@/chat/credentials/oauth-scope";
import { coerceThreadConversationState } from "@/chat/state/conversation";

import {
  formatProviderLabel,
  parseOAuthStatePayload,
  type OAuthStatePayload,
  resolveBaseUrl,
} from "@/chat/oauth-flow";

import { postSlackMessage } from "@/chat/slack/outbound";

import { logWarn, runBestEffort } from "@/chat/logging";
import { htmlCallbackResponse } from "@/handlers/oauth-html";
import { getPersistedThreadState } from "@/chat/runtime/thread-state";

import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
import {
  buildOAuthTokenRequest,
  parseOAuthTokenResponse,
} from "@/chat/plugins/auth/oauth-request";
import { resolvePluginOAuthAccount } from "@/chat/plugins/credential-hooks";

import { publishAppHomeView } from "@/chat/slack/app-home";
import { getSlackClient } from "@/chat/slack/client";

import { getStateAdapter } from "@/chat/state/adapter";
import { getTurnRecord } from "@/chat/task-execution/checkpoint";
import {
  recordAuthenticationLinked,
  recordAuthorizationCompleted,
} from "@/chat/conversations/projection";
import { getConversationPendingAuth } from "@/chat/services/pending-auth";
import { escapeXml } from "@/chat/xml";
import type { WaitUntilFn } from "@/handlers/types";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import {
  wakeAuthorizedTurn,
  wakePausedTurn,
} from "@/chat/task-execution/turn-wake";

import { relayLocalOAuthCallback } from "@/chat/local/oauth-relay";
import { getSqlExecutor } from "@/chat/db";
import {
  findUserByVerifiedEmails,
  upsertIdentity,
  upsertLinkedIdentity,
} from "@/chat/identities/sql";
import { identityFromActor } from "@/chat/conversations/sql/actor-identity";
import type { SlackActor, WebActor } from "@/chat/actor";
import type { PluginProviderAccount } from "@sentry/junior-plugin-api";
import { lookupSlackUserProfile } from "@/chat/slack/users";
import { parseSlackUserId } from "@/chat/slack/ids";
import { deleteWebAuthorization } from "@/chat/conversations/web-authorization";
import { botConfig } from "@/chat/config";

interface OAuthCallbackOptions {
  /** Queue used to wake parked turns after authorization completes. */
  conversationWorkQueue?: ConversationWorkQueue;
}

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
    ...(status !== undefined
      ? { "http.response.status_code": status }
      : undefined),
  };
}

function pluginAuthorizationId(args: {
  provider: string;
  sessionId: string;
}): string {
  return `${args.sessionId}:plugin:${args.provider}`;
}

/** Return the Junior user of the person who started the OAuth connection. */
async function resolveOAuthActorUserId(
  actor: SlackActor | WebActor,
): Promise<string | undefined> {
  if (actor.platform === "web") {
    // Dashboard sign-in verified the web actor email.
    const observation = identityFromActor(
      actor.email
        ? {
            email: actor.email,
            ...(actor.fullName ? { fullName: actor.fullName } : undefined),
          }
        : undefined,
    );
    return observation
      ? (await upsertIdentity(getSqlExecutor(), observation)).userId
      : undefined;
  }
  const slackUserId = parseSlackUserId(actor.userId);
  if (!slackUserId) {
    throw new Error("OAuth Slack actor user id is invalid");
  }
  const profile = await lookupSlackUserProfile(slackUserId);
  const slackIdentity = await upsertIdentity(getSqlExecutor(), {
    kind: "user",
    provider: "slack",
    providerTenantId: actor.teamId,
    providerSubjectId: profile.id,
    displayName: profile.real_name || profile.display_name,
    handle: profile.name,
    ...(profile.email
      ? { email: profile.email, emailVerified: true }
      : undefined),
  });
  return slackIdentity.userId;
}

/**
 * Link a connected provider account to the person who connected it.
 *
 * The actor's user wins. A provider-verified email that matches exactly one
 * user links the account when the actor has no user, and is saved on the
 * identity when it matches the actor's user.
 */
async function linkOAuthAccountIdentity(args: {
  account: PluginProviderAccount;
  actor: SlackActor | WebActor;
  provider: string;
  verifiedEmails: string[];
}): Promise<void> {
  const executor = getSqlExecutor();
  const actorUserId = await resolveOAuthActorUserId(args.actor);
  const emailMatch = await findUserByVerifiedEmails(
    executor,
    args.verifiedEmails,
  );
  const userId = actorUserId ?? emailMatch?.userId;
  if (!userId) {
    throw new Error("OAuth account has no Junior user to link");
  }
  const email = emailMatch?.userId === userId ? emailMatch.email : undefined;
  await upsertLinkedIdentity(executor, userId, {
    kind: "user",
    provider: args.provider,
    providerSubjectId: args.account.id,
    displayName: args.account.displayName,
    handle: args.account.handle ?? args.account.label,
    ...(email ? { email, emailVerified: true } : undefined),
  });
}

/** Queue the pending Turn, including a newer Turn that reused this auth link. */
async function wakeAuthorizedPluginTurn(
  stored: OAuthStatePayload,
  options: OAuthCallbackOptions,
): Promise<void> {
  if (
    !stored.resumeConversationId ||
    !stored.resumeSessionId ||
    !stored.destination
  )
    return;
  const conversation = coerceThreadConversationState(
    await getPersistedThreadState(stored.resumeConversationId),
  );
  const pendingAuth = getConversationPendingAuth({
    conversation,
    kind: "plugin",
    provider: stored.provider,
    actorId: stored.userId,
    ...(stored.scope ? { scope: stored.scope } : undefined),
  });
  const turnId = pendingAuth?.sessionId ?? stored.resumeSessionId;
  await wakeAuthorizedTurn(
    {
      conversationId: stored.resumeConversationId,
      destination: stored.destination,
      turnId,
      kind: "plugin",
      provider: stored.provider,
      actorId: stored.userId,
      scope: stored.scope,
      authorizationId: pluginAuthorizationId({
        provider: stored.provider,
        sessionId: turnId,
      }),
    },
    options.conversationWorkQueue,
  );
}

/** Complete provider authorization and queue any paused Slack Turn. */
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
  let tokenData: Record<string, unknown>;
  try {
    tokenData = (await tokenResponse.json()) as Record<string, unknown>;
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
  let account: PluginProviderAccount | undefined;
  let verifiedEmails: string[] = [];
  try {
    const resolved = await resolvePluginOAuthAccount({
      provider,
      tokenResponse: tokenData,
      tokens: parsedTokenResponse,
    });
    if (resolved) {
      // Verified emails only link the account. They are not stored with tokens.
      const { verifiedEmails: emails, ...rest } = resolved;
      account = rest;
      verifiedEmails = emails ?? [];
    }
  } catch {
    return htmlErrorResponse(
      "Connection failed",
      `Junior could not verify the connected ${providerLabel} account. Please try again.`,
      500,
    );
  }
  await userTokenStore.set(stored.userId, provider, {
    ...parsedTokenResponse,
    ...(account ? { account } : undefined),
  });
  const linkActor = stored.actor;
  if (
    account &&
    (linkActor?.platform === "slack" || linkActor?.platform === "web")
  ) {
    await runBestEffort(
      async () => {
        await linkOAuthAccountIdentity({
          account,
          actor: linkActor,
          provider,
          verifiedEmails,
        });
      },
      "oauth.callback.identity_link.failed",
      { "app.credential.provider": provider },
    );
  }

  const resumeConversationId = stored.resumeConversationId;
  if (resumeConversationId) {
    await runBestEffort(
      async () => {
        await recordAuthenticationLinked({
          conversationId: resumeConversationId,
          provider,
          actorId: stored.userId,
          providerLabel,
          ...(account?.label ? { accountLabel: account.label } : undefined),
          ...(stored.resumeSessionId
            ? {
                authorizationId: pluginAuthorizationId({
                  provider,
                  sessionId: stored.resumeSessionId,
                }),
                turnId: stored.resumeSessionId,
              }
            : undefined),
        });
      },
      "oauth.callback.authentication_event.failed",
      { "app.credential.provider": provider },
    );
  }

  // Dashboard-started connections belong to a web actor with no App Home.
  const webActor = stored.actor?.platform === "web";
  if (
    stored.destination?.platform !== "local" &&
    stored.source?.kind !== "web" &&
    !webActor
  ) {
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

  const resumesWebTurn = Boolean(
    stored.source?.kind === "web" &&
    stored.destination &&
    stored.resumeConversationId &&
    stored.resumeSessionId,
  );
  const resumesAgentTurn = Boolean(
    stored.destination?.platform !== "local" &&
    stored.resumeConversationId &&
    stored.resumeSessionId,
  );
  if (resumesWebTurn) {
    waitUntil(async () => {
      const turn = await getTurnRecord(
        stored.resumeConversationId!,
        stored.resumeSessionId!,
      );
      // Always clear the dashboard prompt. A superseded/abandoned turn must
      // not leave a stale connect banner after OAuth completes late.
      await deleteWebAuthorization({
        actorId: stored.userId,
        conversationId: stored.resumeConversationId!,
      });
      if (!turn || turn.state !== "paused" || turn.resumeReason !== "auth") {
        return;
      }
      await recordAuthorizationCompleted({
        conversationId: stored.resumeConversationId!,
        kind: "plugin",
        provider: stored.provider,
        actorId: stored.userId,
        authorizationId: pluginAuthorizationId({
          provider: stored.provider,
          sessionId: stored.resumeSessionId!,
        }),
      });
      await wakePausedTurn(
        {
          conversationId: stored.resumeConversationId!,
          destination: stored.destination!,
          turnId: stored.resumeSessionId!,
          expectedVersion: turn.version,
        },
        options.conversationWorkQueue
          ? { queue: options.conversationWorkQueue }
          : undefined,
      );
    });
  } else if (resumesAgentTurn) {
    await wakeAuthorizedPluginTurn(stored, options);
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

  const botName = botConfig.userName;
  const statusMessage =
    stored.destination?.platform === "local" && !resumesWebTurn
      ? `Your request is continuing in the local ${botName} client.`
      : resumesWebTurn
        ? `Your request is continuing in ${botName}.`
        : resumesAgentTurn
          ? "Your request is being processed in Slack."
          : `Your ${providerLabel} account is connected.`;
  const footerMessage =
    stored.destination?.platform === "local" || resumesWebTurn || webActor
      ? `You can close this tab and return to ${botName}.`
      : "You can close this tab and return to Slack.";
  return htmlCallbackResponse(
    escapeXml(`${providerLabel} account connected`),
    escapeXml(statusMessage),
    200,
    { footerMessage: escapeXml(footerMessage) },
  );
}
