import type { User } from "@sentry/junior-plugin-api";
import { getSqlExecutor } from "@/chat/db";
import { resolveActorIdentityId } from "@/chat/identities/actor";
import { createPluginCodeChanges } from "@/chat/code/plugin-code-changes";
import { createEventAppPublisher } from "@/chat/events/app-publisher";
import { getPlugins } from "@/chat/plugins/hooks/registry";
import { createPluginEventPublisher } from "@/chat/plugins/hooks/routes";
import { basePluginContext } from "@/chat/plugins/hook-context";
import { createPluginState } from "@/chat/plugins/state";
import { createPluginConversationWatches } from "@/chat/plugins/watches";
import { inboxItemPlugin } from "./access";
import type { InboxItemDelivery } from "./changes";
import { createPluginInboxItems, PLUGIN_CHOICE_FIELD_ID } from "./plugin";
import { ownerConversationId, type InboxItem } from "./store";

/**
 * Give the answer of a plugin item with choices to the plugin that added it,
 * so the plugin does the work. The answer starts no Turn. Throws when the
 * plugin fails, so the person can retry the same answer.
 */
export async function answerPluginInboxItem(args: {
  delivery: InboxItemDelivery;
  item: InboxItem;
  nowMs: number;
  /** The person who answered. A Watch that the plugin sets serves them. */
  user: User;
}): Promise<void> {
  const { item } = args;
  const pluginName = inboxItemPlugin(item);
  const choice = item.answer?.values[PLUGIN_CHOICE_FIELD_ID]?.[0];
  // A plugin adds items only for a Conversation.
  const conversationId = ownerConversationId(item);
  if (!pluginName || !choice || !conversationId) return;
  const plugin = getPlugins().find((p) => p.manifest.name === pluginName);
  const hook = plugin?.hooks?.inboxItemAnswered;
  if (!plugin || !hook) return;
  // Store the answerer's Identity, as a dashboard Turn does, so a Watch
  // Turn finds their lines and their own linked accounts.
  const answerer = {
    platform: "web" as const,
    email: args.user.email,
    userId: args.user.id,
  };
  await resolveActorIdentityId(getSqlExecutor(), answerer);
  const events = createEventAppPublisher({
    conversationWork: () => ({ queue: args.delivery.queue }),
  });
  await hook({
    ...basePluginContext(plugin),
    choice,
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
    watches: createPluginConversationWatches(plugin, conversationId, {
      actor: answerer,
    }),
  });
}
