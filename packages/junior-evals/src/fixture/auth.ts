/**
 * Authorization for the agent test fixture.
 *
 * The fixture acts as the browser of a Slack person. It opens the link that
 * Junior sent to the person in private. The mocked provider approves at once
 * and redirects to the OAuth or MCP OAuth callback route of the app.
 */
import { createUserTokenStore } from "@/chat/capabilities/factory";
import {
  deleteMcpAuthSessionsForUserProvider,
  deleteMcpServerSessionId,
  deleteMcpStoredOAuthCredentials,
} from "@/chat/mcp/auth-store";
import type { RequestApp, SlackAuthorizationLink } from "./slack";

/** The callback routes of the app, by the kind of authorization. */
function callbackPaths(provider: string): string[] {
  return [
    `/api/oauth/callback/${provider}`,
    `/api/oauth/callback/mcp/${provider}`,
  ];
}

/** The callback route that a link sends the person to after approval. */
function callbackPath(link: SlackAuthorizationLink): string | undefined {
  const redirectUri = new URL(link.url).searchParams.get("redirect_uri");
  return redirectUri ? new URL(redirectUri).pathname : undefined;
}

/**
 * Open the newest unused link for `provider` that the person saw, and follow
 * the provider's redirect to the app. The link is used one time.
 */
export async function completeAuthorization(args: {
  app: RequestApp;
  links: SlackAuthorizationLink[];
  provider: string;
  usedUrls: Set<string>;
  userId: string;
}): Promise<void> {
  const paths = callbackPaths(args.provider);
  const link = [...args.links]
    .reverse()
    .find(
      (candidate) =>
        !args.usedUrls.has(candidate.url) &&
        (candidate.userId === undefined || candidate.userId === args.userId) &&
        paths.includes(callbackPath(candidate) ?? ""),
    );
  if (!link) {
    throw new Error(
      `Junior sent ${args.userId} no private authorization link for ${args.provider}`,
    );
  }
  args.usedUrls.add(link.url);
  const approval = await fetch(link.url, { redirect: "manual" });
  const location = approval.headers.get("location");
  if (approval.status !== 302 || !location) {
    throw new Error(
      `The ${args.provider} provider returned ${approval.status} for the authorization link`,
    );
  }
  const callback = new URL(location);
  if (!paths.includes(callback.pathname)) {
    throw new Error(
      `The ${args.provider} provider redirected to ${callback.pathname}`,
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
 * Remove the credentials that a person has for a provider. Credentials are in
 * the state store, which tests share, and not in the test database.
 */
export async function deleteCredentials(
  userId: string,
  provider: string,
): Promise<void> {
  await createUserTokenStore().delete(userId, provider);
  await deleteMcpAuthSessionsForUserProvider(userId, provider);
  await deleteMcpStoredOAuthCredentials(userId, provider);
  await deleteMcpServerSessionId(userId, provider);
}
