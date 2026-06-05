/**
 * MCP authorization pause orchestration.
 *
 * This module turns an MCP client auth challenge into Junior's paused-run
 * model: create provider auth state, deliver or reuse a private Slack link,
 * record pending auth, and abort the agent so the OAuth callback can resume the
 * same session.
 */
import { THREAD_STATE_TTL_MS } from "chat";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Destination } from "@sentry/junior-plugin-api";
import { createMcpOAuthClientProvider } from "@/chat/mcp/oauth";
import {
  deleteMcpAuthSession,
  getMcpAuthSession,
  patchMcpAuthSession,
} from "@/chat/mcp/auth-store";
import { deliverPrivateMessage, formatProviderLabel } from "@/chat/oauth-flow";
import { canReusePendingAuthLink } from "@/chat/services/pending-auth";
import {
  AuthorizationFlowDisabledError,
  AuthorizationPauseError,
  type AuthorizationFlowMode,
} from "@/chat/services/auth-pause";
import type { ThreadArtifactsState } from "@/chat/state/artifacts";
import type { ConversationPendingAuthState } from "@/chat/state/conversation";
import { recordAuthorizationRequested } from "@/chat/state/session-log";
import type { PluginDefinition } from "@/chat/plugins/types";

export class McpAuthorizationPauseError extends AuthorizationPauseError {
  constructor(
    provider: string,
    providerDisplayName: string,
    disposition: "link_already_sent" | "link_sent",
  ) {
    super("mcp", provider, providerDisplayName, disposition);
  }
}

export interface McpAuthOrchestrationInput {
  conversationId?: string;
  sessionId?: string;
  requesterId?: string;
  channelId?: string;
  destination?: Destination;
  threadTs?: string;
  toolChannelId?: string;
  userMessage: string;
  pendingAuth?: ConversationPendingAuthState;
  getConfiguration: () => Record<string, unknown>;
  getArtifactState: () => ThreadArtifactsState | undefined;
  getMergedArtifactState: () => ThreadArtifactsState;
  recordPendingAuth?: (
    pendingAuth: ConversationPendingAuthState,
  ) => void | Promise<void>;
  authorizationFlowMode?: AuthorizationFlowMode;
}

export interface McpAuthOrchestration {
  authProviderFactory: (
    plugin: PluginDefinition,
  ) => Promise<OAuthClientProvider | undefined>;
  onAuthorizationRequired: (provider: string) => Promise<boolean>;
  getPendingPause: () => McpAuthorizationPauseError | undefined;
}

type McpOAuthClientProviderFactoryInput = Parameters<
  typeof createMcpOAuthClientProvider
>[0];

type McpAuthProvider = OAuthClientProvider & {
  readonly authSessionId: string;
};

interface McpAuthOrchestrationServices {
  createMcpOAuthClientProvider: (
    input: McpOAuthClientProviderFactoryInput,
  ) => Promise<McpAuthProvider>;
  deleteMcpAuthSession: typeof deleteMcpAuthSession;
  deliverPrivateMessage: typeof deliverPrivateMessage;
  formatProviderLabel: typeof formatProviderLabel;
  getMcpAuthSession: typeof getMcpAuthSession;
  now: () => number;
  patchMcpAuthSession: typeof patchMcpAuthSession;
  recordAuthorizationRequested: typeof recordAuthorizationRequested;
}

const defaultMcpAuthOrchestrationServices: McpAuthOrchestrationServices = {
  createMcpOAuthClientProvider,
  deleteMcpAuthSession,
  deliverPrivateMessage,
  formatProviderLabel,
  getMcpAuthSession,
  now: Date.now,
  patchMcpAuthSession,
  recordAuthorizationRequested,
};

function authorizationId(args: {
  kind: "mcp";
  provider: string;
  sessionId: string;
}): string {
  return `${args.sessionId}:${args.kind}:${args.provider}`;
}

