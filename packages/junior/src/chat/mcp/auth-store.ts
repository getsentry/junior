import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { ThreadArtifactsState } from "@/chat/slack-actions/types";
import { getStateAdapter } from "@/chat/state";

const MCP_AUTH_SESSION_PREFIX = "junior:mcp_auth_session";
const MCP_AUTH_CREDENTIALS_PREFIX = "junior:mcp_auth_credentials";
const MCP_AUTH_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MCP_AUTH_CREDENTIALS_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface McpAuthSessionState {
  authSessionId: string;
  provider: string;
  userId: string;
  conversationId: string;
  sessionId: string;
  userMessage: string;
  channelId?: string;
  threadTs?: string;
  toolChannelId?: string;
  configuration?: Record<string, unknown>;
  artifactState?: ThreadArtifactsState;
  authorizationUrl?: string;
  codeVerifier?: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface McpStoredOAuthCredentials {
  clientInformation?: OAuthClientInformationMixed;
  discoveryState?: OAuthDiscoveryState;
  tokens?: OAuthTokens;
}

function sessionKey(authSessionId: string): string {
  return `${MCP_AUTH_SESSION_PREFIX}:${authSessionId}`;
}

function credentialsKey(userId: string, provider: string): string {
  return `${MCP_AUTH_CREDENTIALS_PREFIX}:${userId}:${provider}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseMcpAuthSession(value: unknown): McpAuthSessionState | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (!isRecord(parsed)) {
      return undefined;
    }

    if (
      typeof parsed.authSessionId !== "string" ||
      typeof parsed.provider !== "string" ||
      typeof parsed.userId !== "string" ||
      typeof parsed.conversationId !== "string" ||
      typeof parsed.sessionId !== "string" ||
      typeof parsed.userMessage !== "string" ||
      typeof parsed.createdAtMs !== "number" ||
      typeof parsed.updatedAtMs !== "number"
    ) {
      return undefined;
    }

    return {
      authSessionId: parsed.authSessionId,
      provider: parsed.provider,
      userId: parsed.userId,
      conversationId: parsed.conversationId,
      sessionId: parsed.sessionId,
      userMessage: parsed.userMessage,
      createdAtMs: parsed.createdAtMs,
      updatedAtMs: parsed.updatedAtMs,
      ...(typeof parsed.channelId === "string"
        ? { channelId: parsed.channelId }
        : {}),
      ...(typeof parsed.threadTs === "string"
        ? { threadTs: parsed.threadTs }
        : {}),
      ...(typeof parsed.toolChannelId === "string"
        ? { toolChannelId: parsed.toolChannelId }
        : {}),
      ...(isRecord(parsed.configuration)
        ? { configuration: parsed.configuration }
        : {}),
      ...(isRecord(parsed.artifactState)
        ? { artifactState: parsed.artifactState as ThreadArtifactsState }
        : {}),
      ...(typeof parsed.authorizationUrl === "string"
        ? { authorizationUrl: parsed.authorizationUrl }
        : {}),
      ...(typeof parsed.codeVerifier === "string"
        ? { codeVerifier: parsed.codeVerifier }
        : {}),
    };
  } catch {
    return undefined;
  }
}

function parseStoredCredentials(
  value: unknown,
): McpStoredOAuthCredentials | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (!isRecord(parsed)) {
      return undefined;
    }

    return {
      ...(isRecord(parsed.clientInformation)
        ? {
            clientInformation:
              parsed.clientInformation as OAuthClientInformationMixed,
          }
        : {}),
      ...(isRecord(parsed.discoveryState)
        ? {
            discoveryState:
              parsed.discoveryState as unknown as OAuthDiscoveryState,
          }
        : {}),
      ...(isRecord(parsed.tokens)
        ? { tokens: parsed.tokens as OAuthTokens }
        : {}),
    };
  } catch {
    return undefined;
  }
}

export async function getMcpAuthSession(
  authSessionId: string,
): Promise<McpAuthSessionState | undefined> {
  await getStateAdapter().connect();
  return parseMcpAuthSession(
    await getStateAdapter().get(sessionKey(authSessionId)),
  );
}

export async function putMcpAuthSession(
  session: McpAuthSessionState,
  ttlMs: number = MCP_AUTH_SESSION_TTL_MS,
): Promise<void> {
  await getStateAdapter().connect();
  await getStateAdapter().set(
    sessionKey(session.authSessionId),
    JSON.stringify(session),
    ttlMs,
  );
}

export async function patchMcpAuthSession(
  authSessionId: string,
  patch: Partial<McpAuthSessionState>,
): Promise<McpAuthSessionState> {
  const current = await getMcpAuthSession(authSessionId);
  if (!current) {
    throw new Error(`Unknown MCP auth session: ${authSessionId}`);
  }

  const next: McpAuthSessionState = {
    ...current,
    ...patch,
    authSessionId: current.authSessionId,
    provider: current.provider,
    userId: current.userId,
    conversationId: current.conversationId,
    sessionId: current.sessionId,
    userMessage: current.userMessage,
    createdAtMs: current.createdAtMs,
    updatedAtMs: Date.now(),
  };
  await putMcpAuthSession(next);
  return next;
}

export async function deleteMcpAuthSession(
  authSessionId: string,
): Promise<void> {
  await getStateAdapter().connect();
  await getStateAdapter().delete(sessionKey(authSessionId));
}

export async function getMcpStoredOAuthCredentials(
  userId: string,
  provider: string,
): Promise<McpStoredOAuthCredentials | undefined> {
  await getStateAdapter().connect();
  return parseStoredCredentials(
    await getStateAdapter().get(credentialsKey(userId, provider)),
  );
}

export async function putMcpStoredOAuthCredentials(
  userId: string,
  provider: string,
  value: McpStoredOAuthCredentials,
  ttlMs: number = MCP_AUTH_CREDENTIALS_TTL_MS,
): Promise<void> {
  await getStateAdapter().connect();
  await getStateAdapter().set(
    credentialsKey(userId, provider),
    JSON.stringify(value),
    ttlMs,
  );
}
