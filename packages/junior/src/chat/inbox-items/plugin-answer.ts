import { createEventAppPublisher } from "@/chat/events/app-publisher";
import {
  createPluginEventPublisher,
  getPlugins,
} from "@/chat/plugins/agent-hooks";
import { basePluginContext } from "@/chat/plugins/hook-context";
import { createPluginState } from "@/chat/plugins/state";
import { createPluginUsers } from "@/chat/plugins/viewer";
import type { UserInputAnswer } from "@/chat/inbox-items/user-input-request";
import { createPluginConversationWatches } from "@/chat/plugins/watches";
import { inboxItemPlugin } from "./access";
import type { InboxItemDelivery } from "./changes";
import { createPluginInboxItems, PLUGIN_CHOICE_FIELD_ID } from "./plugin";
import { ownerConversationId, type InboxItem } from "./store";

/**
 * Give a person's choice on a plugin item to the plugin that added it, so
 * the plugin does the work and changes the item. The answer starts no Turn.
 * Throws when the plugin fails, so the person can retry the same answer.
 */
export async function answerPluginInboxItem(args: {
  answer: UserInputAnswer;
  delivery: InboxItemDelivery;
  item: InboxItem;
  nowMs: number;
}): Promise<void> {
  const { item } = args;
  const pluginName = inboxItemPlugin(item);
  const choice = args.answer.values[PLUGIN_CHOICE_FIELD_ID]?.[0];
  // A plugin adds items only for a Conversation.
  const conversationId = ownerConversationId(item);
  if (!pluginName || !choice || !conversationId) return;
  const plugin = getPlugins().find((p) => p.manifest.name === pluginName);
  const hook = plugin?.hooks?.inboxItemAnswered;
  if (!plugin || !hook) return;
  const events = createEventAppPublisher({
    conversationWork: () => ({ queue: args.delivery.queue }),
  });
  await hook({
    ...basePluginContext(plugin),
    choice,
    conversationId,
    subject: {
      id: item.subject.id,
      kind: item.subject.kind.slice(pluginName.length + 1),
    },
    events: createPluginEventPublisher(plugin, events),
    itemId: item.id,
    nowMs: args.nowMs,
    inboxItems: {
      forConversation: (conversationId) =>
        createPluginInboxItems({
          conversationId,
          plugin: pluginName,
          show: args.delivery.show,
        }),
    },
    state: createPluginState(pluginName),
    users: createPluginUsers(pluginName),
    watches: createPluginConversationWatches(plugin, conversationId),
  });
}
