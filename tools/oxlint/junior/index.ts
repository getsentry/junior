import { definePlugin } from "@oxlint/plugins";

import { boundedFanOutRule } from "./rules/bounded-fan-out.ts";
import { githubGraphqlSchemaRule } from "./rules/github-graphql-schema.ts";
import { noHandBuiltPromptTagsRule } from "./rules/no-hand-built-prompt-tags.ts";
import { noPromptTagMatchingRule } from "./rules/no-prompt-tag-matching.ts";
import { noPromptTextEscapesRule } from "./rules/no-prompt-text-escapes.ts";
import { noRawSqlQueriesRule } from "./rules/no-raw-sql-queries.ts";
import { noResponseSchemaParseRule } from "./rules/no-response-schema-parse.ts";
import { noReadOnlyObjectAnnotationsRule } from "./rules/no-read-only-object-annotations.ts";
import { noRecordTypeGuardRule } from "./rules/no-record-type-guard.ts";
import { noRegexMarkdownRule } from "./rules/no-regex-markdown.ts";
import { noRegexUrlParsingRule } from "./rules/no-regex-url-parsing.ts";
import { noServiceFallbackRule } from "./rules/no-service-fallback.ts";
import { noValueSwitchRule } from "./rules/no-value-switch.ts";
import { preferMapBoundedRule } from "./rules/prefer-map-bounded.ts";
import { promptTagAttributesRule } from "./rules/prompt-tag-attributes.ts";
import { touchConversationDetailRule } from "./rules/touch-conversation-detail.ts";
import { useGitHubApiRule } from "./rules/use-github-api.ts";
import { zodNamespaceImportRule } from "./rules/zod-namespace-import.ts";

/** Oxlint rules for Junior runtime invariants. */
const juniorPlugin = definePlugin({
  meta: { name: "junior" },
  rules: {
    "bounded-fan-out": boundedFanOutRule,
    "github-graphql-schema": githubGraphqlSchemaRule,
    "no-hand-built-prompt-tags": noHandBuiltPromptTagsRule,
    "no-prompt-tag-matching": noPromptTagMatchingRule,
    "no-prompt-text-escapes": noPromptTextEscapesRule,
    "no-raw-sql-queries": noRawSqlQueriesRule,
    "no-read-only-object-annotations": noReadOnlyObjectAnnotationsRule,
    "no-record-type-guard": noRecordTypeGuardRule,
    "no-response-schema-parse": noResponseSchemaParseRule,
    "no-regex-markdown": noRegexMarkdownRule,
    "no-regex-url-parsing": noRegexUrlParsingRule,
    "no-service-fallback": noServiceFallbackRule,
    "no-value-switch": noValueSwitchRule,
    "prefer-map-bounded": preferMapBoundedRule,
    "prompt-tag-attributes": promptTagAttributesRule,
    "touch-conversation-detail": touchConversationDetailRule,
    "use-github-api": useGitHubApiRule,
    "zod-namespace-import": zodNamespaceImportRule,
  },
});

export default juniorPlugin;
