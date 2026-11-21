import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";

import {
  destinationSchema,
  sourceSchema,
  type Destination,
  type Source,
} from "@sentry/junior-plugin-api";
import type { StateAdapter } from "chat";
import * as z from "zod";
import { findLegacyWebActorUserId } from "@/chat/conversations/legacy-web-actor-id";
import {
  createEncryptedState,
  readEncryptedState,
} from "@/chat/encryption/state";
import { getStateAdapter } from "@/chat/state/adapter";
import { mapBounded } from "@/chat/fan-out";

const MCP_AUTH_SESSION_PREFIX = "junior:mcp_oauth_attempt:v2";
const MCP_AUTH_CREDENTIALS_PREFIX = "junior:mcp_auth_credentials";
const MCP_AUTH_SESSION_INDEX_PREFIX = "junior:mcp_oauth_attempt_index:v2";
const MCP_SERVER_SESSION_PREFIX = "junior:mcp_server_session";
const MCP_AUTH_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MCP_AUTH_CREDENTIALS_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MCP_SERVER_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export interface McpAuthSessionState {
  schemaVersion: 2;
  authSessionId: string;
  provider: string;
  userId: string;
  conversationId: string;
  destination?: Destination;
  source?: Source;
  sessionId: string;
  userMessage: string;
  channelId?: string;
  threadTs?: string;
  toolChannelId?: string | undefined;
  configuration?: Record<string, unknown>;
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

export interface McpServerSessionState {
  sessionId: string;
  updatedAtMs: number;
}

function sessionKey(authSessionId: string): string {
  return `${MCP_AUTH_SESSION_PREFIX}:${authSessionId}`;
}

function credentialsKey(userId: string, provider: string): string {
  return `${MCP_AUTH_CREDENTIALS_PREFIX}:${userId}:${provider}`;
}

function sessionIndexKey(userId: string, provider: string): string {
  return `${MCP_AUTH_SESSION_INDEX_PREFIX}:${userId}:${provider}`;
}

function serverSessionKey(userId: string, provider: string): string {
  return `${MCP_SERVER_SESSION_PREFIX}:${userId}:${provider}`;
}

function parseSessionIndex(value: unknown): string[] {
  if (typeof value !== "string") {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return [
      ...new Set(parsed.filter((id): id is string => typeof id === "string")),
    ];
  } catch {
    return [];
  }
}

const optionalStoredString = z.string().optional().catch(undefined);

const mcpAuthSessionSchema = z.object({
  schemaVersion: z.literal(2),
  authSessionId: z.string(),
  provider: z.string(),
  userId: z.string(),
  conversationId: z.string(),
  destination: destinationSchema.optional(),
  source: sourceSchema.optional(),
  sessionId: z.string(),
  userMessage: z.string(),
  channelId: optionalStoredString,
  threadTs: optionalStoredString,
  toolChannelId: optionalStoredString,
  configuration: z.record(z.string(), z.unknown()).optional().catch(undefined),
  authorizationUrl: optionalStoredString,
  codeVerifier: optionalStoredString,
  createdAtMs: z.number(),
  updatedAtMs: z.number(),
});

function parseMcpAuthSession(value: unknown): McpAuthSessionState | undefined {
  const parsed = mcpAuthSessionSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

const serverSessionSchema = z.object({
  sessionId: z.string(),
  updatedAtMs: z.number(),
});

function parseServerSession(value: unknown): McpServerSessionState | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  try {
    const parsed = serverSessionSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

// OAuth payloads are stored as the MCP SDK returned them. Only their object
// shape is checked here.
const storedOAuthClientInformationSchema =
  z.custom<OAuthClientInformationMixed>(
    (value) => typeof value === "object" && value !== null,
  );
const storedOAuthDiscoveryStateSchema = z.custom<OAuthDiscoveryState>(
  (value) => typeof value === "object" && value !== null,
);
const storedOAuthTokensSchema = z.custom<OAuthTokens>(
  (value) => typeof value === "object" && value !== null,
);

const storedCredentialsSchema = z.object({
  clientInformation: storedOAuthClientInformationSchema
    .optional()
    .catch(undefined),
  discoveryState: storedOAuthDiscoveryStateSchema.optional().catch(undefined),
  tokens: storedOAuthTokensSchema.optional().catch(undefined),
});

function parseStoredCredentials(
  value: unknown,
): McpStoredOAuthCredentials | undefined {
  try {
    // Plaintext values from before encryption are JSON strings.
    const parsed = storedCredentialsSchema.safeParse(
      typeof value === "string" ? JSON.parse(value) : value,
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

// Attempts hold the PKCE code verifier and the user's message, so they are
// encrypted. The attempt index holds only ids and stays plain.
async function readMcpAuthSession(
  stateAdapter: StateAdapter,
  authSessionId: string,
): Promise<unknown> {
  const stored = await readEncryptedState(
    stateAdapter,
    sessionKey(authSessionId),
  );
  // TODO(dcramer): Delete one attempt TTL after deploy. Attempts saved before
  // encryption are JSON strings; the next write encrypts them.
  if (stored?.stale && typeof stored.value === "string") {
    try {
      return JSON.parse(stored.value);
    } catch {
      return undefined;
    }
  }
  return stored?.value;
}

async function getConnectedStateAdapter() {
  const stateAdapter = getStateAdapter();
  await stateAdapter.connect();
  return stateAdapter;
}

export async function getMcpAuthSession(
  authSessionId: string,
): Promise<McpAuthSessionState | undefined> {
  const stateAdapter = await getConnectedStateAdapter();
  return parseMcpAuthSession(
    await readMcpAuthSession(stateAdapter, authSessionId),
  );
}

export async function putMcpAuthSession(
  session: McpAuthSessionState,
  ttlMs: number = MCP_AUTH_SESSION_TTL_MS,
): Promise<void> {
  const stateAdapter = await getConnectedStateAdapter();
  await createEncryptedState(stateAdapter).set(
    sessionKey(session.authSessionId),
    session,
    ttlMs,
  );
  const nextIndex = parseSessionIndex(
    await stateAdapter.get(sessionIndexKey(session.userId, session.provider)),
  );
  if (!nextIndex.includes(session.authSessionId)) {
    nextIndex.push(session.authSessionId);
  }
  await stateAdapter.set(
    sessionIndexKey(session.userId, session.provider),
    JSON.stringify(nextIndex),
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
    schemaVersion: 2,
    authSessionId: current.authSessionId,
    provider: current.provider,
    userId: current.userId,
    conversationId: current.conversationId,
    ...(current.destination ? { destination: current.destination } : undefined),
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
  const stateAdapter = await getConnectedStateAdapter();
  const current = parseMcpAuthSession(
    await readMcpAuthSession(stateAdapter, authSessionId),
  );
  await stateAdapter.delete(sessionKey(authSessionId));
  if (!current) {
    return;
  }

  const nextIndex = parseSessionIndex(
    await stateAdapter.get(sessionIndexKey(current.userId, current.provider)),
  ).filter((id) => id !== authSessionId);

  if (nextIndex.length > 0) {
    await stateAdapter.set(
      sessionIndexKey(current.userId, current.provider),
      JSON.stringify(nextIndex),
      MCP_AUTH_SESSION_TTL_MS,
    );
    return;
  }

  await stateAdapter.delete(sessionIndexKey(current.userId, current.provider));
}

export async function deleteMcpAuthSessionsForUserProvider(
  userId: string,
  provider: string,
): Promise<void> {
  const stateAdapter = await getConnectedStateAdapter();
  const indexKey = sessionIndexKey(userId, provider);
  const authSessionIds = parseSessionIndex(await stateAdapter.get(indexKey));

  await mapBounded(authSessionIds, (authSessionId) =>
    stateAdapter.delete(sessionKey(authSessionId)),
  );

  await stateAdapter.delete(indexKey);
}

export async function getLatestMcpAuthSessionForUserProvider(
  userId: string,
  provider: string,
): Promise<McpAuthSessionState | undefined> {
  const stateAdapter = await getConnectedStateAdapter();
  const authSessionIds = parseSessionIndex(
    await stateAdapter.get(sessionIndexKey(userId, provider)),
  );

  const sessions = await mapBounded(authSessionIds, async (authSessionId) =>
    parseMcpAuthSession(await readMcpAuthSession(stateAdapter, authSessionId)),
  );
  let latestSession: McpAuthSessionState | undefined;
  for (const session of sessions) {
    if (!session) {
      continue;
    }
    if (!latestSession || session.updatedAtMs > latestSession.updatedAtMs) {
      latestSession = session;
    }
  }

  return latestSession;
}

export async function getMcpStoredOAuthCredentials(
  userId: string,
  provider: string,
): Promise<McpStoredOAuthCredentials | undefined> {
  const stateAdapter = await getConnectedStateAdapter();
  // Stale values expire within the credential TTL or move to the active key
  // on the next save, so they are not saved again here.
  const stored = parseStoredCredentials(
    (await readEncryptedState(stateAdapter, credentialsKey(userId, provider)))
      ?.value,
  );
  if (stored) return stored;
  // TODO(dcramer): Delete after no legacy `dashboard:` MCP credential keys
  // remain. Web Actors saved them before they used the User id, so move them.
  const legacyUserId = await findLegacyWebActorUserId(userId);
  if (!legacyUserId) return undefined;
  const legacyKey = credentialsKey(legacyUserId, provider);
  const legacy = parseStoredCredentials(
    (await readEncryptedState(stateAdapter, legacyKey))?.value,
  );
  if (!legacy) return undefined;
  await putMcpStoredOAuthCredentials(userId, provider, legacy);
  await stateAdapter.delete(legacyKey);
  return legacy;
}

export async function putMcpStoredOAuthCredentials(
  userId: string,
  provider: string,
  value: McpStoredOAuthCredentials,
  ttlMs: number = MCP_AUTH_CREDENTIALS_TTL_MS,
): Promise<void> {
  const stateAdapter = await getConnectedStateAdapter();
  await createEncryptedState(stateAdapter).set(
    credentialsKey(userId, provider),
    value,
    ttlMs,
  );
}

export async function deleteMcpStoredOAuthCredentials(
  userId: string,
  provider: string,
): Promise<void> {
  const stateAdapter = await getConnectedStateAdapter();
  await stateAdapter.delete(credentialsKey(userId, provider));
  // TODO(dcramer): Delete with the legacy read above. A read moves legacy
  // credentials only when the User id has none, so delete both keys.
  const legacyUserId = await findLegacyWebActorUserId(userId);
  if (legacyUserId) {
    await stateAdapter.delete(credentialsKey(legacyUserId, provider));
  }
}

export async function getMcpServerSessionId(
  userId: string,
  provider: string,
): Promise<string | undefined> {
  const stateAdapter = await getConnectedStateAdapter();
  return parseServerSession(
    await stateAdapter.get(serverSessionKey(userId, provider)),
  )?.sessionId;
}

export async function putMcpServerSessionId(
  userId: string,
  provider: string,
  sessionId: string,
  ttlMs: number = MCP_SERVER_SESSION_TTL_MS,
): Promise<void> {
  const stateAdapter = await getConnectedStateAdapter();
  await stateAdapter.set(
    serverSessionKey(userId, provider),
    JSON.stringify({
      sessionId,
      updatedAtMs: Date.now(),
    } satisfies McpServerSessionState),
    ttlMs,
  );
}

export async function deleteMcpServerSessionId(
  userId: string,
  provider: string,
): Promise<void> {
  const stateAdapter = await getConnectedStateAdapter();
  await stateAdapter.delete(serverSessionKey(userId, provider));
}
