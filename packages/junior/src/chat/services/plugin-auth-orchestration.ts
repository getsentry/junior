import type { ChannelConfigurationService } from "@/chat/configuration/types";
import { CredentialUnavailableError } from "@/chat/credentials/broker";
import { unlinkProvider } from "@/chat/credentials/unlink-provider";
import type { UserTokenStore } from "@/chat/credentials/user-token-store";
import { formatProviderLabel, startOAuthFlow } from "@/chat/oauth-flow";
import {
  getPluginDefinition,
  getPluginOAuthConfig,
} from "@/chat/plugins/registry";
import type { Skill } from "@/chat/skills";

export class PluginAuthorizationPauseError extends Error {
  readonly provider: string;

  constructor(provider: string) {
    super(`Plugin authorization started for ${provider}`);
    this.name = "PluginAuthorizationPauseError";
    this.provider = provider;
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
  userTokenStore?: UserTokenStore;
}

export interface PluginAuthOrchestration {
  handleCredentialUnavailable: (input: {
    activeSkill: Skill | null;
    error: CredentialUnavailableError;
  }) => Promise<never>;
  handleCommandFailure: (input: {
    activeSkill: Skill | null;
    command: string;
    details: unknown;
  }) => Promise<void>;
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
  ].some((pattern) => pattern.test(text));
}

function commandTargetsProvider(
  provider: string,
  command: string,
  details: {
    stdout?: string;
    stderr?: string;
  },
): boolean {
  const normalizedCommand = command.trim().toLowerCase();
  if (!normalizedCommand) {
    return false;
  }

  if (provider === "github" && /^(gh|git)\b/.test(normalizedCommand)) {
    return true;
  }

  if (provider === "sentry" && /\bsentry-cli\b/.test(normalizedCommand)) {
    return true;
  }

  const plugin = getPluginDefinition(provider);
  const candidates = new Set<string>([provider.toLowerCase()]);
  const credentials = plugin?.manifest.credentials;
  if (credentials) {
    candidates.add(credentials.authTokenEnv.toLowerCase());
    for (const domain of credentials.apiDomains) {
      candidates.add(domain.toLowerCase());
    }
  }

  const combinedText = `${normalizedCommand}\n${details.stdout?.toLowerCase() ?? ""}\n${details.stderr?.toLowerCase() ?? ""}`;
  return [...candidates].some((candidate) => combinedText.includes(candidate));
}

/**
 * Start plugin OAuth from an authenticated bash command and park the turn.
 */
export function createPluginAuthOrchestration(
  deps: PluginAuthOrchestrationDeps,
  abortAgent: () => void,
): PluginAuthOrchestration {
  let pendingPause: PluginAuthorizationPauseError | undefined;

  const startAuthorizationPause = async (
    provider: string,
    activeSkill: Skill | null,
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
    const oauthResult = await startOAuthFlow(provider, {
      requesterId: deps.requesterId,
      channelId: deps.channelId,
      threadTs: deps.threadTs,
      userMessage: deps.userMessage,
      channelConfiguration: deps.channelConfiguration,
      activeSkillName: activeSkill?.name ?? undefined,
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

    if (
      options?.unlinkExistingProvider &&
      deps.requesterId &&
      deps.userTokenStore
    ) {
      await unlinkProvider(deps.requesterId, provider, deps.userTokenStore);
    }

    pendingPause = new PluginAuthorizationPauseError(provider);
    abortAgent();
    throw pendingPause;
  };

  const handleCredentialUnavailable = async (input: {
    activeSkill: Skill | null;
    error: CredentialUnavailableError;
  }): Promise<never> => {
    if (pendingPause) {
      throw pendingPause;
    }

    if (!deps.requesterId || !getPluginOAuthConfig(input.error.provider)) {
      throw input.error;
    }

    return await startAuthorizationPause(
      input.error.provider,
      input.activeSkill,
    );
  };

  return {
    handleCredentialUnavailable,
    handleCommandFailure: async (input) => {
      const provider = input.activeSkill?.pluginProvider;
      if (
        !provider ||
        !deps.requesterId ||
        !deps.userTokenStore ||
        !getPluginOAuthConfig(provider) ||
        !isCommandAuthFailure(input.details) ||
        !commandTargetsProvider(provider, input.command, input.details)
      ) {
        return;
      }

      await startAuthorizationPause(provider, input.activeSkill, {
        unlinkExistingProvider: true,
      });
    },
    getPendingPause: () => pendingPause,
  };
}
