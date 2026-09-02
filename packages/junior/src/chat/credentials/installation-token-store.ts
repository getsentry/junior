import type { StoredTokens } from "@/chat/credentials/user-token-store";

/** Persistent OAuth token storage scoped to one Slack workspace or local app. */
export interface InstallationTokenStore {
  get(provider: string): Promise<StoredTokens | undefined>;
  set(provider: string, tokens: StoredTokens): Promise<void>;
  delete(provider: string): Promise<void>;
  /** Run refresh-token rotation for one provider slot, or throw after a bounded wait. */
  withRefresh<T>(provider: string, callback: () => Promise<T>): Promise<T>;
}
