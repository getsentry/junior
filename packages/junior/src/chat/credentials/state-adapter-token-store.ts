import type { StateAdapter } from "chat";
import type {
  StoredTokens,
  UserTokenStore,
} from "@/chat/credentials/user-token-store";
import { storedTokensSchema } from "@/chat/credentials/user-token-store";
import { sleep } from "@/chat/sleep";
import { acquireActiveLock } from "@/chat/state/locks";

const KEY_PREFIX = "oauth-token";
const BUFFER_MS = 24 * 60 * 60 * 1000; // 24h buffer for refresh token lifetime
const LONG_LIVED_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const REFRESH_LOCK_WAIT_MS = 30_000;
const REFRESH_LOCK_RETRY_MS = 100;

interface AuthorizationCompletedTokenRecord {
  authorizationCompletionId: string;
  tokens: StoredTokens;
}

function tokenKey(userId: string, provider: string): string {
  return `${KEY_PREFIX}:${userId}:${provider}`;
}

function refreshLockKey(userId: string, provider: string): string {
  return `${tokenKey(userId, provider)}:refresh`;
}

function parseStoredTokenRecord(value: unknown): {
  authorizationCompletionId?: string;
  tokens: StoredTokens;
} {
  if (
    typeof value === "object" &&
    value !== null &&
    "tokens" in value &&
    "authorizationCompletionId" in value
  ) {
    const record = value as Record<string, unknown>;
    if (typeof record.authorizationCompletionId !== "string") {
      throw new Error("Invalid OAuth authorization completion receipt");
    }
    return {
      authorizationCompletionId: record.authorizationCompletionId,
      tokens: storedTokensSchema.parse(record.tokens),
    };
  }
  return { tokens: storedTokensSchema.parse(value) };
}

export class StateAdapterTokenStore implements UserTokenStore {
  private readonly state: StateAdapter;

  constructor(stateAdapter: StateAdapter) {
    this.state = stateAdapter;
  }

  async get(
    userId: string,
    provider: string,
  ): Promise<StoredTokens | undefined> {
    const stored = await this.state.get<unknown>(tokenKey(userId, provider));
    return stored === null || stored === undefined
      ? undefined
      : parseStoredTokenRecord(stored).tokens;
  }

  async set(
    userId: string,
    provider: string,
    tokens: StoredTokens,
  ): Promise<void> {
    const parsed = storedTokensSchema.parse(tokens);
    const expiresAt = parsed.refreshTokenExpiresAt ?? parsed.expiresAt;
    const ttlMs = expiresAt
      ? Math.max(expiresAt - Date.now() + BUFFER_MS, BUFFER_MS)
      : LONG_LIVED_TTL_MS;
    await this.state.set(tokenKey(userId, provider), parsed, ttlMs);
  }

  /** Commit tokens and the opaque receipt proving one callback exchanged its code. */
  async setForAuthorizationCompletion(
    userId: string,
    provider: string,
    tokens: StoredTokens,
    authorizationCompletionId: string,
  ): Promise<void> {
    const parsed = storedTokensSchema.parse(tokens);
    const expiresAt = parsed.refreshTokenExpiresAt ?? parsed.expiresAt;
    const ttlMs = expiresAt
      ? Math.max(expiresAt - Date.now() + BUFFER_MS, BUFFER_MS)
      : LONG_LIVED_TTL_MS;
    await this.state.set(
      tokenKey(userId, provider),
      {
        authorizationCompletionId,
        tokens: parsed,
      } satisfies AuthorizationCompletedTokenRecord,
      ttlMs,
    );
  }

  /** Check whether the credential slot carries one exact callback receipt. */
  async hasAuthorizationCompletion(
    userId: string,
    provider: string,
    authorizationCompletionId: string,
  ): Promise<boolean> {
    const stored = await this.state.get<unknown>(tokenKey(userId, provider));
    if (stored === null || stored === undefined) return false;
    return (
      parseStoredTokenRecord(stored).authorizationCompletionId ===
      authorizationCompletionId
    );
  }

  async delete(userId: string, provider: string): Promise<void> {
    await this.state.delete(tokenKey(userId, provider));
  }

  /** Wait for the per-slot refresh gate so rotated refresh tokens are used once. */
  async withRefresh<T>(
    userId: string,
    provider: string,
    callback: () => Promise<T>,
  ): Promise<T> {
    const lockKey = refreshLockKey(userId, provider);
    const deadline = Date.now() + REFRESH_LOCK_WAIT_MS;
    while (true) {
      const lock = await acquireActiveLock(this.state, lockKey);
      if (lock) {
        try {
          return await callback();
        } finally {
          await this.state.releaseLock(lock);
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(`Could not acquire OAuth token refresh lock`);
      }
      await sleep(REFRESH_LOCK_RETRY_MS);
    }
  }
}
