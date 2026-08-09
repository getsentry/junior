/**
 * Plugin authorization pause orchestration.
 *
 * This module detects plugin credential failures from the sandbox egress layer
 * and maps them onto the same paused-run contract used by MCP auth. It owns
 * provider attribution, private-link delivery/reuse, event-log recording,
 * and credential cleanup.
 *
 * Auth failures are detected exclusively through the structured `auth_required`
 * signal emitted by the egress proxy — never inferred from bash command text,
 * stdout patterns, or exit codes.
 */
import type { Actor, Destination, Source } from "@sentry/junior-plugin-api";
import type { UserTokenStore } from "@/chat/credentials/user-token-store";
import { formatProviderLabel, startOAuthFlow } from "@/chat/oauth-flow";
import {
  abandonReplacedPendingAuth,
  canReusePendingAuthLink,
} from "@/chat/services/pending-auth";
import {
  AuthorizationFlowDisabledError,
  AuthorizationPauseError,
} from "@/chat/services/auth-pause";
import type { ConversationPendingAuthState } from "@/chat/state/conversation";
import { recordAuthorizationRequested } from "@/chat/conversations/projection";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
import { parseSandboxEgressAuthRequiredSignal } from "@/chat/sandbox/egress/schemas";
import {
  authorizationId,
  type OAuthAuthorization,
} from "@/chat/oauth-authorization";

export class PluginAuthorizationPauseError extends AuthorizationPauseError {
  constructor(
    provider: string,
    providerDisplayName: string,
    disposition: "link_already_sent" | "link_sent",
    requestText?: string,
  ) {
    super("plugin", provider, providerDisplayName, disposition, requestText);
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
  actorId?: string;
  actor?: Actor;
  channelId?: string;
  destination?: Destination;
  source?: Source;
  threadTs?: string;
  userMessage?: string;
  pendingAuth?: ConversationPendingAuthState;
  recordPendingAuth?: (
    pendingAuth: ConversationPendingAuthState,
  ) => void | Promise<void>;
  /** When false, required auth hard-fails instead of pausing for an OAuth link. */
  interactiveAuthEnabled?: boolean;
  userTokenStore?: UserTokenStore;
  authorization?: OAuthAuthorization;
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
    },
  ): Promise<never> => {
    if (pendingPause) {
      throw pendingPause;
    }
    if (!input.actorId || !pluginCatalogRuntime.getOAuthConfig(provider)) {
      throw new Error(`Cannot start plugin authorization for ${provider}`);
    }
    if (input.interactiveAuthEnabled === false) {
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
          actorId: input.actorId,
          sessionId: input.sessionId,
          ...(options?.scope ? { scope: options.scope } : {}),
        })
      : false;

    if (!reusingPendingLink) {
      const oauthResult = await startOAuthFlow(provider, {
        actorId: input.actorId,
        ...(input.actor ? { actor: input.actor } : {}),
        channelId: input.channelId,
        destination: input.destination,
        source: input.source,
        threadTs: input.threadTs,
        ...(options?.scope ? { scope: options.scope } : {}),
        resumeConversationId: input.conversationId,
        resumeSessionId: input.sessionId,
        authorization: input.authorization,
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

    if (input.sessionId && recordPendingAuth) {
      const nextPendingAuth: ConversationPendingAuthState = {
        kind: "plugin",
        provider,
        actorId: input.actorId,
        ...(options?.scope ? { scope: options.scope } : {}),
        sessionId: input.sessionId,
        linkSentAtMs: reusingPendingLink
          ? input.pendingAuth!.linkSentAtMs
          : Date.now(),
      };
      await recordPendingAuth(nextPendingAuth);
      await abandonReplacedPendingAuth({
        conversationId: input.conversationId,
        previousPendingAuth: input.pendingAuth,
        nextPendingAuth,
      });
    }
    if (input.conversationId && input.sessionId) {
      await recordAuthorizationRequested({
        conversationId: input.conversationId,
        kind: "plugin",
        provider,
        actorId: input.actorId,
        authorizationId: authorizationId({
          kind: "plugin",
          provider,
          sessionId: input.sessionId,
        }),
        delivery: reusingPendingLink
          ? "private_link_reused"
          : "private_link_sent",
      });
    }
    pendingPause = new PluginAuthorizationPauseError(
      provider,
      providerLabel,
      reusingPendingLink ? "link_already_sent" : "link_sent",
      input.userMessage,
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

      if (!input.actorId || !input.userTokenStore) {
        if (input.interactiveAuthEnabled === false) {
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

      // Do not unlink here. This signal can represent either missing credentials
      // before lease issuance or an upstream 401 after credential injection. In
      // the latter case the token may be valid and the 401 caused by a
      // scope/org/permission mismatch unrelated to the stored credential.
      // OAuth completion overwrites the stored token via userTokenStore.set(),
      // so proactive deletion is unnecessary and destroys a working connection.
      await startAuthorizationPause(
        authorization.provider,
        authorization.scope ? { scope: authorization.scope } : undefined,
      );
    },
    getPendingPause: () => pendingPause,
  };
}
