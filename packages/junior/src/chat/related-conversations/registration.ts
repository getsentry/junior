import type { PluginRegistration } from "@sentry/junior-plugin-api";
import { findRelatedConversations } from "./find";

/**
 * Core feature that adds open Conversations about the same work to a
 * person's first request in a root Conversation. A failure reaches the
 * prompt hook host, which logs it and runs the Turn without this context.
 */
export const relatedConversationsRegistration: PluginRegistration = {
  manifest: {
    name: "related-conversations",
    displayName: "Related conversations",
    description: "Open conversations about the same work as a new request",
  },
  hooks: {
    userPrompt: findRelatedConversations,
  },
};
