/**
 * MCP OAuth callback handler.
 *
 * Public signed callbacks relay to the owning CLI. The loopback callback
 * finalizes local MCP authorization and leaves continuation to that CLI.
 * Slack callbacks save authorization readiness and wake the conversation
 * worker. Only that worker can change agent history or resume the Turn.
 */
import { getStateAdapter } from "@/chat/state/adapter";
import { acquireActiveLock } from "@/chat/state/locks";
import { coerceThreadConversationState } from "@/chat/state/conversation";

import {
  deleteMcpAuthSession,
  getMcpAuthSession,
  getMcpStoredOAuthCredentials,
  putMcpStoredOAuthCredentials,
  type McpAuthSessionState,
} from "@/chat/mcp/auth-store";
import { finalizeMcpAuthorization } from "@/chat/mcp/oauth";
import { getMcpProviderErrorAttributes } from "@/chat/mcp/errors";
import { logException } from "@/chat/logging";

import { getPersistedThreadState } from "@/chat/runtime/thread-state";

import { getConversationPendingAuth } from "@/chat/services/pending-auth";
import { getTurnRecord } from "@/chat/task-execution/checkpoint";
import {
  recordAuthenticationLinked,
  recordAuthorizationCompleted,
} from "@/chat/conversations/projection";
import { botConfig } from "@/chat/config";
import { formatProviderLabel } from "@/chat/oauth-flow";

import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import {
  wakeAuthorizedTurn,
  wakePausedTurn,
} from "@/chat/task-execution/turn-wake";

import { htmlCallbackResponse } from "@/handlers/oauth-html";
import type { WaitUntilFn } from "@/handlers/types";

import { relayLocalOAuthCallback } from "@/chat/local/oauth-relay";
import { deleteWebAuthorization } from "@/chat/conversations/web-authorization";

function callbackPages(botName: string) {
  return {
    missing_state: {
      title: "Authorization failed",
      message: "Missing state parameter.",
      status: 400,
    },
    provider_error: {
      title: "Authorization failed",
      message: "The provider returned an authorization error.",
      status: 400,
    },
    missing_code: {
      title: "Authorization failed",
      message: "Missing code parameter.",
      status: 400,
    },
    expired: {
      title: "Authorization expired",
      message: `This authorization link is no longer active. Return to ${botName} and retry the original request.`,
      status: 400,
    },
    success: {
      title: "Authorization complete",
      message: `Your MCP access is connected. ${botName} will continue the paused request.`,
      status: 200,
    },
    failure: {
      title: "Authorization failed",
      message: `${botName} could not finish the authorization callback. Return to ${botName} and retry the original request.`,
      status: 500,
    },
  } as const;
}

interface McpOAuthCallbackOptions {
  /** Queue used to wake parked turns after authorization completes. */
  conversationWorkQueue?: ConversationWorkQueue;
}

class McpOAuthAttemptExpiredError extends Error {
  constructor() {
    super("MCP OAuth authorization attempt is no longer current");
    this.name = "McpOAuthAttemptExpiredError";
  }
}

function mcpAuthorizationId(args: {
  provider: string;
  sessionId: string;
}): string {
  return `${args.sessionId}:mcp:${args.provider}`;
}

function htmlResponse(
  kind: keyof ReturnType<typeof callbackPages>,
  options?: { local?: boolean },
): Response {
  const botName = botConfig.userName;
  const pages = callbackPages(botName);
  const page =
    kind === "success" && options?.local
      ? {
          ...pages.success,
          message: `Your MCP access is connected. ${botName} will continue the paused request in the local client.`,
        }
      : pages[kind];
  const footerMessage =
    kind === "success" && !options?.local
      ? `You can close this tab and return to ${botName}.`
      : undefined;
  return htmlCallbackResponse(page.title, page.message, page.status, {
    footerMessage,
  });
}

