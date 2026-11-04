import { definePlugin } from "@oxlint/plugins";

import { touchConversationDetailRule } from "./rules/touch-conversation-detail.ts";

/** Oxlint rules for Junior runtime invariants. */
const juniorPlugin = definePlugin({
  meta: { name: "junior" },
  rules: {
    "touch-conversation-detail": touchConversationDetailRule,
  },
});

export default juniorPlugin;