/** Create MCP authorization orchestration for a single agent run. */
export function createMcpAuthOrchestration(
  deps: McpAuthOrchestrationInput,
  abortAgent: () => void,
  services: McpAuthOrchestrationServices = defaultMcpAuthOrchestrationServices,
): McpAuthOrchestration {
  let pendingPause: McpAuthorizationPauseError | undefined;
  const authSessionIdsByProvider = new Map<string, string>();

  const authProviderFactory = async (
    plugin: PluginDefinition,
  ): Promise<OAuthClientProvider | undefined> => {
    if (!deps.conversationId || !deps.sessionId || !deps.requesterId) {
      return undefined;
    }
    if (
      !deps.recordPendingAuth &&
      deps.authorizationFlowMode !== "disabled"
    ) {
      throw new Error(
        `Missing pending auth recorder for MCP authorization pause "${plugin.manifest.name}"`,
      );
    }

    const provider = await services.createMcpOAuthClientProvider({
      provider: plugin.manifest.name,
      conversationId: deps.conversationId,
      destination: deps.destination,
      sessionId: deps.sessionId,
      userId: deps.requesterId,
      userMessage: deps.userMessage,
      ...(deps.channelId ? { channelId: deps.channelId } : {}),
      ...(deps.threadTs ? { threadTs: deps.threadTs } : {}),
      ...(deps.toolChannelId ? { toolChannelId: deps.toolChannelId } : {}),
      configuration: deps.getConfiguration(),
      artifactState: deps.getArtifactState(),
    });
    authSessionIdsByProvider.set(plugin.manifest.name, provider.authSessionId);
    return provider;
  };

  const onAuthorizationRequired = async (
    provider: string,
  ): Promise<boolean> => {
    if (pendingPause) {
      return true;
    }

    const authSessionId = authSessionIdsByProvider.get(provider);
    const conversationId = deps.conversationId;
    const sessionId = deps.sessionId;
    const requesterId = deps.requesterId;
    if (!authSessionId || !conversationId || !sessionId || !requesterId) {
      throw new Error(
        `Missing MCP auth session context for plugin "${provider}"`,
      );
    }
    if (deps.authorizationFlowMode === "disabled") {
      await services.deleteMcpAuthSession(authSessionId);
      throw new AuthorizationFlowDisabledError("mcp", provider);
    }
    const recordPendingAuth = deps.recordPendingAuth;
    if (!recordPendingAuth) {
      throw new Error(
        `Missing pending auth recorder for MCP authorization pause "${provider}"`,
      );
    }

    const latestArtifactState = deps.getMergedArtifactState();
    await services.patchMcpAuthSession(authSessionId, {
      configuration: { ...deps.getConfiguration() },
      artifactState: latestArtifactState,
      toolChannelId:
        deps.toolChannelId ??
        latestArtifactState.assistantContextChannelId ??
        deps.channelId,
    });

    const authSession = await services.getMcpAuthSession(authSessionId);
    if (!authSession?.authorizationUrl) {
      throw new Error(`Missing MCP authorization URL for plugin "${provider}"`);
    }

    const reusingPendingLink = canReusePendingAuthLink({
      pendingAuth: deps.pendingAuth,
      kind: "mcp",
      nowMs: services.now(),
      provider,
      requesterId,
      sessionId,
    });
    const providerLabel = services.formatProviderLabel(provider);

    if (!reusingPendingLink) {
      const delivery = await services.deliverPrivateMessage({
        channelId: authSession.channelId,
        threadTs: authSession.threadTs,
        userId: authSession.userId,
        text: `<${authSession.authorizationUrl}|Click here to link your ${services.formatProviderLabel(provider)} MCP access>. Once you've authorized, this thread will continue automatically.`,
      });
      if (!delivery) {
        throw new Error(
          `Unable to deliver MCP authorization link for plugin "${provider}"`,
        );
      }
    } else {
      await services.deleteMcpAuthSession(authSessionId);
    }

    await recordPendingAuth({
      kind: "mcp",
      provider,
      requesterId,
      sessionId,
      linkSentAtMs: reusingPendingLink
        ? deps.pendingAuth!.linkSentAtMs
        : services.now(),
    });
    await services.recordAuthorizationRequested({
      conversationId,
      kind: "mcp",
      provider,
      requesterId,
      authorizationId: authorizationId({
        kind: "mcp",
        provider,
        sessionId,
      }),
      delivery: reusingPendingLink ? "private_link_reused" : "private_link_sent",
      ttlMs: THREAD_STATE_TTL_MS,
    });
    pendingPause = new McpAuthorizationPauseError(
      provider,
      providerLabel,
      reusingPendingLink ? "link_already_sent" : "link_sent",
    );
    abortAgent();
    return true;
  };

  return {
    authProviderFactory,
    onAuthorizationRequired,
    getPendingPause: () => pendingPause,
  };
}
