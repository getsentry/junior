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

/** Keep operation idempotency stable when a registered event schema advances. */
function eventIdentityVersion(
  plugin: PluginRegistration,
  definition: PluginConversationEventDefinition,
): number {
  let version = definition.version;
  for (const candidate of plugin.conversationEvents ?? []) {
    if (candidate.eventName === definition.eventName) {
      version = Math.min(version, candidate.version);
    }
  }
  return version;
}

/** Create a conversation-bound writer for one plugin operation. */
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
      const identityVersion = eventIdentityVersion(args.plugin, definition);
      await getConversationEventStore().append(
        args.conversationId,
        [
          {
            createdAtMs: Date.now(),
            idempotencyKey:
              `plugin:${args.plugin.manifest.name}:operation:${args.operationId}:` +
              `event:${definition.eventName}@${identityVersion}`,
            data: {
              type: "structured_event",
              namespace: args.plugin.manifest.name,
              name: definition.eventName,
              version: definition.version,
              turnId: args.turnId,
              content,
            },
          },
        ],
        { activity: "preserve" },
      );
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