/** Queue the exact MCP authorization attempt without changing thread state. */
async function wakeAuthorizedMcpTurn(args: {
  authSession: McpAuthSessionState;
  provider: string;
  queue?: ConversationWorkQueue;
}): Promise<void> {
  const { authSession, provider } = args;
  if (!authSession.destination) return;

  await wakeAuthorizedTurn(
    {
      conversationId: authSession.conversationId,
      destination: authSession.destination,
      turnId: authSession.sessionId,
      kind: "mcp",
      provider,
      actorId: authSession.userId,
      authSessionId: authSession.authSessionId,
      configuration: authSession.configuration,
      toolChannelId: authSession.toolChannelId,
      authorizationId: mcpAuthorizationId({
        provider,
        sessionId: authSession.sessionId,
      }),
    },
    args.queue,
  );
}

async function isCurrentMcpAuthorizationAttempt(
  authSession: McpAuthSessionState,
  provider: string,
): Promise<boolean> {
  const conversationId = mcpConversationId(authSession);
  if (!conversationId) {
    return false;
  }

  const currentState = await getPersistedThreadState(conversationId);
  const conversation = coerceThreadConversationState(currentState);
  const pendingAuth = getConversationPendingAuth({
    conversation,
    kind: "mcp",
    provider,
    actorId: authSession.userId,
  });

  return (
    pendingAuth?.authSessionId === authSession.authSessionId &&
    pendingAuth.sessionId === authSession.sessionId
  );
}

function mcpConversationId(
  authSession: McpAuthSessionState,
): string | undefined {
  if (
    authSession.destination?.platform === "local" ||
    authSession.source?.kind === "web"
  ) {
    return authSession.conversationId;
  }
  if (authSession.channelId && authSession.threadTs) {
    return `slack:${authSession.channelId}:${authSession.threadTs}`;
  }
  return undefined;
}

/** Commit one shared credential mutation only while this attempt owns the thread. */
async function runCurrentMcpCredentialMutation<T>(
  authSession: McpAuthSessionState,
  provider: string,
  mutation: () => Promise<T>,
): Promise<T> {
  const conversationId = mcpConversationId(authSession);
  if (!conversationId) {
    throw new McpOAuthAttemptExpiredError();
  }

  const stateAdapter = getStateAdapter();
  await stateAdapter.connect();
  const lock = await acquireActiveLock(stateAdapter, conversationId);
  if (!lock) {
    throw new Error(
      `Could not acquire MCP OAuth callback lock for ${conversationId}`,
    );
  }
  try {
    if (!(await isCurrentMcpAuthorizationAttempt(authSession, provider))) {
      throw new McpOAuthAttemptExpiredError();
    }
    return await mutation();
  } finally {
    await stateAdapter.releaseLock(lock);
  }
}

