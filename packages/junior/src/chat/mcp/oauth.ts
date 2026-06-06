import { randomUUID } from "node:crypto";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { resolveBaseUrl } from "@/chat/oauth-flow";
import { getPluginDefinition } from "@/chat/plugins/registry";
import type { PluginDefinition } from "@/chat/plugins/types";
import type { ThreadArtifactsState } from "@/chat/state/artifacts";
import {
  getLatestMcpAuthSessionForUserProvider,
  getMcpAuthSession,
  putMcpAuthSession,
  type McpAuthSessionState,
} from "./auth-store";
import { StateBackedMcpOAuthClientProvider } from "./oauth-provider";

export function getMcpOAuthCallbackPath(provider: string): string {
  return `/api/oauth/callback/mcp/${provider}`;
}

function requirePluginWithMcp(provider: string): PluginDefinition {
  const plugin = getPluginDefinition(provider);
  if (!plugin?.manifest.mcp) {
    throw new Error(`Plugin "${provider}" does not support MCP`);
  }
  return plugin;
}

export async function createMcpOAuthClientProvider(input: {
  provider: string;
  conversationId: string;
  sessionId: string;
  userId: string;
  userMessage: string;
  channelId?: string;
  threadTs?: string;
  toolChannelId?: string;
  configuration?: Record<string, unknown>;
  artifactState?: ThreadArtifactsState;
}): Promise<StateBackedMcpOAuthClientProvider> {
  requirePluginWithMcp(input.provider);

  const baseUrl = resolveBaseUrl();
  if (!baseUrl) {
    throw new Error(
      "Cannot determine base URL (set JUNIOR_BASE_URL or deploy to Vercel)",
    );
  }

  const existingSession = await getLatestMcpAuthSessionForUserProvider(
    input.userId,
    input.provider,
  );
  const reusableSession =
    existingSession &&
    existingSession.conversationId === input.conversationId &&
    existingSession.sessionId === input.sessionId
      ? existingSession
      : undefined;
  const now = Date.now();
  const authSessionId = reusableSession?.authSessionId ?? randomUUID();

  await putMcpAuthSession({
    authSessionId,
    provider: input.provider,
    userId: input.userId,
    conversationId: input.conversationId,
    sessionId: input.sessionId,
    userMessage: input.userMessage,
    ...(input.channelId ? { channelId: input.channelId } : {}),
    ...(input.threadTs ? { threadTs: input.threadTs } : {}),
    ...(input.toolChannelId ? { toolChannelId: input.toolChannelId } : {}),
    ...(input.configuration ? { configuration: input.configuration } : {}),
    ...(input.artifactState ? { artifactState: input.artifactState } : {}),
    ...(reusableSession?.authorizationUrl
      ? { authorizationUrl: reusableSession.authorizationUrl }
      : {}),
    ...(reusableSession?.codeVerifier
      ? { codeVerifier: reusableSession.codeVerifier }
      : {}),
    createdAtMs: reusableSession?.createdAtMs ?? now,
    updatedAtMs: now,
  });

  return new StateBackedMcpOAuthClientProvider(
    authSessionId,
    `${baseUrl}${getMcpOAuthCallbackPath(input.provider)}`,
    {
      provider: input.provider,
      userId: input.userId,
      conversationId: input.conversationId,
      sessionId: input.sessionId,
      userMessage: input.userMessage,
      ...(input.channelId ? { channelId: input.channelId } : {}),
      ...(input.threadTs ? { threadTs: input.threadTs } : {}),
      ...(input.toolChannelId ? { toolChannelId: input.toolChannelId } : {}),
      ...(input.configuration ? { configuration: input.configuration } : {}),
      ...(input.artifactState ? { artifactState: input.artifactState } : {}),
    },
  );
}

export async function finalizeMcpAuthorization(
  provider: string,
  authSessionId: string,
  authorizationCode: string,
): Promise<McpAuthSessionState> {
  const plugin = requirePluginWithMcp(provider);
  const mcp = plugin.manifest.mcp;
  if (!mcp) {
    throw new Error(`Plugin "${provider}" does not support MCP`);
  }
  const session = await getMcpAuthSession(authSessionId);
  if (!session) {
    throw new Error(`Unknown MCP auth session: ${authSessionId}`);
  }
  if (session.provider !== provider) {
    throw new Error(
      `MCP auth session provider mismatch: expected "${provider}", got "${session.provider}"`,
    );
  }

  const baseUrl = resolveBaseUrl();
  if (!baseUrl) {
    throw new Error(
      "Cannot determine base URL (set JUNIOR_BASE_URL or deploy to Vercel)",
    );
  }

  const callbackUrl = `${baseUrl}${getMcpOAuthCallbackPath(provider)}`;
  const authProvider = new StateBackedMcpOAuthClientProvider(
    authSessionId,
    callbackUrl,
  );
  const requestInit: RequestInit = {};
  if (mcp.headers && Object.keys(mcp.headers).length > 0) {
    requestInit.headers = new Headers(mcp.headers);
  }
  const transport = new StreamableHTTPClientTransport(new URL(mcp.url), {
    ...(Object.keys(requestInit).length > 0 ? { requestInit } : {}),
    authProvider,
  });

  try {
    await transport.finishAuth(authorizationCode);
  } finally {
    await transport.close();
  }

  const nextSession = await getMcpAuthSession(authSessionId);
  if (!nextSession) {
    throw new Error(`Unknown MCP auth session: ${authSessionId}`);
  }

  return nextSession;
}
