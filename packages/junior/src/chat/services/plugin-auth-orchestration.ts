import type { ChannelConfigurationService } from "@/chat/configuration/types";
import { CredentialUnavailableError } from "@/chat/credentials/broker";
import { unlinkProvider } from "@/chat/credentials/unlink-provider";
import type { UserTokenStore } from "@/chat/credentials/user-token-store";
import { formatProviderLabel, startOAuthFlow } from "@/chat/oauth-flow";
import { canReusePendingAuthLink } from "@/chat/services/pending-auth";
import { AuthorizationPauseError } from "@/chat/services/auth-pause";
import type { ConversationPendingAuthState } from "@/chat/state/conversation";
import { getPluginOAuthConfig } from "@/chat/plugins/registry";

export class PluginAuthorizationPauseError extends AuthorizationPauseError {
  constructor(
    provider: string,
    disposition: "link_already_sent" | "link_sent",
  ) {
    super("plugin", provider, disposition);
  }
}

export interface PluginAuthOrchestrationDeps {
  conversationId?: string;
  sessionId?: string;
  requesterId?: string;
  channelId?: string;
  threadTs?: string;
  userMessage: string;
  channelConfiguration?: ChannelConfigurationService;
  currentPendingAuth?: ConversationPendingAuthState;
  onPendingAuth?: (
    pendingAuth: ConversationPendingAuthState,
  ) => void | Promise<void>;
  userTokenStore?: UserTokenStore;
}

export interface PluginAuthOrchestration {
  handleCredentialUnavailable: (input: {
    provider: string;
    error: CredentialUnavailableError;
  }) => Promise<never>;
  handleCommandFailure: (input: { details: unknown }) => Promise<void>;
  getPendingPause: () => PluginAuthorizationPauseError | undefined;
}

function isCommandAuthFailure(details: unknown): details is {
  exit_code: number;
  stdout?: string;
  stderr?: string;
} {
  if (!details || typeof details !== "object") {
    return false;
  }

  const result = details as {
    exit_code?: unknown;
    stdout?: unknown;
    stderr?: unknown;
  };
  if (typeof result.exit_code !== "number" || result.exit_code === 0) {
    return false;
  }

  const text =
    `${typeof result.stdout === "string" ? result.stdout : ""}\n${typeof result.stderr === "string" ? result.stderr : ""}`.toLowerCase();
  if (!text.trim()) {
    return false;
  }

  return [
    /\b401\b/,
    /\bunauthorized\b/,
    /\bbad credentials\b/,
    /\binvalid token\b/,
    /\btoken (?:expired|revoked)\b/,
    /\bexpired token\b/,
    /\bmissing scopes?\b/,
    /\binsufficient scope\b/,
    /\binvalid grant\b/,
    /\breauthoriz/,
    /\bno [a-z0-9-]+ credentials available\b/,
    /junior_command_proxy_auth_required/,
  ].some((pattern) => pattern.test(text));
}

function commandProxyAuthProvider(details: unknown): string | undefined {
  if (!details || typeof details !== "object") {
    return undefined;
  }
  const result = details as { stdout?: unknown; stderr?: unknown };
  const text = `${typeof result.stdout === "string" ? result.stdout : ""}\n${typeof result.stderr === "string" ? result.stderr : ""}`;
  const match = text.match(
    /JUNIOR_COMMAND_PROXY_(?:AUTH_REQUIRED|PROVIDER) provider=([a-z][a-z0-9-]*)/,
  );
  return match?.[1];
}

/** Start plugin OAuth from command-proxy failures and park the turn. */
export function createPluginAuthOrchestration(
  deps: PluginAuthOrchestrationDeps,
  abortAgent: () => void,
): PluginAuthOrchestration {
  let pendingPause: PluginAuthorizationPauseError | undefined;

  const startAuthorizationPause = async (
    provider: string,
    options?: {
      unlinkExistingProvider?: boolean;
    },
  ): Promise<never> => {
    if (pendingPause) {
      throw pendingPause;
    }
    if (!deps.requesterId || !getPluginOAuthConfig(provider)) {
      throw new Error(`Cannot start plugin authorization for ${provider}`);
    }

    const providerLabel = formatProviderLabel(provider);
    const reusingPendingLink = canReusePendingAuthLink({
      pendingAuth: deps.currentPendingAuth,
      kind: "plugin",
      provider,
      requesterId: deps.requesterId,
    });

    if (!reusingPendingLink) {
      const oauthResult = await startOAuthFlow(provider, {
        requesterId: deps.requesterId,
        channelId: deps.channelId,
        threadTs: deps.threadTs,
        userMessage: deps.userMessage,
        channelConfiguration: deps.channelConfiguration,
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
        sessionId: deps.sessionId,
        linkSentAtMs: reusingPendingLink
          ? deps.currentPendingAuth!.linkSentAtMs
          : Date.now(),
      });
    }
    pendingPause = new PluginAuthorizationPauseError(
      provider,
      reusingPendingLink ? "link_already_sent" : "link_sent",
    );
    abortAgent();
    throw pendingPause;
  };

  const handleCredentialUnavailable = async (input: {
    provider: string;
    error: CredentialUnavailableError;
  }): Promise<never> => {
    if (pendingPause) {
      throw pendingPause;
    }

    if (!deps.requesterId || !getPluginOAuthConfig(input.provider)) {
      throw input.error;
    }

    return await startAuthorizationPause(input.provider);
  };

  return {
    handleCredentialUnavailable,
    handleCommandFailure: async (input) => {
      const provider = commandProxyAuthProvider(input.details);
      if (
        !provider ||
        !deps.requesterId ||
        !deps.userTokenStore ||
        !getPluginOAuthConfig(provider) ||
        !isCommandAuthFailure(input.details)
      ) {
        return;
      }

      await startAuthorizationPause(provider, {
        unlinkExistingProvider: true,
      });
    },
    getPendingPause: () => pendingPause,
  };
}
