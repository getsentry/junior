import {
  pluginStoredTokensSchema,
  type PluginProviderAccount,
  type PluginStoredTokens,
} from "@sentry/junior-plugin-api";

export const storedTokensSchema = pluginStoredTokensSchema;

export type StoredProviderAccount = PluginProviderAccount;
export type StoredTokens = PluginStoredTokens;

export interface UserTokenStore {
  get(userId: string, provider: string): Promise<StoredTokens | undefined>;
  set(userId: string, provider: string, tokens: StoredTokens): Promise<void>;
  delete(userId: string, provider: string): Promise<void>;
  /** Run refresh-token rotation for one user/provider slot, or throw after a bounded wait. */
  withRefresh<T>(
    userId: string,
    provider: string,
    callback: () => Promise<T>,
  ): Promise<T>;
}
