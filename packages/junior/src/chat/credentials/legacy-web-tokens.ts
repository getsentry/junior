/**
 * Move OAuth tokens saved under a legacy web Actor id to the User id.
 *
 * Dashboard connections made before web Actors used the User id are saved
 * under `dashboard:<hash>`. When a read for a User id finds no tokens, this
 * moves the legacy tokens, so the person keeps the connection. A disconnect
 * also deletes the legacy key. It deletes that key first, so a move that
 * runs at the same time cannot bring the connection back.
 *
 * TODO(dcramer): Delete after no `oauth-token:dashboard:*` keys remain.
 */
import { findLegacyWebActorUserId } from "@/chat/conversations/legacy-web-actor-id";
import type { StateAdapterTokenStore } from "./state-adapter-token-store";
import type { UserTokenStore } from "./user-token-store";

/** Read through to legacy web tokens when a User id has none. */
export function withLegacyWebTokens(
  store: StateAdapterTokenStore,
): UserTokenStore {
  async function read(userId: string, provider: string) {
    const connection = await store.read(userId, provider);
    if (connection) return connection;
    const legacyUserId = await findLegacyWebActorUserId(userId);
    if (!legacyUserId) return undefined;
    return await store.move(legacyUserId, userId, provider);
  }
  return {
    read,
    async get(userId, provider) {
      const connection = await read(userId, provider);
      return connection?.status === "connected" ? connection.tokens : undefined;
    },
    async transition(userId, provider, change) {
      if (change.type === "disconnect") {
        const legacyUserId = await findLegacyWebActorUserId(userId);
        if (legacyUserId) {
          await store.transition(legacyUserId, provider, change);
        }
      }
      return await store.transition(userId, provider, change);
    },
    withRefresh: (userId, provider, callback) =>
      store.withRefresh(userId, provider, callback),
  };
}
