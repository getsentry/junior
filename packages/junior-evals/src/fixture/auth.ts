/**
 * Authorization for the agent test fixture. The fixture acts as the browser
 * of the Slack person who got an authorization link.
 */
import { onTestFinished } from "vitest";
import { createUserTokenStore } from "@/chat/capabilities/factory";
import {
  deleteMcpAuthSessionsForUserProvider,
  deleteMcpServerSessionId,
  deleteMcpStoredOAuthCredentials,
} from "@/chat/mcp/auth-store";
import type { RequestApp } from "./slack";

/**
 * Open the newest authorization link that Junior sent to the person. The
 * mocked provider redirects to the OAuth or MCP OAuth callback route of the
 * app.
 */
export async function completeAuthorization(args: {
  app: RequestApp;
  /** The links that Junior sent to the person in private, oldest first. */
  links: string[];
  provider: string;
  userId: string;
}): Promise<void> {
  const link = args.links.at(-1);
  if (!link) {
    throw new Error(`Junior sent ${args.userId} no private authorization link`);
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
  // Credentials are in the state store, which tests share.
  onTestFinished(async () => {
    await createUserTokenStore().delete(args.userId, args.provider);
    await deleteMcpAuthSessionsForUserProvider(args.userId, args.provider);
    await deleteMcpStoredOAuthCredentials(args.userId, args.provider);
    await deleteMcpServerSessionId(args.userId, args.provider);
  });
  const response = await args.app.request(
    `${callback.pathname}${callback.search}`,
  );
  if (response.status !== 200) {
    throw new Error(
      `The ${args.provider} callback returned ${response.status}: ${await response.text()}`,
    );
  }
}
