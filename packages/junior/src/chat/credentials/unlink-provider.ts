import { getSqlExecutor } from "@/chat/db";
import { deleteProviderIdentity } from "@/chat/identities/sql";
import type { UserTokenStore } from "@/chat/credentials/user-token-store";
import {
  deleteMcpAuthSessionsForUserProvider,
  deleteMcpServerSessionId,
  deleteMcpStoredOAuthCredentials,
} from "@/chat/mcp/auth-store";

/** Remove one provider connection and its exact stored account identity. */
export async function unlinkProvider(
  userId: string,
  provider: string,
  userTokenStore: UserTokenStore,
): Promise<void> {
  const tokens = await userTokenStore.get(userId, provider);
  if (tokens?.account) {
    await deleteProviderIdentity(
      getSqlExecutor(),
      provider,
      tokens.account.id,
    );
  }
  await Promise.all([
    userTokenStore.delete(userId, provider),
    deleteMcpStoredOAuthCredentials(userId, provider),
    deleteMcpServerSessionId(userId, provider),
    deleteMcpAuthSessionsForUserProvider(userId, provider),
  ]);
}
