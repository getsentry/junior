/**
 * OAuth and MCP auth fixtures: token seeding, cleanup, and callback auto-completion.
 */
import { createUserTokenStore } from "@/chat/capabilities/factory";
import { parseOAuthStatePayload } from "@/chat/oauth-flow";
import {
  deleteMcpAuthSessionsForUserProvider,
  deleteMcpServerSessionId,
  deleteMcpStoredOAuthCredentials,
  getMcpAuthSession,
  getMcpStoredOAuthCredentials,
} from "@/chat/mcp/auth-store";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import { getStateAdapter } from "@/chat/state/adapter";
import {
  EVAL_OAUTH_CODE,
  EVAL_OAUTH_PROVIDER,
} from "@junior-tests/msw/handlers/eval-oauth";
import {
  EVAL_MCP_AUTHORIZATION_ENDPOINT,
  EVAL_MCP_AUTH_PROVIDER,
} from "@junior-tests/msw/handlers/eval-mcp-auth";
import { completeMcpOauthCallbackRoute } from "@junior-tests/fixtures/mcp-oauth-callback-harness";
import { runOauthCallbackRoute } from "@junior-tests/fixtures/oauth-callback-harness";
import { readCapturedSlackApiCalls } from "@junior-tests/msw/captured-slack-api-calls";
import { parseSlackMrkdwnLinkUrl } from "../slack-link";
import { evalGitHubEnv } from "../eval-plugin-fixtures";
import { type AuthorizationCompletion } from "./types";
import { toFirstString } from "./slack-artifacts";

const SENTRY_EVAL_SCOPE =
  "alerts:write event:write member:read org:read project:releases project:write team:write";

/** Delete MCP auth sessions, credentials, and server sessions for the users and providers. */
export async function cleanupMcpAuthState(
  userIds: Iterable<string>,
  providers: Iterable<string>,
): Promise<void> {
  for (const provider of providers) {
    for (const userId of userIds) {
      await deleteMcpAuthSessionsForUserProvider(userId, provider);
      await deleteMcpStoredOAuthCredentials(userId, provider);
      await deleteMcpServerSessionId(userId, provider);
    }
  }
}

/** Delete stored OAuth tokens for the users and providers. */
export async function cleanupOAuthTokens(
  userIds: Iterable<string>,
  providers: Iterable<string>,
): Promise<void> {
  const userTokenStore = createUserTokenStore();
  for (const provider of providers) {
    for (const userId of userIds) {
      await userTokenStore.delete(userId, provider);
    }
  }
}

/** Set the provider env vars the seeded credentials depend on. */
export function configureCredentialProviderEnv(
  providers: Set<"github" | "sentry">,
): void {
  if (providers.has("github")) {
    Object.assign(process.env, evalGitHubEnv());
  }
  if (providers.has("sentry")) {
    process.env.SENTRY_CLIENT_ID = "eval-sentry-client-id";
    process.env.SENTRY_CLIENT_SECRET = "eval-sentry-client-secret";
  }
}

/** Store valid provider tokens for the scenario users. */
export async function seedCredentialProviderTokens(input: {
  providers: Set<"github" | "sentry">;
  userIds: Iterable<string>;
}): Promise<void> {
  if (!input.providers.has("sentry")) {
    return;
  }

  const userTokenStore = createUserTokenStore();
  for (const userId of input.userIds) {
    await userTokenStore.set(userId, "sentry", {
      accessToken: "eval-sentry-access-token",
      refreshToken: "eval-sentry-refresh-token",
      expiresAt: Date.now() + 60 * 60 * 1000,
      scope: SENTRY_EVAL_SCOPE,
    });
  }
}

/** Store expired eval OAuth tokens so a turn must refresh them. */
export async function seedExpiredOAuthTokens(input: {
  providers: Set<string>;
  userIds: Iterable<string>;
}): Promise<void> {
  const userTokenStore = createUserTokenStore();
  for (const provider of input.providers) {
    if (provider !== EVAL_OAUTH_PROVIDER) {
      throw new Error(
        `No expired OAuth eval fixture for provider "${provider}"`,
      );
    }
    for (const userId of input.userIds) {
      await userTokenStore.set(userId, provider, {
        accessToken: "expired-eval-oauth-access-token",
        refreshToken: "eval-oauth-refresh-token",
        expiresAt: Date.now() - 1,
        scope: "read",
      });
    }
  }
}

function getDefaultOauthCode(provider: string): string {
  if (provider === EVAL_OAUTH_PROVIDER) {
    return EVAL_OAUTH_CODE;
  }
  throw new Error(
    `No default eval OAuth code configured for provider "${provider}"`,
  );
}

function findLatestOAuthStateFromSlackCalls(args: {
  authorizeEndpoint: string;
  consumedStates: Set<string>;
}):
  | {
      channelId?: string;
      delivery: "direct_message" | "ephemeral";
      recipientUserId?: string;
      state: string;
    }
  | undefined {
  const expectedUrl = new URL(args.authorizeEndpoint);
  const calls = readCapturedSlackApiCalls();

  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index];
    if (
      call.method !== "chat.postEphemeral" &&
      call.method !== "chat.postMessage"
    ) {
      continue;
    }
    const text = toFirstString(call.params.text);
    if (!text) {
      continue;
    }
    const authLink = parseSlackMrkdwnLinkUrl(text);
    if (!authLink) {
      continue;
    }
    if (
      authLink.origin !== expectedUrl.origin ||
      authLink.pathname !== expectedUrl.pathname
    ) {
      continue;
    }
    const state = authLink.searchParams.get("state")?.trim();
    if (state && !args.consumedStates.has(state)) {
      if (call.method === "chat.postEphemeral") {
        const recipientUserId = toFirstString(call.params.user);
        if (!recipientUserId) {
          throw new Error("OAuth ephemeral delivery did not include a user");
        }
        return { delivery: "ephemeral", recipientUserId, state };
      }
      const channel = toFirstString(call.params.channel);
      if (!channel?.startsWith("D")) {
        throw new Error(
          "OAuth authorization link was posted through chat.postMessage outside a direct message",
        );
      }
      const openCall = calls
        .slice(0, index)
        .reverse()
        .find((candidate) => candidate.method === "conversations.open");
      const recipientUserId = openCall
        ? toFirstString(openCall.params.users)
        : undefined;
      return {
        channelId: channel,
        delivery: "direct_message",
        ...(recipientUserId ? { recipientUserId } : {}),
        state,
      };
    }
  }
  return undefined;
}

