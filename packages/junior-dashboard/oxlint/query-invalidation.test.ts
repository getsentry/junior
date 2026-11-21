import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";

import {
  noBroadQueryInvalidationRule,
  noRefetchIntervalRule,
} from "./query-invalidation.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const broadKey = [{ messageId: "broadKey" }];
const noKey = [{ messageId: "noKey" }];

new RuleTester({
  languageOptions: { parserOptions: { lang: "tsx" } },
}).run("no-broad-query-invalidation", noBroadQueryInvalidationRule, {
  valid: [
    "queryClient.invalidateQueries({ queryKey: inboxItemListQueryKey(filters) });",
    "queryClient.invalidateQueries({ exact: true, queryKey: KEY });",
    `queryClient.invalidateQueries({ queryKey: ["dashboard", "plugin-user-page", name] });`,
    `const PREFIX = ["dashboard", "inbox-items"] as const;
    queryClient.invalidateQueries({ queryKey: [...PREFIX, "count"] });`,
    `queryClient.invalidateQueries({ queryKey: [...IMPORTED_PREFIX, "count"] });`,
    `const key = conversationDetailQueryKey(id);
    queryClient.resetQueries({ queryKey: key });`,
    "queryClient.invalidateQueries({ predicate: isTreeArchiveRead });",
    // Filters from elsewhere are not checked here.
    "queryClient.invalidateQueries(filters);",
    // Cancel and set do not start requests.
    `queryClient.cancelQueries({ queryKey: ["dashboard", "conversations"] });`,
    `queryClient.setQueriesData({ queryKey: ["dashboard", "conversations"] }, update);`,
  ],
  invalid: [
    {
      code: `queryClient.invalidateQueries({ queryKey: ["dashboard", "conversations"] });`,
      errors: broadKey,
    },
    {
      code: `client.refetchQueries({ queryKey: ["dashboard"] });`,
      errors: broadKey,
    },
    {
      code: `const feeds = { queryKey: ["dashboard", "conversations"] };
      queryClient.invalidateQueries(feeds);`,
      errors: broadKey,
    },
    {
      code: `const PREFIX = ["dashboard", "inbox-items"] as const;
      queryClient.removeQueries({ queryKey: PREFIX });`,
      errors: broadKey,
    },
    {
      code: "queryClient.invalidateQueries({ queryKey: INBOX_ITEMS_QUERY_KEY });",
      errors: broadKey,
    },
    {
      code: "queryClient.resetQueries({ queryKey: [...IMPORTED_PREFIX] });",
      errors: broadKey,
    },
    { code: "queryClient.invalidateQueries();", errors: noKey },
    {
      code: 'queryClient.invalidateQueries({ type: "active" });',
      errors: noKey,
    },
  ],
});

const poll = [{ messageId: "poll" }];

new RuleTester({
  languageOptions: { parserOptions: { lang: "tsx" } },
}).run("no-refetch-interval", noRefetchIntervalRule, {
  valid: [
    "useQuery({ queryKey, queryFn, staleTime: 30_000 });",
    "const refetchInterval = 1_000;",
    "options[refetchInterval] = 1_000;",
  ],
  invalid: [
    {
      code: "useQuery({ queryKey, queryFn, refetchInterval: 5_000 });",
      errors: poll,
    },
    { code: "useQuery({ queryKey, queryFn, refetchInterval });", errors: poll },
    {
      code: `const options = { "refetchInterval": () => 1_000 };`,
      errors: poll,
    },
  ],
});
