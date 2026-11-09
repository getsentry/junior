import type { StateAdapter } from "chat";
import * as z from "zod";
import { pluginProviderAccountSchema } from "@sentry/junior-plugin-api";
import type {
  StoredTokens,
  UserConnection,
  UserConnectionChange,
  UserTokenStore,
} from "@/chat/credentials/user-token-store";
import { storedTokensSchema } from "@/chat/credentials/user-token-store";
import { sleep } from "@/chat/sleep";
import {
  acquireActiveLock,
  fenceLock,
  MUTATION_LOCK_TTL_MS,
  withLock,
} from "@/chat/state/locks";

const KEY_PREFIX = "oauth-token";
const BUFFER_MS = 24 * 60 * 60 * 1000; // 24h buffer for refresh token lifetime
const LONG_LIVED_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const REFRESH_LOCK_WAIT_MS = 30_000;
const REFRESH_LOCK_RETRY_MS = 100;
const WRITE_LOCK_WAIT_MS = 10_000;

function tokenKey(userId: string, provider: string): string {
  return `${KEY_PREFIX}:${userId}:${provider}`;
}

function refreshLockKey(userId: string, provider: string): string {
  return `${tokenKey(userId, provider)}:refresh`;
}

function writeLockKey(userId: string, provider: string): string {
  return `${tokenKey(userId, provider)}:write`;
}

const expiredConnectionSchema = z
  .object({
    status: z.literal("expired"),
    account: pluginProviderAccountSchema.optional(),
  })
  .strict();

// Records saved before connection status are bare tokens. Keep connected
// records in that shape so instances on either side of a deploy read them.
function decodeConnection(stored: unknown): UserConnection | undefined {
  if (stored === null || stored === undefined) return undefined;
  if (typeof stored === "object" && "status" in stored) {
    return expiredConnectionSchema.parse(stored);
  }
  return { status: "connected", tokens: storedTokensSchema.parse(stored) };
}

function hasSameTokens(a: StoredTokens, b: StoredTokens): boolean {
  return a.accessToken === b.accessToken && a.refreshToken === b.refreshToken;
}

function tokenTtlMs(tokens: StoredTokens): number {
  const expiresAt = tokens.refreshTokenExpiresAt ?? tokens.expiresAt;
  return expiresAt
    ? Math.max(expiresAt - Date.now() + BUFFER_MS, BUFFER_MS)
    : LONG_LIVED_TTL_MS;
}

export class StateAdapterTokenStore implements UserTokenStore {
  private readonly state: StateAdapter;

  constructor(stateAdapter: StateAdapter) {
    this.state = stateAdapter;
  }

  async read(
    userId: string,
    provider: string,
  ): Promise<UserConnection | undefined> {
    return decodeConnection(
      await this.state.get<unknown>(tokenKey(userId, provider)),
    );
  }

  async get(
    userId: string,
    provider: string,
  ): Promise<StoredTokens | undefined> {
    const connection = await this.read(userId, provider);
    return connection?.status === "connected" ? connection.tokens : undefined;
  }

  /**
   * Own every write to a user connection. Each change reads, checks, and
   * writes under one per-connection lock, so a refresh that finishes after a
   * disconnect or a reconnect cannot write the old grant back.
   */
  async transition(
    userId: string,
    provider: string,
    change: UserConnectionChange,
  ): Promise<boolean> {
    const key = tokenKey(userId, provider);
    const attempt = await withLock(
      this.state,
      writeLockKey(userId, provider),
      async (lock) => {
        if (change.type === "connect") {
          const tokens = storedTokensSchema.parse(change.tokens);
          await fenceLock(this.state, lock);
          await this.state.set(key, tokens, tokenTtlMs(tokens));
          return true;
        }
        if (change.type === "disconnect") {
          await fenceLock(this.state, lock);
          await this.state.delete(key);
          return true;
        }
        const current = await this.read(userId, provider);
        if (
          current?.status !== "connected" ||
          !hasSameTokens(current.tokens, change.from)
        ) {
          return false;
        }
        if (change.type === "update") {
          const tokens = storedTokensSchema.parse(change.tokens);
          await fenceLock(this.state, lock);
          await this.state.set(key, tokens, tokenTtlMs(tokens));
          return true;
        }
        const account = current.tokens.account;
        await fenceLock(this.state, lock);
        await this.state.set(
          key,
          { status: "expired", ...(account ? { account } : undefined) },
          LONG_LIVED_TTL_MS,
        );
        return true;
      },
      { ttlMs: MUTATION_LOCK_TTL_MS, waitMs: WRITE_LOCK_WAIT_MS },
    );
    if (!attempt.acquired) {
      throw new Error("Could not acquire OAuth connection write lock");
    }
    return attempt.value;
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
