import { getOAuthAccountProviders } from "@/chat/plugins/credential-hooks";

/** Identity providers that `userLookup` can search: Slack, then OAuth account providers. */
export function userLookupIdentityProviders(): [string, ...string[]] {
  return [
    "slack",
    ...getOAuthAccountProviders().filter((provider) => provider !== "slack"),
  ];
}
