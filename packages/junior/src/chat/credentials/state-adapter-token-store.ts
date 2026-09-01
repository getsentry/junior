import type { StateAdapter } from "chat";
import type {
  StoredTokens,
  UserTokenStore,
} from "@/chat/credentials/user-token-store";
import type { InstallationTokenStore } from "@/chat/credentials/installation-token-store";
import { storedTokensSchema } from "@/chat/credentials/user-token-store";
import { sleep } from "@/chat/sleep";
import { acquireActiveLock } from "@/chat/state/locks";

const KEY_PREFIX = "oauth-token";
const INSTALLATION_KEY_PREFIX = "oauth-installation-token";
const BUFFER_MS = 24 * 60 * 60 * 1000; // 24h buffer for refresh token lifetime
const LONG_LIVED_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const REFRESH_LOCK_WAIT_MS = 30_000;
const REFRESH_LOCK_RETRY_MS = 100;

function tokenKey(userId: string, provider: string): string {
  return `${KEY_PREFIX}:${userId}:${provider}`;
}

function installationTokenKey(provider: string): string {
  return `${INSTALLATION_KEY_PREFIX}:${provider}`;
}

function tokenTtlMs(tokens: StoredTokens): number {
  const expiresAt = tokens.refreshTokenExpiresAt ?? tokens.expiresAt;
  return expiresAt
    ? Math.max(expiresAt - Date.now() + BUFFER_MS, BUFFER_MS)
    : LONG_LIVED_TTL_MS;
}

async function withTokenRefresh<T>(
  state: StateAdapter,
  key: string,
  callback: () => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + REFRESH_LOCK_WAIT_MS;
  while (true) {
    const lock = await acquireActiveLock(state, `${key}:refresh`);
    if (lock) {
      try {
        return await callback();
      } finally {
        await state.releaseLock(lock);
      }
    }
    if (Date.now() >= deadline) {
      throw new Error("Could not acquire OAuth token refresh lock");
    }
    await sleep(REFRESH_LOCK_RETRY_MS);
  }
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
      : storedTokensSchema.parse(stored);
  }

  async set(
    userId: string,
    provider: string,
    tokens: StoredTokens,
  ): Promise<void> {
    const parsed = storedTokensSchema.parse(tokens);
    await this.state.set(
      tokenKey(userId, provider),
      parsed,
      tokenTtlMs(parsed),
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
    return await withTokenRefresh(
      this.state,
      tokenKey(userId, provider),
      callback,
    );
  }
}

export class StateAdapterInstallationTokenStore implements InstallationTokenStore {
  constructor(private readonly state: StateAdapter) {}

  async get(provider: string): Promise<StoredTokens | undefined> {
    const stored = await this.state.get<unknown>(
      installationTokenKey(provider),
    );
    return stored === null || stored === undefined
      ? undefined
      : storedTokensSchema.parse(stored);
  }

  async set(provider: string, tokens: StoredTokens): Promise<void> {
    const parsed = storedTokensSchema.parse(tokens);
    await this.state.set(
      installationTokenKey(provider),
      parsed,
      tokenTtlMs(parsed),
    );
  }

  async delete(provider: string): Promise<void> {
    await this.state.delete(installationTokenKey(provider));
  }

  async withRefresh<T>(
    provider: string,
    callback: () => Promise<T>,
  ): Promise<T> {
    return await withTokenRefresh(
      this.state,
      installationTokenKey(provider),
      callback,
    );
  }
}
