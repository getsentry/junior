import { definePlugin } from "@oxlint/plugins";

import { touchConversationDetailRule } from "./rules/touch-conversation-detail.ts";
import { useGitHubApiRule } from "./rules/use-github-api.ts";
import { zodNamespaceImportRule } from "./rules/zod-namespace-import.ts";

/** Oxlint rules for Junior runtime invariants. */
const juniorPlugin = definePlugin({
  meta: { name: "junior" },
  rules: {
    "touch-conversation-detail": touchConversationDetailRule,
    "use-github-api": useGitHubApiRule,
    "zod-namespace-import": zodNamespaceImportRule,
  },
});

export default juniorPlugin;
