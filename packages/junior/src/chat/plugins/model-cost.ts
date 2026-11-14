import { pluginModelCostEventNames } from "@sentry/junior-plugin-api";
import { getConversationEventStore } from "@/chat/db";
import { logException } from "@/chat/logging";
import type { PluginModelCostRecorder } from "@/chat/plugins/model";

/** Plugin context that made a model call. It names the cost event. */
export type PluginModelCostSource = keyof typeof pluginModelCostEventNames;

/**
 * Bind plugin model cost to one Conversation. Each priced call becomes an
 * event in the plugin's namespace, so Conversation cost counts it without
 * the plugin reporting it. A failed write is logged, not thrown, so it
 * cannot discard a model result that already succeeded.
 */
export function createPluginModelCostRecorder(args: {
  conversationId: string;
  pluginName: string;
  source: PluginModelCostSource;
  toolName?: string;
  turnId?: string;
}): PluginModelCostRecorder {
  return async ({ costUsd, modelRole }) => {
    try {
      await getConversationEventStore().append(
        args.conversationId,
        [
          {
            createdAtMs: Date.now(),
            data: {
              type: "structured_event",
              namespace: args.pluginName,
              name: pluginModelCostEventNames[args.source],
              version: 1,
              ...(args.turnId ? { turnId: args.turnId } : undefined),
              content: {
                costUsd,
                modelRole,
                ...(args.toolName ? { toolName: args.toolName } : undefined),
              },
            },
          },
        ],
        { activity: "preserve" },
      );
    } catch (error) {
      // best-effort: decision (secondary write). The model call already ran and
      // is paid for; a throw would discard its result and pay again on retry.
      // See the PR decisions.
      logException(error, "plugin.model_cost.record.failed", {
        "app.plugin.name": args.pluginName,
        "gen_ai.tool.name": args.toolName,
      });
    }
  };
}