/** Exchange MCP credentials and queue the authorized Turn before reporting success. */
export async function GET(
  request: Request,
  provider: string,
  waitUntil: WaitUntilFn,
  options: McpOAuthCallbackOptions,
): Promise<Response> {
  const localRelay = await relayLocalOAuthCallback(request);
  if (localRelay) {
    return localRelay;
  }
  const url = new URL(request.url);
  const state = url.searchParams.get("state")?.trim();
  const code = url.searchParams.get("code")?.trim();
  const error = url.searchParams.get("error")?.trim();

  if (!state) {
    return htmlResponse("missing_state");
  }
  if (error) {
    // Provider denied or failed auth. Clear client/discovery only while this
    // attempt still owns the conversation lock, matching success-path writes.
    try {
      const pendingSession = await getMcpAuthSession(state);
      if (pendingSession && pendingSession.provider === provider) {
        try {
          await runCurrentMcpCredentialMutation(
            pendingSession,
            provider,
            async () => {
              const credentials = await getMcpStoredOAuthCredentials(
                pendingSession.userId,
                provider,
              );
              if (
                !credentials?.clientInformation &&
                !credentials?.discoveryState
              ) {
                return;
              }
              const nextCredentials = credentials.tokens
                ? { tokens: credentials.tokens }
                : {};
              await putMcpStoredOAuthCredentials(
                pendingSession.userId,
                provider,
                nextCredentials,
              );
            },
          );
        } catch (cleanupError) {
          if (!(cleanupError instanceof McpOAuthAttemptExpiredError)) {
            logException(
              cleanupError,
              "mcp.oauth_callback.provider_error_cleanup.failed",
              { "app.credential.provider": provider },
            );
          }
        }
        await deleteMcpAuthSession(pendingSession.authSessionId);
      }
    } catch (cleanupError) {
      logException(
        cleanupError,
        "mcp.oauth_callback.provider_error_cleanup.failed",
        {
          "app.credential.provider": provider,
        },
      );
    }
    return htmlResponse("provider_error");
  }
  if (!code) {
    return htmlResponse("missing_code");
  }

  try {
    const pendingSession = await getMcpAuthSession(state);
    if (
      !pendingSession ||
      pendingSession.provider !== provider ||
      !(await isCurrentMcpAuthorizationAttempt(pendingSession, provider))
    ) {
      if (pendingSession) {
        await deleteMcpAuthSession(pendingSession.authSessionId);
      }
      return htmlResponse("expired");
    }

    const authSession = await finalizeMcpAuthorization(
      provider,
      state,
      code,
      async (mutation) =>
        await runCurrentMcpCredentialMutation(
          pendingSession,
          provider,
          mutation,
        ),
    );
    let providerLabel: string | undefined;
    try {
      providerLabel = formatProviderLabel(provider);
    } catch {
      providerLabel = undefined;
    }
    try {
      await recordAuthenticationLinked({
        conversationId: authSession.conversationId,
        provider,
        actorId: authSession.userId,
        authorizationId: mcpAuthorizationId({
          provider,
          sessionId: authSession.sessionId,
        }),
        turnId: authSession.sessionId,
        ...(providerLabel ? { providerLabel } : undefined),
      });
    } catch (error) {
      logException(error, "mcp.oauth_callback.authentication_event.failed", {
        "app.credential.provider": provider,
      });
    }
    try {
      await deleteMcpAuthSession(authSession.authSessionId);
    } catch (cleanupError) {
      logException(cleanupError, "mcp.oauth_callback.session_cleanup.failed", {
        "app.credential.provider": provider,
      });
    }

    if (authSession.source?.kind === "web" && authSession.destination) {
      waitUntil(async () => {
        const turn = await getTurnRecord(
          authSession.conversationId,
          authSession.sessionId,
        );
        // Always clear the dashboard prompt. A superseded/abandoned turn must
        // not leave a stale connect banner after OAuth completes late.
        await deleteWebAuthorization({
          actorId: authSession.userId,
          conversationId: authSession.conversationId,
        });
        if (!turn || turn.state !== "paused" || turn.resumeReason !== "auth") {
          return;
        }
        await recordAuthorizationCompleted({
          conversationId: authSession.conversationId,
          kind: "mcp",
          provider,
          actorId: authSession.userId,
          authorizationId: mcpAuthorizationId({
            provider,
            sessionId: authSession.sessionId,
          }),
        });
        await wakePausedTurn(
          {
            conversationId: authSession.conversationId,
            destination: authSession.destination!,
            turnId: authSession.sessionId,
            expectedVersion: turn.version,
          },
          options.conversationWorkQueue
            ? { queue: options.conversationWorkQueue }
            : undefined,
        );
      });
    } else if (authSession.destination?.platform !== "local") {
      await wakeAuthorizedMcpTurn({
        authSession,
        queue: options.conversationWorkQueue,
        provider,
      });
    }

    return htmlResponse("success", {
      // Web roots keep a local destination for conversation-only delivery.
      // Only the CLI path should get the local-client success copy.
      local:
        authSession.destination?.platform === "local" &&
        authSession.source?.kind !== "web",
    });
  } catch (callbackError) {
    if (callbackError instanceof McpOAuthAttemptExpiredError) {
      await deleteMcpAuthSession(state);
      return htmlResponse("expired");
    }
    logException(callbackError, "mcp.oauth_callback.failed", {
      "app.credential.provider": provider,
      ...getMcpProviderErrorAttributes(callbackError),
    });
    return htmlResponse("failure");
  }
}
