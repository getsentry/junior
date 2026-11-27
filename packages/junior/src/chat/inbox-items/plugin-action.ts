import { createPluginCodeChanges } from "@/chat/code/plugin-code-changes";
import { createEventAppPublisher } from "@/chat/events/app-publisher";
import { getPlugins } from "@/chat/plugins/hooks/registry";
import { createPluginEventPublisher } from "@/chat/plugins/hooks/routes";
import { basePluginContext } from "@/chat/plugins/hook-context";
import { createPluginState } from "@/chat/plugins/state";
import { createPluginConversationWatches } from "@/chat/plugins/watches";
import { inboxItemPlugin } from "./access";
import type { InboxItemDelivery } from "./changes";
import { createPluginInboxItems } from "./plugin";
import { ownerConversationId, type InboxItem } from "./store";

/**
 * Give a kind action that a person ran on a plugin item to the plugin that
 * added it, so the plugin does the work. The action starts no Turn. Throws
 * when the plugin fails, so the person can retry the same action.
 */
export async function runPluginInboxItemAction(args: {
  action: string;
  delivery: InboxItemDelivery;
  item: InboxItem;
  nowMs: number;
}): Promise<void> {
  const { item } = args;
  const pluginName = inboxItemPlugin(item);
  // A plugin adds items only for a Conversation.
  const conversationId = ownerConversationId(item);
  if (!pluginName || !conversationId) return;
  const plugin = getPlugins().find((p) => p.manifest.name === pluginName);
  const hook = plugin?.hooks?.inboxItemAction;
  if (!plugin || !hook) return;
  const events = createEventAppPublisher({
    conversationWork: () => ({ queue: args.delivery.queue }),
  });
  await hook({
    ...basePluginContext(plugin),
    action: args.action,
    codeChanges: createPluginCodeChanges(pluginName),
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
    watches: createPluginConversationWatches(plugin, conversationId),
  });
}
