/**
 * Move OAuth tokens saved under a legacy web Actor id to the User id.
 *
 * Dashboard connections made before web Actors used the User id are saved
 * under `dashboard:<hash>`. When a read for a User id finds no tokens, this
 * moves the legacy tokens, so the person keeps the connection. A delete also
 * deletes the legacy key, so a disconnect cannot bring it back later.
 *
 * TODO(dcramer): Delete after no `oauth-token:dashboard:*` keys remain.
 */
import { findLegacyWebActorUserId } from "@/chat/conversations/legacy-web-actor-id";
import type { UserTokenStore } from "./user-token-store";

/** Read through to legacy web tokens when a User id has none. */
export function withLegacyWebTokens(store: UserTokenStore): UserTokenStore {
  return {
    async get(userId, provider) {
      const tokens = await store.get(userId, provider);
      if (tokens) return tokens;
      const legacyUserId = await findLegacyWebActorUserId(userId);
      if (!legacyUserId) return undefined;
      const legacy = await store.get(legacyUserId, provider);
      if (!legacy) return undefined;
      await store.set(userId, provider, legacy);
      await store.delete(legacyUserId, provider);
      return legacy;
    },
    set: (userId, provider, tokens) => store.set(userId, provider, tokens),
    async delete(userId, provider) {
      await store.delete(userId, provider);
      const legacyUserId = await findLegacyWebActorUserId(userId);
      if (legacyUserId) await store.delete(legacyUserId, provider);
    },
    withRefresh: (userId, provider, callback) =>
      store.withRefresh(userId, provider, callback),
  };
}
