import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";

import {
  sourceSchema,
  type Destination,
  type Source,
} from "@sentry/junior-plugin-api";
import type { StateAdapter } from "chat";
import { findLegacyWebActorUserId } from "@/chat/conversations/legacy-web-actor-id";
import { parseDestination } from "@/chat/destination";
import { isRecord } from "@/chat/coerce";
import {
  createEncryptedState,
  readEncryptedState,
} from "@/chat/encryption/state";
import { getStateAdapter } from "@/chat/state/adapter";
import { fenceLock, MUTATION_LOCK_TTL_MS, withLock } from "@/chat/state/locks";

const MCP_AUTH_SESSION_PREFIX = "junior:mcp_oauth_attempt:v2";
const MCP_AUTH_CREDENTIALS_PREFIX = "junior:mcp_auth_credentials";
const MCP_AUTH_SESSION_INDEX_PREFIX = "junior:mcp_oauth_attempt_index:v2";
const MCP_SERVER_SESSION_PREFIX = "junior:mcp_server_session";
const MCP_AUTH_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MCP_AUTH_CREDENTIALS_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MCP_SERVER_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MCP_CONNECTION_LOCK_WAIT_MS = 10_000;

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
  toolChannelId?: string;
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

/**
 * How far a person's own MCP connection to one provider got. `started` means
 * a sign-in saved a client or discovery state but no tokens.
 */
export type McpConnectionStatus = "none" | "started" | "connected";

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

function connectionLockKey(userId: string, provider: string): string {
  return `${credentialsKey(userId, provider)}:lock`;
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

function parseMcpAuthSession(value: unknown): McpAuthSessionState | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  try {
    const parsed = value;

    if (
      parsed.schemaVersion !== 2 ||
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

    const destination =
      parsed.destination === undefined
        ? undefined
        : parseDestination(parsed.destination);
    if (parsed.destination !== undefined && !destination) {
      return undefined;
    }
    const source =
      parsed.source === undefined
        ? undefined
        : sourceSchema.safeParse(parsed.source);
    if (parsed.source !== undefined && (!source || !source.success)) {
      return undefined;
    }

    return {
      schemaVersion: 2,
      authSessionId: parsed.authSessionId,
      provider: parsed.provider,
      userId: parsed.userId,
      conversationId: parsed.conversationId,
      ...(destination ? { destination } : undefined),
      ...(source?.success ? { source: source.data } : undefined),
      sessionId: parsed.sessionId,
      userMessage: parsed.userMessage,
      createdAtMs: parsed.createdAtMs,
      updatedAtMs: parsed.updatedAtMs,
      ...(typeof parsed.channelId === "string"
        ? { channelId: parsed.channelId }
        : undefined),
      ...(typeof parsed.threadTs === "string"
        ? { threadTs: parsed.threadTs }
        : undefined),
      ...(typeof parsed.toolChannelId === "string"
        ? { toolChannelId: parsed.toolChannelId }
        : undefined),
      ...(isRecord(parsed.configuration)
        ? { configuration: parsed.configuration }
        : undefined),
      ...(typeof parsed.authorizationUrl === "string"
        ? { authorizationUrl: parsed.authorizationUrl }
        : undefined),
      ...(typeof parsed.codeVerifier === "string"
        ? { codeVerifier: parsed.codeVerifier }
        : undefined),
    };
  } catch {
    return undefined;
  }
}

function parseServerSession(value: unknown): McpServerSessionState | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      !isRecord(parsed) ||
      typeof parsed.sessionId !== "string" ||
      typeof parsed.updatedAtMs !== "number"
    ) {
      return undefined;
    }

    return {
      sessionId: parsed.sessionId,
      updatedAtMs: parsed.updatedAtMs,
    };
  } catch {
    return undefined;
  }
}

