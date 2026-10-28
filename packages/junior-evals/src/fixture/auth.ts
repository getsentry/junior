/**
 * Authorization for the agent test fixture. The fixture acts as the browser
 * of the person who got an authorization link.
 */
import { createUserTokenStore } from "@/chat/capabilities/factory";
import {
  deleteMcpAuthSessionsForUserProvider,
  deleteMcpServerSessionId,
  deleteMcpStoredOAuthCredentials,
} from "@/chat/mcp/auth-store";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
import type { RequestApp } from "./slack";

/**
 * Open an authorization link that Junior gave the person. The mocked provider
 * redirects to the OAuth or MCP OAuth callback route of the app.
 */
export async function completeAuthorization(args: {
  app: RequestApp;
  /** The link from the dashboard prompt or from a private Slack message. */
  link: string | undefined;
  provider: string;
  /** The person who got the link: a Slack user or a dashboard actor. */
  userId: string;
}): Promise<void> {
  const { link } = args;
  if (!link) {
    throw new Error(`Junior gave ${args.userId} no authorization link`);
  }
  const approval = await fetch(link, { redirect: "manual" });
  const location = approval.headers.get("location");
  if (!location) {
    throw new Error(`The authorization link returned ${approval.status}`);
  }
  const callback = new URL(location);
  if (!callback.pathname.endsWith(`/${args.provider}`)) {
    throw new Error(
      `The authorization link is for ${callback.pathname}, not ${args.provider}`,
    );
  }
  const response = await args.app.request(
    `${callback.pathname}${callback.search}`,
  );
  if (response.status !== 200) {
    throw new Error(
      `The ${args.provider} callback returned ${response.status}: ${await response.text()}`,
    );
  }
}

/**
 * Remove the credentials and the authorization attempts of the people of a
 * test, for each provider of the app. They are in the state store, which
 * tests share. A turn stores an attempt when it asks for authorization, so a
 * person who never completes it leaves data too.
 */
export async function forgetAuthorizations(userIds: string[]): Promise<void> {
  const tokens = createUserTokenStore();
  for (const { manifest } of pluginCatalogRuntime.getProviders()) {
    for (const userId of userIds) {
      await tokens.delete(userId, manifest.name);
      await deleteMcpAuthSessionsForUserProvider(userId, manifest.name);
      await deleteMcpStoredOAuthCredentials(userId, manifest.name);
      await deleteMcpServerSessionId(userId, manifest.name);
    }
  }
}
