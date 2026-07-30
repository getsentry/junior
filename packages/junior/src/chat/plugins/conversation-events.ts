import type {
  ConversationEventPresentation,
  PluginConversationEventDefinition,
  PluginConversationEvents,
  PluginConversationEventValue,
  PluginRegistration,
} from "@sentry/junior-plugin-api";
import { getConversationEventStore } from "@/chat/db";
import { getPlugins } from "./agent-hooks";

function registeredDefinition(
  plugin: PluginRegistration,
  value: PluginConversationEventValue,
): PluginConversationEventDefinition | undefined {
  return plugin.conversationEvents?.find(
    (definition) => definition === value.definition,
  );
}

/** Create a conversation-bound writer for one plugin task operation. */
export function createPluginConversationEvents(args: {
  conversationId: string;
  operationId: string;
  plugin: PluginRegistration;
  turnId: string;
}): PluginConversationEvents {
  return {
    async emit(value) {
      const definition = registeredDefinition(args.plugin, value);
      if (!definition) {
        throw new Error(
          `Plugin "${args.plugin.manifest.name}" cannot emit an unregistered conversation event.`,
        );
      }
      const content = definition.parse(value.data);
      await getConversationEventStore().append(args.conversationId, [
        {
          createdAtMs: Date.now(),
          idempotencyKey:
            `plugin:${args.plugin.manifest.name}:operation:${args.operationId}:` +
            `event:${definition.eventName}@${definition.version}`,
          data: {
            type: "plugin_event",
            namespace: args.plugin.manifest.name,
            name: definition.eventName,
            version: definition.version,
            turnId: args.turnId,
            content,
          },
        },
      ]);
    },
  };
}

/** Render a stored plugin event through its currently registered definition. */
export function renderPluginConversationEvent(args: {
  content: Record<string, unknown>;
  name: string;
  namespace: string;
  version: number;
}): ConversationEventPresentation | undefined {
  const plugin = getPlugins().find(
    (candidate) => candidate.manifest.name === args.namespace,
  );
  const definition = plugin?.conversationEvents?.find(
    (candidate) =>
      candidate.eventName === args.name && candidate.version === args.version,
  );
  if (!definition) return undefined;
  return definition.renderEvent(definition.parse(args.content));
}
