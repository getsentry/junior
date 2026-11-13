import {
  pluginStoredTokensSchema,
  type PluginProviderAccount,
  type PluginStoredTokens,
} from "@sentry/junior-plugin-api";

export const storedTokensSchema = pluginStoredTokensSchema;

export type StoredProviderAccount = PluginProviderAccount;
export type StoredTokens = PluginStoredTokens;

/**
 * One user's OAuth connection to one provider. No connection means the user
 * never connected or disconnected.
 *
 * - `connected`: the grant is usable or can refresh.
 * - `expired`: the provider rejected the refresh token. Only a new connect
 *   leaves this state. The record keeps the account and no secrets.
 */
export type UserConnection =
  | { status: "connected"; tokens: StoredTokens }
  | { status: "expired"; account?: StoredProviderAccount };

/**
 * One change to a user connection.
 *
 * - `connect`: a new grant replaces any state.
 * - `update`: refreshed or enriched tokens for the grant in `from`.
 * - `expire`: the provider rejected the refresh token of the grant in `from`.
 * - `disconnect`: remove the connection.
 *
 * `from` is the tokens that the writer read. The store rejects `update` and
 * `expire` when the connection has moved on since that read, so a late write
 * cannot undo a disconnect or a newer grant.
 */
export type UserConnectionChange =
  | { type: "connect"; tokens: StoredTokens }
  | { type: "update"; from: StoredTokens; tokens: StoredTokens }
  | { type: "expire"; from: StoredTokens }
  | { type: "disconnect" };

export interface UserTokenStore {
  /** Return usable tokens, or undefined when the user has no connected grant. */
  get(userId: string, provider: string): Promise<StoredTokens | undefined>;
  /** Return the connection and its status. */
  read(userId: string, provider: string): Promise<UserConnection | undefined>;
  /**
   * Apply one change under the per-connection write lock. Return false when
   * the store rejected an `update` or `expire` for a grant that is no longer
   * current.
   */
  transition(
    userId: string,
    provider: string,
    change: UserConnectionChange,
  ): Promise<boolean>;
  /** Run refresh-token rotation for one user/provider slot, or throw after a bounded wait. */
  withRefresh<T>(
    userId: string,
    provider: string,
    callback: () => Promise<T>,
  ): Promise<T>;
}

/** Return the provider account of a connection in any status. */
export function connectionAccount(
  connection: UserConnection | undefined,
): StoredProviderAccount | undefined {
  return connection?.status === "connected"
    ? connection.tokens.account
    : connection?.account;
}
