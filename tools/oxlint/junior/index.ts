import { definePlugin } from "@oxlint/plugins";

import { noRawSqlQueriesRule } from "./rules/no-raw-sql-queries.ts";
import { touchConversationDetailRule } from "./rules/touch-conversation-detail.ts";
import { useGitHubApiRule } from "./rules/use-github-api.ts";
import { zodNamespaceImportRule } from "./rules/zod-namespace-import.ts";

/** Oxlint rules for Junior runtime invariants. */
const juniorPlugin = definePlugin({
  meta: { name: "junior" },
  rules: {
    "no-raw-sql-queries": noRawSqlQueriesRule,
    "touch-conversation-detail": touchConversationDetailRule,
    "use-github-api": useGitHubApiRule,
    "zod-namespace-import": zodNamespaceImportRule,
  },
});

export default juniorPlugin;
