import type { StateAdapter } from "chat";
import type { StoredTokens, UserTokenStore } from "@/chat/credentials/user-token-store";

const KEY_PREFIX = "oauth-token";
const BUFFER_MS = 24 * 60 * 60 * 1000; // 24h buffer for refresh token lifetime

function tokenKey(userId: string, provider: string): string {
  return `${KEY_PREFIX}:${userId}:${provider}`;
}

export class StateAdapterTokenStore implements UserTokenStore {
  private readonly state: StateAdapter;

  constructor(stateAdapter: StateAdapter) {
    this.state = stateAdapter;
  }

  async get(userId: string, provider: string): Promise<StoredTokens | undefined> {
    const stored = await this.state.get<StoredTokens>(tokenKey(userId, provider));
    return stored ?? undefined;
  }

  async set(userId: string, provider: string, tokens: StoredTokens): Promise<void> {
    const ttlMs = Math.max(tokens.expiresAt - Date.now() + BUFFER_MS, BUFFER_MS);
    await this.state.set(tokenKey(userId, provider), tokens, ttlMs);
  }

  async delete(userId: string, provider: string): Promise<void> {
    await this.state.delete(tokenKey(userId, provider));
  }
}
