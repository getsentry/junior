import { definePlugin } from "@oxlint/plugins";

import { boundedFanOutRule } from "./rules/bounded-fan-out.ts";
import { githubGraphqlSchemaRule } from "./rules/github-graphql-schema.ts";
import { noRawSqlQueriesRule } from "./rules/no-raw-sql-queries.ts";
import { noReadOnlyObjectAnnotationsRule } from "./rules/no-read-only-object-annotations.ts";
import { noRegexUrlParsingRule } from "./rules/no-regex-url-parsing.ts";
import { noServiceFallbackRule } from "./rules/no-service-fallback.ts";
import { noValueSwitchRule } from "./rules/no-value-switch.ts";
import { touchConversationDetailRule } from "./rules/touch-conversation-detail.ts";
import { useGitHubApiRule } from "./rules/use-github-api.ts";
import { zodNamespaceImportRule } from "./rules/zod-namespace-import.ts";

/** Oxlint rules for Junior runtime invariants. */
const juniorPlugin = definePlugin({
  meta: { name: "junior" },
  rules: {
    "bounded-fan-out": boundedFanOutRule,
    "github-graphql-schema": githubGraphqlSchemaRule,
    "no-raw-sql-queries": noRawSqlQueriesRule,
    "no-read-only-object-annotations": noReadOnlyObjectAnnotationsRule,
    "no-regex-url-parsing": noRegexUrlParsingRule,
    "no-service-fallback": noServiceFallbackRule,
    "no-value-switch": noValueSwitchRule,
    "touch-conversation-detail": touchConversationDetailRule,
    "use-github-api": useGitHubApiRule,
    "zod-namespace-import": zodNamespaceImportRule,
  },
});

export default juniorPlugin;
