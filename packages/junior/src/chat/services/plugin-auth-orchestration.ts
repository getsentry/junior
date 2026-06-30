/**
 * Plugin authorization pause orchestration.
 *
 * This module detects plugin credential failures from the sandbox egress layer
 * and maps them onto the same paused-run contract used by MCP auth. It owns
 * provider attribution, private-link delivery/reuse, session-log recording,
 * and credential cleanup.
 *
 * Auth failures are detected exclusively through the structured `auth_required`
 * signal emitted by the egress proxy — never inferred from bash command text,
 * stdout patterns, or exit codes.
 */
import { THREAD_STATE_TTL_MS } from "chat";
import type { Destination, Source } from "@sentry/junior-plugin-api";
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
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
import { parseSandboxEgressAuthRequiredSignal } from "@/chat/sandbox/egress/schemas";

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

export interface PluginAuthOrchestrationInput {
  abortAgent: () => void;
  conversationId?: string;
  sessionId?: string;
  requesterId?: string;
  channelId?: string;
  destination?: Destination;
  source?: Source;
  threadTs?: string;
  userMessage: string;
  channelConfiguration?: ChannelConfigurationService;
  pendingAuth?: ConversationPendingAuthState;
  recordPendingAuth?: (
    pendingAuth: ConversationPendingAuthState,
  ) => void | Promise<void>;
  authorizationFlowMode?: AuthorizationFlowMode;
  userTokenStore?: UserTokenStore;
}

export interface PluginAuthOrchestration {
  /**
   * Inspect a sandbox tool result for an `auth_required` signal from the
   * egress proxy. If one is present and an OAuth flow is available, parks the
   * current run and sends the user an authorization link. No-ops when the
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
 * Start plugin OAuth from a sandbox egress auth signal and park the run.
 */
export function createPluginAuthOrchestration(
  input: PluginAuthOrchestrationInput,
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
    if (!input.requesterId || !pluginCatalogRuntime.getOAuthConfig(provider)) {
      throw new Error(`Cannot start plugin authorization for ${provider}`);
    }
    if (input.authorizationFlowMode === "disabled") {
      throw new AuthorizationFlowDisabledError("plugin", provider);
    }
    const recordPendingAuth = input.sessionId
      ? input.recordPendingAuth
      : undefined;
    if (input.sessionId && !recordPendingAuth) {
      throw new Error(
        `Missing pending auth recorder for plugin authorization pause "${provider}"`,
      );
    }

    const providerLabel = formatProviderLabel(provider);
    const reusingPendingLink = input.sessionId
      ? canReusePendingAuthLink({
          pendingAuth: input.pendingAuth,
          kind: "plugin",
          provider,
          requesterId: input.requesterId,
          sessionId: input.sessionId,
          ...(options?.scope ? { scope: options.scope } : {}),
        })
      : false;

    if (!reusingPendingLink) {
      const oauthResult = await startOAuthFlow(provider, {
        requesterId: input.requesterId,
        channelId: input.channelId,
        destination: input.destination,
        source: input.source,
        threadTs: input.threadTs,
        userMessage: input.userMessage,
        channelConfiguration: input.channelConfiguration,
        ...(options?.scope ? { scope: options.scope } : {}),
        resumeConversationId: input.conversationId,
        resumeSessionId: input.sessionId,
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
      input.requesterId &&
      input.userTokenStore
    ) {
      await unlinkProvider(input.requesterId, provider, input.userTokenStore);
    }

    if (input.sessionId && recordPendingAuth) {
      await recordPendingAuth({
        kind: "plugin",
        provider,
        requesterId: input.requesterId,
        ...(options?.scope ? { scope: options.scope } : {}),
        sessionId: input.sessionId,
        linkSentAtMs: reusingPendingLink
          ? input.pendingAuth!.linkSentAtMs
          : Date.now(),
      });
    }
    if (input.conversationId && input.sessionId) {
      await recordAuthorizationRequested({
        conversationId: input.conversationId,
        kind: "plugin",
        provider,
        requesterId: input.requesterId,
        authorizationId: authorizationId({
          kind: "plugin",
          provider,
          sessionId: input.sessionId,
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
    input.abortAgent();
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

      if (!input.requesterId || !input.userTokenStore) {
        if (input.authorizationFlowMode === "disabled") {
          throw new AuthorizationFlowDisabledError("plugin", provider);
        }
        throw new PluginCredentialFailureError(
          provider,
          signal.message ??
            `${formatProviderLabel(provider)} credentials are required. Please connect your ${formatProviderLabel(provider)} account and try again.`,
        );
      }

      if (!pluginCatalogRuntime.getOAuthConfig(authorization.provider)) {
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