function parseStoredCredentials(
  value: unknown,
): McpStoredOAuthCredentials | undefined {
  try {
    // Plaintext values from before encryption are JSON strings.
    const parsed: unknown =
      typeof value === "string" ? JSON.parse(value) : value;
    if (!isRecord(parsed)) {
      return undefined;
    }

    return {
      ...(isRecord(parsed.clientInformation)
        ? {
            clientInformation:
              parsed.clientInformation as OAuthClientInformationMixed,
          }
        : undefined),
      ...(isRecord(parsed.discoveryState)
        ? {
            // @ts-expect-error non-overlapping boundary cast; rule forbids as-unknown-as chains
            discoveryState: parsed.discoveryState as OAuthDiscoveryState,
          }
        : undefined),
      ...(isRecord(parsed.tokens)
        ? { tokens: parsed.tokens as OAuthTokens }
        : undefined),
    };
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

async function readCredentials(
  state: StateAdapter,
  key: string,
): Promise<unknown> {
  return (await readEncryptedState(state, key))?.value;
}

type ConnectedStateAdapter = Awaited<
  ReturnType<typeof getConnectedStateAdapter>
>;

/**
 * Run one write to a person's MCP connection for one provider. Credentials,
 * the server session, and authorization attempts of that user and provider share
 * this lock, so a read-modify-write cannot lose a concurrent one. Call
 * `fence` right before the write. Do not call another locked function in
 * `run`: the lock is not reentrant.
 */
async function withMcpConnectionLock<T>(
  userId: string,
  provider: string,
  run: (state: ConnectedStateAdapter, fence: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const state = await getConnectedStateAdapter();
  const result = await withLock(
    state,
    connectionLockKey(userId, provider),
    async (lock) => await run(state, () => fenceLock(state, lock)),
    { ttlMs: MUTATION_LOCK_TTL_MS, waitMs: MCP_CONNECTION_LOCK_WAIT_MS },
  );
  if (!result.acquired) {
    throw new Error(
      `Could not acquire the MCP connection lock for ${provider}`,
    );
  }
  return result.value;
}

/** Write one attempt and its index entry. The caller holds the lock. */
async function writeMcpAuthSession(
  state: ConnectedStateAdapter,
  session: McpAuthSessionState,
  ttlMs: number,
): Promise<void> {
  const indexKey = sessionIndexKey(session.userId, session.provider);
  const nextIndex = parseSessionIndex(await state.get(indexKey));
  if (!nextIndex.includes(session.authSessionId)) {
    nextIndex.push(session.authSessionId);
  }
  await createEncryptedState(state).set(
    sessionKey(session.authSessionId),
    session,
    ttlMs,
  );
  await state.set(indexKey, JSON.stringify(nextIndex), ttlMs);
}

export async function getMcpAuthSession(
  authSessionId: string,
): Promise<McpAuthSessionState | undefined> {
  const stateAdapter = await getConnectedStateAdapter();
  return parseMcpAuthSession(
    await readMcpAuthSession(stateAdapter, authSessionId),
  );
}

/** Save one authorization attempt and add it to the user/provider index. */
export async function putMcpAuthSession(
  session: McpAuthSessionState,
  ttlMs: number = MCP_AUTH_SESSION_TTL_MS,
): Promise<void> {
  await withMcpConnectionLock(
    session.userId,
    session.provider,
    async (state, fence) => {
      await fence();
      await writeMcpAuthSession(state, session, ttlMs);
    },
  );
}

/** Change fields of a authorization attempt that exists. Its identity stays fixed. */
export async function patchMcpAuthSession(
  authSessionId: string,
  patch: Partial<McpAuthSessionState>,
): Promise<McpAuthSessionState> {
  const owner = await getMcpAuthSession(authSessionId);
  if (!owner) {
    throw new Error(`Unknown MCP auth session: ${authSessionId}`);
  }

  return await withMcpConnectionLock(
    owner.userId,
    owner.provider,
    async (state, fence) => {
      const current = parseMcpAuthSession(
        await readMcpAuthSession(state, authSessionId),
      );
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
        ...(current.destination
          ? { destination: current.destination }
          : undefined),
        sessionId: current.sessionId,
        userMessage: current.userMessage,
        createdAtMs: current.createdAtMs,
        updatedAtMs: Date.now(),
      };
      await fence();
      await writeMcpAuthSession(state, next, MCP_AUTH_SESSION_TTL_MS);
      return next;
    },
  );
}

/** Delete one authorization attempt and remove it from the user/provider index. */
export async function deleteMcpAuthSession(
  authSessionId: string,
): Promise<void> {
  const current = await getMcpAuthSession(authSessionId);
  if (!current) {
    const stateAdapter = await getConnectedStateAdapter();
    await stateAdapter.delete(sessionKey(authSessionId));
    return;
  }

  await withMcpConnectionLock(
    current.userId,
    current.provider,
    async (state, fence) => {
      const indexKey = sessionIndexKey(current.userId, current.provider);
      const nextIndex = parseSessionIndex(await state.get(indexKey)).filter(
        (id) => id !== authSessionId,
      );
      await fence();
      await state.delete(sessionKey(authSessionId));
      if (nextIndex.length > 0) {
        await state.set(
          indexKey,
          JSON.stringify(nextIndex),
          MCP_AUTH_SESSION_TTL_MS,
        );
        return;
      }
      await state.delete(indexKey);
    },
  );
}

export async function getMcpStoredOAuthCredentials(
  userId: string,
  provider: string,
): Promise<McpStoredOAuthCredentials | undefined> {
  const stateAdapter = await getConnectedStateAdapter();
  // Stale values expire within the credential TTL or move to the active key
  // on the next save, so they are not saved again here.
  const stored = parseStoredCredentials(
    await readCredentials(stateAdapter, credentialsKey(userId, provider)),
  );
  if (stored) return stored;
  // TODO(dcramer): Delete after no legacy `dashboard:` MCP credential keys
  // remain. Web Actors saved them before they used the User id, so move them.
  const legacyUserId = await findLegacyWebActorUserId(userId);
  if (!legacyUserId) return undefined;
  const legacyKey = credentialsKey(legacyUserId, provider);
  const legacy = parseStoredCredentials(
    await readCredentials(stateAdapter, legacyKey),
  );
  if (!legacy) return undefined;
  return await withMcpConnectionLock(userId, provider, async (state, fence) => {
    const current = parseStoredCredentials(
      await readCredentials(state, credentialsKey(userId, provider)),
    );
    if (current) return current;
    // Read the legacy key again under the lock, so a move cannot undo an
    // unlink that deleted it after the read above.
    const lockedLegacy = parseStoredCredentials(
      await readCredentials(state, legacyKey),
    );
    if (!lockedLegacy) return undefined;
    await fence();
    await createEncryptedState(state).set(
      credentialsKey(userId, provider),
      lockedLegacy,
      MCP_AUTH_CREDENTIALS_TTL_MS,
    );
    await state.delete(legacyKey);
    return lockedLegacy;
  });
}

/** The one definition of whether a person has their own MCP connection. */
export async function getMcpConnectionStatus(
  userId: string,
  provider: string,
): Promise<McpConnectionStatus> {
  const credentials = await getMcpStoredOAuthCredentials(userId, provider);
  if (credentials?.tokens) return "connected";
  return credentials?.clientInformation || credentials?.discoveryState
    ? "started"
    : "none";
}

/**
 * Change a person's stored MCP credentials under the connection lock.
 * `update` gets the stored value and returns the next one, or `undefined` to
 * write nothing. It must not call another function of this module that
 * writes.
 */
export async function updateMcpStoredOAuthCredentials(
  userId: string,
  provider: string,
  update: (
    current: McpStoredOAuthCredentials | undefined,
  ) =>
    | McpStoredOAuthCredentials
    | undefined
    | Promise<McpStoredOAuthCredentials | undefined>,
): Promise<void> {
  await withMcpConnectionLock(userId, provider, async (state, fence) => {
    const key = credentialsKey(userId, provider);
    const next = await update(
      parseStoredCredentials(await readCredentials(state, key)),
    );
    if (!next) return;
    await fence();
    await createEncryptedState(state).set(
      key,
      next,
      MCP_AUTH_CREDENTIALS_TTL_MS,
    );
  });
}

/**
 * Remove a person's MCP connection to one provider: credentials, server
 * session, and every authorization attempt. A Turn or callback that read the
 * connection before cannot bring it back, because its writes take the same
 * lock and check what they read.
 */
export async function deleteMcpConnection(
  userId: string,
  provider: string,
): Promise<void> {
  // TODO(dcramer): Drop the legacy key with the legacy read above.
  const legacyUserId = await findLegacyWebActorUserId(userId);
  await withMcpConnectionLock(userId, provider, async (state, fence) => {
    const indexKey = sessionIndexKey(userId, provider);
    const authSessionIds = parseSessionIndex(await state.get(indexKey));
    await fence();
    await state.delete(credentialsKey(userId, provider));
    if (legacyUserId) {
      await state.delete(credentialsKey(legacyUserId, provider));
    }
    await state.delete(serverSessionKey(userId, provider));
    for (const authSessionId of authSessionIds) {
      await state.delete(sessionKey(authSessionId));
    }
    await state.delete(indexKey);
  });
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
  await withMcpConnectionLock(userId, provider, async (state, fence) => {
    await fence();
    await state.set(
      serverSessionKey(userId, provider),
      JSON.stringify({
        sessionId,
        updatedAtMs: Date.now(),
      } satisfies McpServerSessionState),
      ttlMs,
    );
  });
}

export async function deleteMcpServerSessionId(
  userId: string,
  provider: string,
): Promise<void> {
  await withMcpConnectionLock(userId, provider, async (state, fence) => {
    await fence();
    await state.delete(serverSessionKey(userId, provider));
  });
}
