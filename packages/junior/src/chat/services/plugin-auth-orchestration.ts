/**
 * Plugin authorization pause orchestration.
 *
 * This module detects plugin credential failures from the sandbox egress layer
 * and maps them onto the same paused-turn contract used by MCP auth. It owns
 * provider attribution, private-link delivery/reuse, session-log recording,
 * and credential cleanup.
 *
 * Auth failures are detected exclusively through the structured `auth_required`
 * signal emitted by the egress proxy — never inferred from bash command text,
 * stdout patterns, or exit codes.
 */
import { THREAD_STATE_TTL_MS } from "chat";
import type { Destination } from "@sentry/junior-plugin-api";
import type { ChannelConfigurationService } from "@/chat/configuration/types";
import { unlinkProvider } from "@/chat/credentials/unlink-provider";
import type { UserTokenStore } from "@/chat/credentials/user-token-store";
import { formatProviderLabel, startOAuthFlow } from "@/chat/oauth-flow";
import { canReusePendingAuthLink } from "@/chat/services/pending-auth";
import {
  AuthorizationFlowDisabledError,
  AuthorizationPauseError,
  type AuthorizationFlowMode,
} from "@/chat/services/auth-pause";
import type { ConversationPendingAuthState } from "@/chat/state/conversation";
import { recordAuthorizationRequested } from "@/chat/state/session-log";
import { getPluginOAuthConfig } from "@/chat/plugins/registry";
import { parseSandboxEgressAuthRequiredSignal } from "@/chat/sandbox/egress-schemas";

export class PluginAuthorizationPauseError extends AuthorizationPauseError {
  constructor(
    provider: string,
    providerDisplayName: string,
    disposition: "link_already_sent" | "link_sent",
  ) {
    super("plugin", provider, providerDisplayName, disposition);
  }
}

export class PluginCredentialFailureError extends Error {
  readonly provider: string;

  constructor(provider: string, message: string) {
    super(message);
    this.name = "PluginCredentialFailureError";
    this.provider = provider;
  }
}

export interface PluginAuthOrchestrationDeps {
  conversationId?: string;
  sessionId?: string;
  requesterId?: string;
  channelId?: string;
  destination?: Destination;
  threadTs?: string;
  userMessage: string;
  channelConfiguration?: ChannelConfigurationService;
  currentPendingAuth?: ConversationPendingAuthState;
  onPendingAuth?: (
    pendingAuth: ConversationPendingAuthState,
  ) => void | Promise<void>;
  authorizationFlowMode?: AuthorizationFlowMode;
  userTokenStore?: UserTokenStore;
}

export interface PluginAuthOrchestration {
  /**
   * Inspect a sandbox tool result for an `auth_required` signal from the
   * egress proxy. If one is present and an OAuth flow is available, parks the
   * current turn and sends the user an authorization link. No-ops when the
   * result carries no auth signal.
   */
  maybeHandleAuthSignal: (details: unknown) => Promise<void>;
  getPendingPause: () => PluginAuthorizationPauseError | undefined;
}

/** Normalize a sandbox egress auth signal and preserve host failure messages. */
function pluginAuthRequiredSignal(details: unknown):
  | {
      authorization?: {
        provider: string;
        scope?: string;
        type: "oauth";
      };
      grant: {
        access: "read" | "write";
        name: string;
        reason?: string;
      };
      kind: "auth_required" | "unavailable";
      message?: string;
      provider: string;
    }
  | undefined {
  if (!details || typeof details !== "object") {
    return undefined;
  }
  const signal = (details as { auth_required?: unknown }).auth_required;
  const parsedSignal = parseSandboxEgressAuthRequiredSignal(signal);
  if (!parsedSignal) {
    return undefined;
  }
  return {
    provider: parsedSignal.provider,
    grant: parsedSignal.grant,
    kind: parsedSignal.kind,
    ...(parsedSignal.message ? { message: parsedSignal.message } : {}),
    ...(parsedSignal.authorization
      ? { authorization: parsedSignal.authorization }
      : {}),
  };
}

function authorizationId(args: {
  kind: "plugin";
  provider: string;
  sessionId: string;
}): string {
  return `${args.sessionId}:${args.kind}:${args.provider}`;
}

/**
 * Start plugin OAuth from a sandbox egress auth signal and park the turn.
 */
