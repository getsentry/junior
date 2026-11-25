import type { PromptHistory } from "@sentry/junior-plugin-api";
import { getConversationEventStore } from "@/chat/db";
import { withSpan } from "@/chat/logging";

/**
 * Load one plugin's prompt contexts in the model history that the next
 * prompt replays. A History replacement starts a new History version, and
 * Turn context events of older versions are no longer in the model's
 * context.
 *
 * Span `plugin.prompt_history.load` times the read.
 * `app.prompt_history.row.count` counts the Turn context rows read, for
 * every plugin, and `app.prompt_history.context.count` counts the contexts
 * returned to this plugin.
 */
export async function loadPluginPromptHistory(args: {
  conversationId: string;
  pluginName: string;
}): Promise<PromptHistory> {
  return await withSpan(
    "plugin.prompt_history.load",
    "plugin.prompt_history.load",
    { conversationId: args.conversationId },
    async (setSpanAttributes) => {
      const eventStore = getConversationEventStore();
      const [replacement, contextEvents] = await Promise.all([
        // Retired handoff rows also start a History version.
        eventStore.loadLatestEventOfTypes(args.conversationId, [
          "compaction",
          "handoff",
        ]),
        eventStore.loadCurrentEventsOfType(args.conversationId, "turn_context"),
      ]);
      const contexts = contextEvents.flatMap((event) =>
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
      );
      setSpanAttributes({
        "app.plugin.name": args.pluginName,
        "app.prompt_history.row.count": contextEvents.length,
        "app.prompt_history.context.count": contexts.length,
      });
      return {
        ...(replacement ? { startedAtMs: replacement.createdAtMs } : undefined),
        contexts,
      };
    },
  );
}
