import { getSqlExecutor } from "@/chat/db";
import { deleteProviderIdentityForSlackUser } from "@/chat/identities/sql";
import type { UserTokenStore } from "@/chat/credentials/user-token-store";
import type { InstallationTokenStore } from "@/chat/credentials/installation-token-store";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
import { isSlackWorkspaceAdmin } from "@/chat/slack/admin";
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
  installationTokenStore: InstallationTokenStore,
  slackTeamId?: string,
): Promise<void> {
  if (
    pluginCatalogRuntime.getOAuthConfig(provider)?.tokenSubject === "installation"
  ) {
    if (!(await isSlackWorkspaceAdmin(userId))) {
      throw new Error("Only a Slack workspace admin can disconnect this app");
    }
    await installationTokenStore.delete(provider);
    return;
  }

  const tokens = await userTokenStore.get(userId, provider);
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