export function createPluginAuthOrchestration(
  deps: PluginAuthOrchestrationDeps,
  abortAgent: () => void,
): PluginAuthOrchestration {
  let pendingPause: PluginAuthorizationPauseError | undefined;

  const startAuthorizationPause = async (
    provider: string,
    options?: {
      scope?: string;
      unlinkExistingProvider?: boolean;
    },
  ): Promise<never> => {
    if (pendingPause) {
      throw pendingPause;
    }
    if (!deps.requesterId || !getPluginOAuthConfig(provider)) {
      throw new Error(`Cannot start plugin authorization for ${provider}`);
    }
    if (deps.authorizationFlowMode === "disabled") {
      throw new AuthorizationFlowDisabledError("plugin", provider);
    }

    const providerLabel = formatProviderLabel(provider);
    const reusingPendingLink = canReusePendingAuthLink({
      pendingAuth: deps.currentPendingAuth,
      kind: "plugin",
      provider,
      requesterId: deps.requesterId,
      ...(options?.scope ? { scope: options.scope } : {}),
    });

    if (!reusingPendingLink) {
      const oauthResult = await startOAuthFlow(provider, {
        requesterId: deps.requesterId,
        channelId: deps.channelId,
        destination: deps.destination,
        threadTs: deps.threadTs,
        userMessage: deps.userMessage,
        channelConfiguration: deps.channelConfiguration,
        ...(options?.scope ? { scope: options.scope } : {}),
        resumeConversationId: deps.conversationId,
        resumeSessionId: deps.sessionId,
      });

      if (!oauthResult.ok) {
        throw new Error(oauthResult.error);
      }
      if (!oauthResult.delivery) {
        throw new Error(
          `I need to connect your ${providerLabel} account first, but I wasn't able to send you a private authorization link. Please send me a direct message and try again.`,
        );
      }
    }

    if (
      options?.unlinkExistingProvider &&
      deps.requesterId &&
      deps.userTokenStore
    ) {
      await unlinkProvider(deps.requesterId, provider, deps.userTokenStore);
    }

    if (deps.sessionId) {
      await deps.onPendingAuth?.({
        kind: "plugin",
        provider,
        requesterId: deps.requesterId,
        ...(options?.scope ? { scope: options.scope } : {}),
        sessionId: deps.sessionId,
        linkSentAtMs: reusingPendingLink
          ? deps.currentPendingAuth!.linkSentAtMs
          : Date.now(),
      });
    }
    if (deps.conversationId && deps.sessionId) {
      await recordAuthorizationRequested({
        conversationId: deps.conversationId,
        kind: "plugin",
        provider,
        requesterId: deps.requesterId,
        authorizationId: authorizationId({
          kind: "plugin",
          provider,
          sessionId: deps.sessionId,
        }),
        delivery: reusingPendingLink
          ? "private_link_reused"
          : "private_link_sent",
        ttlMs: THREAD_STATE_TTL_MS,
      });
    }
    pendingPause = new PluginAuthorizationPauseError(
      provider,
      providerLabel,
      reusingPendingLink ? "link_already_sent" : "link_sent",
    );
    abortAgent();
    throw pendingPause;
  };

  return {
    maybeHandleAuthSignal: async (details) => {
      const signal = pluginAuthRequiredSignal(details);
      if (!signal) {
        return;
      }

      const { provider, authorization } = signal;

      if (signal.kind === "unavailable") {
        throw new PluginCredentialFailureError(
          provider,
          signal.message ??
            `${formatProviderLabel(provider)} credentials are unavailable.`,
        );
      }

      if (!authorization) {
        throw new PluginCredentialFailureError(
          provider,
          signal.message ??
            `${formatProviderLabel(provider)} credentials are required but no OAuth flow is available for this provider.`,
        );
      }

      if (!deps.requesterId || !deps.userTokenStore) {
        if (deps.authorizationFlowMode === "disabled") {
          throw new AuthorizationFlowDisabledError("plugin", provider);
        }
        throw new PluginCredentialFailureError(
          provider,
          signal.message ??
            `${formatProviderLabel(provider)} credentials are required. Please connect your ${formatProviderLabel(provider)} account and try again.`,
        );
      }

      if (!getPluginOAuthConfig(authorization.provider)) {
        throw new PluginCredentialFailureError(
          provider,
          signal.message ??
            `${formatProviderLabel(provider)} credentials are required but the provider is not configured for OAuth.`,
        );
      }

      await startAuthorizationPause(authorization.provider, {
        ...(authorization.scope ? { scope: authorization.scope } : {}),
        unlinkExistingProvider: true,
      });
    },
    getPendingPause: () => pendingPause,
  };
}
