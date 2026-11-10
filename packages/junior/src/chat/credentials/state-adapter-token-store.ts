import type { StateAdapter } from "chat";
import type {
  StoredTokens,
  UserTokenStore,
} from "@/chat/credentials/user-token-store";
import { storedTokensSchema } from "@/chat/credentials/user-token-store";
import {
  createEncryptedState,
  readEncryptedState,
  type EncryptedState,
} from "@/chat/encryption/state";
import { sleep } from "@/chat/sleep";
import {
  acquireActiveLock,
  MUTATION_LOCK_TTL_MS,
  withLock,
} from "@/chat/state/locks";

const KEY_PREFIX = "oauth-token";
const BUFFER_MS = 24 * 60 * 60 * 1000; // 24h buffer for refresh token lifetime
const LONG_LIVED_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const REFRESH_LOCK_WAIT_MS = 30_000;
const REFRESH_LOCK_RETRY_MS = 100;

function tokenKey(userId: string, provider: string): string {
  return `${KEY_PREFIX}:${userId}:${provider}`;
}

function refreshLockKey(userId: string, provider: string): string {
  return `${tokenKey(userId, provider)}:refresh`;
}

export class StateAdapterTokenStore implements UserTokenStore {
  private readonly state: StateAdapter;
  private readonly secrets: EncryptedState;

  constructor(stateAdapter: StateAdapter) {
    this.state = stateAdapter;
    this.secrets = createEncryptedState(stateAdapter);
  }

  async get(
    userId: string,
    provider: string,
  ): Promise<StoredTokens | undefined> {
    const stored = await readEncryptedState(
      this.state,
      tokenKey(userId, provider),
    );
    if (!stored) return undefined;
    const tokens = storedTokensSchema.parse(stored.value);
    if (stored.stale) await this.saveStale(userId, provider);
    return tokens;
  }

  /**
   * Save stale tokens again with the current key. It runs only when the
   * refresh gate is free, so it cannot write back a refresh token that a
   * refresh replaced.
   */
  private async saveStale(userId: string, provider: string): Promise<void> {
    await withLock(
      this.state,
      refreshLockKey(userId, provider),
      async () => {
        const key = tokenKey(userId, provider);
        const current = await readEncryptedState(this.state, key);
        if (!current?.stale) return;
        await this.set(
          userId,
          provider,
          storedTokensSchema.parse(current.value),
        );
      },
      { ttlMs: MUTATION_LOCK_TTL_MS },
    );
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
    await this.secrets.set(tokenKey(userId, provider), parsed, ttlMs);
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
