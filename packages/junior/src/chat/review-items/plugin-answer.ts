import { createEventAppPublisher } from "@/chat/events/app-publisher";
import {
  createPluginEventPublisher,
  getPlugins,
} from "@/chat/plugins/agent-hooks";
import { basePluginContext } from "@/chat/plugins/hook-context";
import { createPluginState } from "@/chat/plugins/state";
import { PLUGIN_REVIEW_ITEM_KEY_PREFIX, reviewItemPlugin } from "./access";
import type { ReviewItemDelivery } from "./changes";
import { createPluginReviewItems, PLUGIN_CHOICE_FIELD_ID } from "./plugin";
import type { ReviewItem } from "./store";

/**
 * Give the answer of a plugin item with choices to the plugin that added it,
 * so the plugin does the work. The answer starts no Turn. Throws when the
 * plugin fails, so the person can retry the same answer.
 */
export async function answerPluginReviewItem(args: {
  delivery: ReviewItemDelivery;
  item: ReviewItem;
  nowMs: number;
}): Promise<void> {
  const { item } = args;
  const pluginName = reviewItemPlugin(item.dedupeKey);
  const choice = item.answer?.values[PLUGIN_CHOICE_FIELD_ID]?.[0];
  if (!pluginName || !choice) return;
  const plugin = getPlugins().find((p) => p.manifest.name === pluginName);
  const hook = plugin?.hooks?.reviewItemAnswered;
  if (!plugin || !hook) return;
  const events = createEventAppPublisher({
    conversationWork: () => ({ queue: args.delivery.queue }),
  });
  await hook({
    ...basePluginContext(plugin),
    choice,
    conversationId: item.addedByConversationId,
    dedupeKey: item.dedupeKey.slice(
      `${PLUGIN_REVIEW_ITEM_KEY_PREFIX}${pluginName}:`.length,
    ),
    events: createPluginEventPublisher(plugin, events),
    itemId: item.id,
    nowMs: args.nowMs,
    reviewItems: {
      forConversation: (conversationId) =>
        createPluginReviewItems({
          conversationId,
          plugin: pluginName,
          show: args.delivery.show,
        }),
    },
    state: createPluginState(pluginName),
  });
}
