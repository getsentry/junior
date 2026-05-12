import type { ChannelConfigurationService } from "@/chat/configuration/types";
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
}

export interface PluginAuthOrchestration {
  handleCommandFailure: (details: unknown) => Promise<void>;
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
  ].some((pattern) => pattern.test(text));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function commandProxyProviders(details: unknown): {
  activated: string[];
  authRequired: string[];
} {
  if (!details || typeof details !== "object") {
    return { activated: [], authRequired: [] };
  }
  const result = details as {
    command_proxy_providers?: unknown;
    command_proxy_auth_required_providers?: unknown;
  };
  return {
    activated: stringArray(result.command_proxy_providers),
    authRequired: stringArray(result.command_proxy_auth_required_providers),
  };
}

/** Start plugin OAuth from command-proxy failures and park the turn. */
export function createPluginAuthOrchestration(
  deps: PluginAuthOrchestrationDeps,
  abortAgent: () => void,
): PluginAuthOrchestration {
  let pendingPause: PluginAuthorizationPauseError | undefined;

  const startAuthorizationPause = async (provider: string): Promise<never> => {
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

  return {
    handleCommandFailure: async (details) => {
      const providers = commandProxyProviders(details);
      const provider =
        providers.authRequired[0] ??
        (providers.activated.length === 1 && isCommandAuthFailure(details)
          ? providers.activated[0]
          : undefined);
      if (!provider || !deps.requesterId || !getPluginOAuthConfig(provider)) {
        return;
      }

      await startAuthorizationPause(provider);
    },
    getPendingPause: () => pendingPause,
  };
}