function wasOAuthLinkDeliveredToUser(
  delivered: {
    channelId?: string;
    recipientUserId?: string;
  },
  expected: { channelId?: string; userId: string },
): boolean {
  return (
    delivered.recipientUserId === expected.userId ||
    (delivered.channelId !== undefined &&
      expected.channelId !== undefined &&
      delivered.channelId === expected.channelId)
  );
}

/** Complete the MCP OAuth callback for the latest link the runtime delivered. */
export async function autoCompleteMcpOauth(args: {
  agentRunner: AgentRunner;
  completions: AuthorizationCompletion[];
  provider: string;
  consumedStates: Set<string>;
}): Promise<boolean> {
  const provider = args.provider.trim() || EVAL_MCP_AUTH_PROVIDER;
  if (provider !== EVAL_MCP_AUTH_PROVIDER) {
    throw new Error(
      `No MCP OAuth authorization endpoint configured for eval provider "${provider}"`,
    );
  }
  const delivered = findLatestOAuthStateFromSlackCalls({
    authorizeEndpoint: EVAL_MCP_AUTHORIZATION_ENDPOINT,
    consumedStates: args.consumedStates,
  });
  if (!delivered) {
    return false;
  }
  const authSession = await getMcpAuthSession(delivered.state);
  if (!authSession || authSession.provider !== provider) {
    throw new Error(
      `Delivered MCP OAuth state did not resolve to provider "${provider}"`,
    );
  }
  if (
    !wasOAuthLinkDeliveredToUser(delivered, {
      channelId: authSession.channelId,
      userId: authSession.userId,
    })
  ) {
    throw new Error(
      `MCP OAuth authorization link was delivered to ${delivered.recipientUserId} instead of ${authSession.userId}`,
    );
  }

  const response = await completeMcpOauthCallbackRoute({
    provider,
    authSessionId: delivered.state,
    agentRunner: args.agentRunner,
  });
  if (response.status !== 200) {
    throw new Error(
      `MCP OAuth callback returned ${response.status}: ${await response.text()}`,
    );
  }
  const credentials = await getMcpStoredOAuthCredentials(
    authSession.userId,
    provider,
  );
  if (!credentials?.tokens?.access_token) {
    throw new Error(
      `MCP OAuth callback completed without stored credentials for provider "${provider}"`,
    );
  }
  args.completions.push({
    credentialStored: true,
    delivery: delivered.delivery,
    kind: "mcp",
    provider,
    userId: authSession.userId,
  });
  args.consumedStates.add(delivered.state);
  return true;
}

/** Complete the plugin OAuth callback for the latest link the runtime delivered. */
export async function autoCompleteOauth(args: {
  agentRunner: AgentRunner;
  completions: AuthorizationCompletion[];
  provider: string;
  consumedStates: Set<string>;
}): Promise<boolean> {
  const provider = args.provider.trim() || EVAL_OAUTH_PROVIDER;
  const providerConfig = pluginCatalogRuntime.getOAuthConfig(provider);
  if (!providerConfig) {
    throw new Error(`Unknown OAuth provider "${provider}" in eval harness`);
  }

  const delivered = findLatestOAuthStateFromSlackCalls({
    authorizeEndpoint: providerConfig.authorizeEndpoint,
    consumedStates: args.consumedStates,
  });
  if (!delivered) {
    return false;
  }
  const storedState = parseOAuthStatePayload(
    await getStateAdapter().get(`oauth-state:${delivered.state}`),
  );
  if (!storedState || storedState.provider !== provider) {
    throw new Error(
      `Delivered OAuth state did not resolve to provider "${provider}"`,
    );
  }
  if (
    !wasOAuthLinkDeliveredToUser(delivered, {
      channelId: storedState.channelId,
      userId: storedState.userId,
    })
  ) {
    throw new Error(
      `OAuth authorization link was delivered to ${delivered.recipientUserId} instead of ${storedState.userId}`,
    );
  }
  const response = await runOauthCallbackRoute({
    provider,
    state: delivered.state,
    code: getDefaultOauthCode(provider),
    agentRunner: args.agentRunner,
  });
  if (response.status !== 200) {
    throw new Error(
      `OAuth callback returned ${response.status}: ${await response.text()}`,
    );
  }
  const credentials = await createUserTokenStore().get(
    storedState.userId,
    provider,
  );
  if (!credentials?.accessToken) {
    throw new Error(
      `OAuth callback completed without stored credentials for provider "${provider}"`,
    );
  }
  args.completions.push({
    credentialStored: true,
    delivery: delivered.delivery,
    kind: "plugin",
    provider,
    userId: storedState.userId,
  });
  args.consumedStates.add(delivered.state);
  return true;
}
