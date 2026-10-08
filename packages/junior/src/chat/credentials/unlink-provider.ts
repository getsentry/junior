import { getSqlExecutor } from "@/chat/db";
import { deleteProviderIdentityForSlackUser } from "@/chat/identities/sql";
import type { UserTokenStore } from "@/chat/credentials/user-token-store";
import { CredentialDecryptionError } from "@/chat/credentials/encryption";
import {
  deleteMcpAuthSessionsForUserProvider,
  deleteMcpServerSessionId,
  deleteMcpStoredOAuthCredentials,
} from "@/chat/mcp/auth-store";

/**
 * Read the stored tokens only to find the linked account id.
 *
 * A credential that Junior cannot decrypt must not block a disconnect. In that
 * case the stored credentials are still deleted, but the linked identity row
 * stays because its account id is unknown.
 */
async function readTokensForUnlink(
  userId: string,
  provider: string,
  userTokenStore: UserTokenStore,
) {
  try {
    return await userTokenStore.get(userId, provider);
  } catch (error) {
    if (error instanceof CredentialDecryptionError) {
      return undefined;
    }
    throw error;
  }
}

/** Remove one provider connection and its exact stored account identity. */
export async function unlinkProvider(
  userId: string,
  provider: string,
  userTokenStore: UserTokenStore,
  slackTeamId?: string,
): Promise<void> {
  const tokens = await readTokensForUnlink(userId, provider, userTokenStore);
  if (tokens?.account && slackTeamId) {
    await deleteProviderIdentityForSlackUser(
      getSqlExecutor(),
      slackTeamId,
      userId,
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
