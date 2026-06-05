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
import {
  getPluginDefinition,
  getPluginOAuthConfig,
  getPluginProviders,
} from "@/chat/plugins/registry";
import { hasEgressCredentialHooks } from "@/chat/plugins/credential-hooks";
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

export interface PluginAuthOrchestrationInput {
  conversationId?: string;
  sessionId?: string;
  requesterId?: string;
  channelId?: string;
  destination?: Destination;
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

interface PluginAuthOrchestrationServices {
  formatProviderLabel: typeof formatProviderLabel;
  getPluginDefinition: typeof getPluginDefinition;
  getPluginProviders: typeof getPluginProviders;
  getPluginOAuthConfig: typeof getPluginOAuthConfig;
  hasEgressCredentialHooks: typeof hasEgressCredentialHooks;
  now: () => number;
  recordAuthorizationRequested: typeof recordAuthorizationRequested;
  startOAuthFlow: typeof startOAuthFlow;
  unlinkProvider: typeof unlinkProvider;
}

const defaultPluginAuthOrchestrationServices: PluginAuthOrchestrationServices =
  {
    formatProviderLabel,
    getPluginDefinition,
    getPluginProviders,
    getPluginOAuthConfig,
    hasEgressCredentialHooks,
    now: Date.now,
    recordAuthorizationRequested,
    startOAuthFlow,
    unlinkProvider,
  };

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
    /\bgithub_token\b.*\binvalid\b/,
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

function registeredProviderNames(
  services: PluginAuthOrchestrationServices,
): string[] {
  const providers = new Set<string>();
  for (const plugin of services.getPluginProviders()) {
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
  services: PluginAuthOrchestrationServices,
  provider: string,
  command: string,
  details: unknown,
): boolean {
  const normalizedCommand = command.trim().toLowerCase();
  if (!normalizedCommand) {
    return false;
  }

  const plugin = services.getPluginDefinition(provider);
  const candidates = new Set<string>([provider.toLowerCase()]);
  const manifest = plugin?.manifest;
  const credentials = manifest?.credentials;
  if (credentials) {
    if (credentials.authTokenEnv) {
      candidates.add(credentials.authTokenEnv.toLowerCase());
    }
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

function formatCommand(command: string): string {
  const collapsed = command.replace(/\s+/g, " ").trim();
  return collapsed.length > 160 ? `${collapsed.slice(0, 157)}...` : collapsed;
}

function authorizationId(args: {
  kind: "plugin";
  provider: string;
  sessionId: string;
}): string {
  return `${args.sessionId}:${args.kind}:${args.provider}`;
}

function buildCredentialFailureError(
  services: PluginAuthOrchestrationServices,
  provider: string,
  command: string,
): PluginCredentialFailureError {
  const providerLabel =
    provider === "github" ? "GitHub" : services.formatProviderLabel(provider);
  const commandSummary = formatCommand(command);

  return new PluginCredentialFailureError(
    provider,
    `${providerLabel} credentials were rejected while running \`${commandSummary}\`. Verify the ${providerLabel} provider credentials before retrying.`,
  );
}

/**
 * Start plugin OAuth from a sandbox egress auth signal and park the run.
 */
export function createPluginAuthOrchestration(
  deps: PluginAuthOrchestrationInput,
  abortAgent: () => void,
  services: PluginAuthOrchestrationServices = defaultPluginAuthOrchestrationServices,
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
    if (!deps.requesterId || !services.getPluginOAuthConfig(provider)) {
      throw new Error(`Cannot start plugin authorization for ${provider}`);
    }
    if (deps.authorizationFlowMode === "disabled") {
      throw new AuthorizationFlowDisabledError("plugin", provider);
    }
    const recordPendingAuth = deps.sessionId
      ? deps.recordPendingAuth
      : undefined;
    if (deps.sessionId && !recordPendingAuth) {
      throw new Error(
        `Missing pending auth recorder for plugin authorization pause "${provider}"`,
      );
    }

    const providerLabel = services.formatProviderLabel(provider);
    const reusingPendingLink = deps.sessionId
      ? canReusePendingAuthLink({
          pendingAuth: deps.pendingAuth,
          kind: "plugin",
          provider,
          requesterId: deps.requesterId,
          ...(options?.scope ? { scope: options.scope } : {}),
          sessionId: deps.sessionId,
        })
      : false;

    if (!reusingPendingLink) {
      const oauthResult = await services.startOAuthFlow(provider, {
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
      await services.unlinkProvider(
        deps.requesterId,
        provider,
        deps.userTokenStore,
      );
    }

    if (deps.sessionId && recordPendingAuth) {
      await recordPendingAuth({
        kind: "plugin",
        provider,
        requesterId: deps.requesterId,
        ...(options?.scope ? { scope: options.scope } : {}),
        sessionId: deps.sessionId,
        linkSentAtMs: reusingPendingLink
          ? deps.pendingAuth!.linkSentAtMs
          : services.now(),
      });
    }
    if (deps.conversationId && deps.sessionId && deps.requesterId) {
      await services.recordAuthorizationRequested({
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
      const providers = registeredProviderNames(services);
      const signal = pluginAuthRequiredSignal(details);
      if (!signal || !providers.includes(signal.provider)) {
        return;
      }
      const { provider } = signal;

      if (signal.kind === "unavailable") {
        throw new PluginCredentialFailureError(
          provider,
          signal.message ??
            `${services.formatProviderLabel(provider)} credentials are unavailable.`,
        );
      }

      const authorization = signal.authorization;

      if (!deps.requesterId || !deps.userTokenStore) {
        if (deps.authorizationFlowMode === "disabled") {
          throw new AuthorizationFlowDisabledError("plugin", provider);
        }
        throw new PluginCredentialFailureError(
          provider,
          signal.message ??
            `${services.formatProviderLabel(provider)} credentials are unavailable.`,
        );
      }

      if (authorization?.type !== "oauth") {
        throw new PluginCredentialFailureError(
          provider,
          signal.message ??
            `${services.formatProviderLabel(provider)} credentials are unavailable.`,
        );
      }
      if (!services.getPluginOAuthConfig(authorization.provider)) {
        throw new PluginCredentialFailureError(
          provider,
          signal.message ??
            `${services.formatProviderLabel(provider)} credentials are unavailable.`,
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
