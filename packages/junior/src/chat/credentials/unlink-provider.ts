import type { UserTokenStore } from "@/chat/credentials/user-token-store";
import {
  deleteMcpAuthSessionsForUserProvider,
  deleteMcpServerSessionId,
  deleteMcpStoredOAuthCredentials,
} from "@/chat/mcp/auth-store";

export async function unlinkProvider(
  userId: string,
  provider: string,
  userTokenStore: UserTokenStore,
): Promise<void> {
  await Promise.all([
    userTokenStore.delete(userId, provider),
    deleteMcpStoredOAuthCredentials(userId, provider),
    deleteMcpServerSessionId(userId, provider),
    deleteMcpAuthSessionsForUserProvider(userId, provider),
  ]);
}
