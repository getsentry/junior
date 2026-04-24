import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { createMcpOAuthClientProvider } from "@/chat/mcp/oauth";
import {
  deleteMcpAuthSession,
  getMcpAuthSession,
  patchMcpAuthSession,
} from "@/chat/mcp/auth-store";
import { deliverPrivateMessage, formatProviderLabel } from "@/chat/oauth-flow";
import { canReusePendingAuthLink } from "@/chat/services/pending-auth";
import { AuthorizationPauseError } from "@/chat/services/auth-pause";
import type { ThreadArtifactsState } from "@/chat/state/artifacts";
import type { ConversationPendingAuthState } from "@/chat/state/conversation";
import type { PluginDefinition } from "@/chat/plugins/types";

export class McpAuthorizationPauseError extends AuthorizationPauseError {
  constructor(
    provider: string,
    disposition: "link_already_sent" | "link_sent",
  ) {
    super("mcp", provider, disposition);
  }
}

export interface McpAuthOrchestrationDeps {
  conversationId?: string;
  sessionId?: string;
  requesterId?: string;
  channelId?: string;
  threadTs?: string;
  toolChannelId?: string;
  userMessage: string;
  currentPendingAuth?: ConversationPendingAuthState;
  getConfiguration: () => Record<string, unknown>;
  getArtifactState: () => ThreadArtifactsState | undefined;
  getMergedArtifactState: () => ThreadArtifactsState;
  onPendingAuth?: (
    pendingAuth: ConversationPendingAuthState,
  ) => void | Promise<void>;
}

export interface McpAuthOrchestration {
  authProviderFactory: (
    plugin: PluginDefinition,
  ) => Promise<OAuthClientProvider | undefined>;
  onAuthorizationRequired: (provider: string) => Promise<boolean>;
  getPendingPause: () => McpAuthorizationPauseError | undefined;
}

/** Create MCP authorization orchestration for a single turn. */
export function createMcpAuthOrchestration(
  deps: McpAuthOrchestrationDeps,
  abortAgent: () => void,
): McpAuthOrchestration {
  let pendingPause: McpAuthorizationPauseError | undefined;
  const authSessionIdsByProvider = new Map<string, string>();

  const authProviderFactory = async (
    plugin: PluginDefinition,
  ): Promise<OAuthClientProvider | undefined> => {
    if (!deps.conversationId || !deps.sessionId || !deps.requesterId) {
      return undefined;
    }

    const provider = await createMcpOAuthClientProvider({
      provider: plugin.manifest.name,
      conversationId: deps.conversationId,
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
    if (!authSessionId || !deps.requesterId) {
      throw new Error(
        `Missing MCP auth session context for plugin "${provider}"`,
      );
    }

    const latestArtifactState = deps.getMergedArtifactState();
    await patchMcpAuthSession(authSessionId, {
      configuration: { ...deps.getConfiguration() },
      artifactState: latestArtifactState,
      toolChannelId:
        deps.toolChannelId ??
        latestArtifactState.assistantContextChannelId ??
        deps.channelId,
    });

    const authSession = await getMcpAuthSession(authSessionId);
    if (!authSession?.authorizationUrl) {
      throw new Error(`Missing MCP authorization URL for plugin "${provider}"`);
    }

    const reusingPendingLink = canReusePendingAuthLink({
      pendingAuth: deps.currentPendingAuth,
      kind: "mcp",
      provider,
      requesterId: deps.requesterId,
    });

    if (!reusingPendingLink) {
      const delivery = await deliverPrivateMessage({
        channelId: authSession.channelId,
        threadTs: authSession.threadTs,
        userId: authSession.userId,
        text: `<${authSession.authorizationUrl}|Click here to link your ${formatProviderLabel(provider)} MCP access>. Once you've authorized, this thread will continue automatically.`,
      });
      if (!delivery) {
        throw new Error(
          `Unable to deliver MCP authorization link for plugin "${provider}"`,
        );
      }
    } else {
      await deleteMcpAuthSession(authSessionId);
    }

    // `sessionId`/`requesterId` are guaranteed here: `onAuthorizationRequired`
    // only fires for an MCP provider we actually created, and the provider
    // factory returns undefined unless both are set.
    if (deps.sessionId && deps.requesterId) {
      await deps.onPendingAuth?.({
        kind: "mcp",
        provider,
        requesterId: deps.requesterId,
        sessionId: deps.sessionId,
        linkSentAtMs: reusingPendingLink
          ? deps.currentPendingAuth!.linkSentAtMs
          : Date.now(),
      });
    }
    pendingPause = new McpAuthorizationPauseError(
      provider,
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
