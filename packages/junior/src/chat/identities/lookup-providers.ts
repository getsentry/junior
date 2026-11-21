import { getOAuthAccountProviders } from "@/chat/plugins/credential-hooks";
import { getUserSearchProviders } from "@/chat/plugins/user-search-hooks";

/**
 * Identity providers that `userLookup` can search: Slack, then providers
 * whose plugin verifies OAuth accounts or searches its accounts.
 */
export function userLookupIdentityProviders(): [string, ...string[]] {
  const plugins = new Set([
    ...getOAuthAccountProviders(),
    ...getUserSearchProviders(),
  ]);
  plugins.delete("slack");
  return ["slack", ...plugins];
}
