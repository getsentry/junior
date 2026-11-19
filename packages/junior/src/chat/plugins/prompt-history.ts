import type { PromptHistory } from "@sentry/junior-plugin-api";
import { getConversationEventStore } from "@/chat/db";

/**
 * Load one plugin's prompt contexts in the model history that the next
 * prompt replays. A History replacement starts a new History version, and
 * Turn context events of older versions are no longer in the model's
 * context.
 */
export async function loadPluginPromptHistory(args: {
  conversationId: string;
  pluginName: string;
}): Promise<PromptHistory> {
  const eventStore = getConversationEventStore();
  const [replacements, contextEvents] = await Promise.all([
    // Retired handoff rows also start a History version.
    eventStore.query(args.conversationId, {
      limit: 1,
      types: ["compaction", "handoff"],
    }),
    eventStore.loadCurrentEventsOfType(args.conversationId, "turn_context"),
  ]);
  const replacement = replacements.events[0];
  return {
    ...(replacement ? { startedAtMs: replacement.createdAtMs } : undefined),
    contexts: contextEvents.flatMap((event) =>
      event.data.type === "turn_context" &&
      event.data.pluginName === args.pluginName
        ? [
            {
              content: event.data.content,
              kind: event.data.kind,
              loadedAtMs: event.createdAtMs,
              version: event.data.version,
            },
          ]
        : [],
    ),
  };
}
