import type { ChannelConfigurationService } from "@/chat/configuration/types";
import { unlinkProvider } from "@/chat/credentials/unlink-provider";
import type { UserTokenStore } from "@/chat/credentials/user-token-store";
import { formatProviderLabel, startOAuthFlow } from "@/chat/oauth-flow";
import { canReusePendingAuthLink } from "@/chat/services/pending-auth";
import { AuthorizationPauseError } from "@/chat/services/auth-pause";
import type { ConversationPendingAuthState } from "@/chat/state/conversation";
import {
  getPluginDefinition,
  getPluginProviders,
  getPluginOAuthConfig,
} from "@/chat/plugins/registry";
import type { Skill } from "@/chat/skills";

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
    /\bjunior-auth-required\b/,
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

function commandText(details: unknown): string {
  if (!details || typeof details !== "object") {
    return "";
  }
  const result = details as {
    stdout?: unknown;
    stderr?: unknown;
  };
  return `${typeof result.stdout === "string" ? result.stdout : ""}\n${typeof result.stderr === "string" ? result.stderr : ""}`;
}

function explicitAuthRequiredProvider(details: unknown): string | undefined {
  const match = /\bjunior-auth-required\s+provider=([a-z0-9-]+)\b/.exec(
    commandText(details).toLowerCase(),
  );
  return match?.[1];
}

function registeredProviderNames(): string[] {
  const providers = new Set<string>();
  for (const plugin of getPluginProviders()) {
    const domains = [
      ...(plugin.manifest.credentials?.domains ?? []),
      ...(plugin.manifest.domains ?? []),
    ];
    if (domains.length > 0) {
      providers.add(plugin.manifest.name);
    }
  }
  return [...providers].sort((left, right) => left.localeCompare(right));
}

function commandTargetsProvider(
  provider: string,
  command: string,
  details: unknown,
): boolean {
  const normalizedCommand = command.trim().toLowerCase();
  if (!normalizedCommand) {
    return false;
  }

  if (provider === "github" && /^(gh|git)\b/.test(normalizedCommand)) {
    return true;
  }

  const plugin = getPluginDefinition(provider);
  const candidates = new Set<string>([provider.toLowerCase()]);
  const manifest = plugin?.manifest;
  const credentials = manifest?.credentials;
  if (credentials) {
    candidates.add(credentials.authTokenEnv.toLowerCase());
    for (const domain of credentials.domains) {
      candidates.add(domain.toLowerCase());
    }
  }
  for (const domain of manifest?.domains ?? []) {
    candidates.add(domain.toLowerCase());
  }

  const combinedText = `${normalizedCommand}\n${commandText(details).toLowerCase()}`;
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

  return {
    handleCommandFailure: async (input) => {
      const providers = registeredProviderNames();
      const authFailure = isCommandAuthFailure(input.details);
      if (!authFailure) {
        return;
      }
      const explicitProvider = explicitAuthRequiredProvider(input.details);
      const provider =
        explicitProvider && providers.includes(explicitProvider)
          ? explicitProvider
          : providers.find((availableProvider) =>
              commandTargetsProvider(
                availableProvider,
                input.command,
                input.details,
              ),
            );
      if (
        !provider ||
        !deps.requesterId ||
        !deps.userTokenStore ||
        !getPluginOAuthConfig(provider)
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
