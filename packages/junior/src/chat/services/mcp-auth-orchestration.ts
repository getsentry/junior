/**
 * MCP authorization pause orchestration.
 *
 * This module turns an MCP client auth challenge into Junior's paused-run
 * model: create provider auth state, deliver or reuse a private Slack link,
 * record pending auth, and abort the agent so the OAuth callback can resume the
 * same session.
 */
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Destination, Source } from "@sentry/junior-plugin-api";
import { createMcpOAuthClientProvider } from "@/chat/mcp/oauth";
import {
  deleteMcpAuthSession,
  getMcpAuthSession,
  patchMcpAuthSession,
} from "@/chat/mcp/auth-store";
import { formatOAuthAuthorizationMessage } from "@/chat/oauth-authorization-message";
import { deliverPrivateMessage, formatProviderLabel } from "@/chat/oauth-flow";
import {
  abandonReplacedPendingAuth,
  canReusePendingAuthLink,
} from "@/chat/services/pending-auth";
import {
  AuthorizationFlowDisabledError,
  AuthorizationPauseError,
  type AuthorizationFlowMode,
} from "@/chat/services/auth-pause";
import type { ThreadArtifactsState } from "@/chat/state/artifacts";
import type { ConversationPendingAuthState } from "@/chat/state/conversation";
import { recordAuthorizationRequested } from "@/chat/conversations/projection";
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
  abortAgent: () => void;
  conversationId?: string;
  sessionId?: string;
  actorId?: string;
  channelId?: string;
  destination?: Destination;
  source?: Source;
  threadTs?: string;
  toolChannelId?: string;
  userMessage: string;
  pendingAuth?: ConversationPendingAuthState;
  getConfiguration: () => Record<string, unknown>;
  getArtifactState: () => ThreadArtifactsState | undefined;
  getMergedArtifactState: () => ThreadArtifactsState;
  recordPendingAuth?: (
    pendingAuth: ConversationPendingAuthState | undefined,
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

function authorizationId(args: {
  kind: "mcp";
  provider: string;
  sessionId: string;
}): string {
  return `${args.sessionId}:${args.kind}:${args.provider}`;
}

/** Create MCP authorization orchestration for a single agent run. */
export function createMcpAuthOrchestration(
  input: McpAuthOrchestrationInput,
): McpAuthOrchestration {
  let pendingPause: McpAuthorizationPauseError | undefined;
  const authSessionIdsByProvider = new Map<string, string>();

  const authProviderFactory = async (
    plugin: PluginDefinition,
  ): Promise<OAuthClientProvider | undefined> => {
    if (!input.conversationId || !input.sessionId || !input.actorId) {
      return undefined;
    }
    if (
      !input.recordPendingAuth &&
      input.authorizationFlowMode !== "disabled"
    ) {
      throw new Error(
        `Missing pending auth recorder for MCP authorization pause "${plugin.manifest.name}"`,
      );
    }

    const provider = await createMcpOAuthClientProvider({
      provider: plugin.manifest.name,
      conversationId: input.conversationId,
      destination: input.destination,
      source: input.source,
      sessionId: input.sessionId,
      userId: input.actorId,
      userMessage: input.userMessage,
      ...(input.channelId ? { channelId: input.channelId } : {}),
      ...(input.threadTs ? { threadTs: input.threadTs } : {}),
      ...(input.toolChannelId ? { toolChannelId: input.toolChannelId } : {}),
      configuration: input.getConfiguration(),
      artifactState: input.getArtifactState(),
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
    const conversationId = input.conversationId;
    const sessionId = input.sessionId;
    const actorId = input.actorId;
    if (!authSessionId || !conversationId || !sessionId || !actorId) {
      throw new Error(
        `Missing MCP auth session context for plugin "${provider}"`,
      );
    }
    if (input.authorizationFlowMode === "disabled") {
      await deleteMcpAuthSession(authSessionId);
      throw new AuthorizationFlowDisabledError("mcp", provider);
    }
    const recordPendingAuth = input.recordPendingAuth;
    if (!recordPendingAuth) {
      throw new Error(
        `Missing pending auth recorder for MCP authorization pause "${provider}"`,
      );
    }

    const reusingPendingLink = canReusePendingAuthLink({
      pendingAuth: input.pendingAuth,
      kind: "mcp",
      provider,
      actorId,
      sessionId,
    });
    const reusedAuthSessionId =
      reusingPendingLink && input.pendingAuth?.kind === "mcp"
        ? input.pendingAuth.authSessionId
        : undefined;
    const activeAuthSessionId = reusedAuthSessionId ?? authSessionId;
    const latestArtifactState = input.getMergedArtifactState();
    await patchMcpAuthSession(activeAuthSessionId, {
      configuration: { ...input.getConfiguration() },
      artifactState: latestArtifactState,
      toolChannelId:
        input.toolChannelId ??
        latestArtifactState.assistantContextChannelId ??
        input.channelId,
    });

    const providerLabel = formatProviderLabel(provider);

    const nextPendingAuth: ConversationPendingAuthState = {
      authSessionId: activeAuthSessionId,
      kind: "mcp",
      provider,
      actorId,
      sessionId,
      linkSentAtMs: reusingPendingLink
        ? input.pendingAuth!.linkSentAtMs
        : Date.now(),
    };

    if (!reusingPendingLink) {
      const authSession = await getMcpAuthSession(authSessionId);
      if (!authSession?.authorizationUrl) {
        throw new Error(
          `Missing MCP authorization URL for plugin "${provider}"`,
        );
      }
      await recordPendingAuth(nextPendingAuth);
      const delivery = await deliverPrivateMessage({
        channelId: authSession.channelId,
        threadTs: authSession.threadTs,
        userId: authSession.userId,
        text: formatOAuthAuthorizationMessage({
          authorizationUrl: authSession.authorizationUrl,
          label: `Click here to link your ${providerLabel} MCP access`,
          completionText:
            "Once you've authorized, this thread will continue automatically.",
        }),
      });
      if (!delivery) {
        await deleteMcpAuthSession(authSessionId);
        await recordPendingAuth(input.pendingAuth);
        throw new Error(
          `Unable to deliver MCP authorization link for plugin "${provider}"`,
        );
      }
      await abandonReplacedPendingAuth({
        conversationId,
        previousPendingAuth: input.pendingAuth,
        nextPendingAuth,
      });
    } else {
      await deleteMcpAuthSession(authSessionId);
      await recordPendingAuth(nextPendingAuth);
    }
    await recordAuthorizationRequested({
      conversationId,
      kind: "mcp",
      provider,
      actorId,
      authorizationId: authorizationId({
        kind: "mcp",
        provider,
        sessionId,
      }),
      delivery: reusingPendingLink
        ? "private_link_reused"
        : "private_link_sent",
    });
    pendingPause = new McpAuthorizationPauseError(
      provider,
      providerLabel,
      reusingPendingLink ? "link_already_sent" : "link_sent",
    );
    input.abortAgent();
    return true;
  };

  return {
    authProviderFactory,
    onAuthorizationRequired,
    getPendingPause: () => pendingPause,
  };
}
