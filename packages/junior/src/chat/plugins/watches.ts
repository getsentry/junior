import {
  normalizeEventIdentifier,
  type PluginConversationWatches,
  type PluginEventToolContext,
  type PluginRegistration,
} from "@sentry/junior-plugin-api";
import { createWatch, listWatches, turnEvents } from "@/chat/events/store";
import { RESOURCE_SUBSCRIPTION_DEFAULT_TTL_MS } from "@/chat/events/tool-support";

/**
 * Let a plugin create Watches for one Conversation on its own resources,
 * from a tool or from the answer to one of its Review items.
 */
export function createPluginWatches(
  plugin: PluginRegistration,
  conversationId: string,
): PluginEventToolContext {
  const pluginName = plugin.manifest.name;
  const canSubscribe =
    Boolean(plugin.events) && plugin.events?.isEnabled?.() !== false;
  return {
    canSubscribe,
    async subscribe(input) {
      if (!canSubscribe) {
        throw new Error("Watches are not available in this conversation.");
      }
      const registration = plugin.events;
      const resourceType = registration?.resourceTypes.find(
        (candidate) => candidate.type === input.resource.type,
      );
      if (
        input.resource.namespace !== pluginName ||
        !resourceType ||
        input.events.length === 0 ||
        input.events.some(
          (eventType) => !resourceType.supportedEvents.includes(eventType),
        )
      ) {
        throw new Error(
          "Watch contains an event or resource that the plugin does not support.",
        );
      }
      const subscription = await createWatch({
        conversationId,
        events: input.events,
        expiresAtMs: Date.now() + RESOURCE_SUBSCRIPTION_DEFAULT_TTL_MS,
        guidance: input.guidance,
        intent: input.intent,
        label: input.resource.label,
        namespace: pluginName,
        identifier: normalizeEventIdentifier(
          registration,
          input.resource.identifier,
        ),
        quietEvents: input.quietEvents,
        resourceType: input.resource.type,
      });
      // Quiet Events never wake the Conversation, so the agent does not
      // count on them. It can still watch them with watchEvents.
      return {
        events: turnEvents(subscription),
        id: subscription.id,
      };
    },
  };
}

/**
 * Let a plugin read and create the Watches of one Conversation outside a
 * tool call, such as when a person answers one of its Review items.
 */
export function createPluginConversationWatches(
  plugin: PluginRegistration,
  conversationId: string,
): PluginConversationWatches {
  return {
    ...createPluginWatches(plugin, conversationId),
    async watching({ eventType, identifier }) {
      const normalized = normalizeEventIdentifier(plugin.events, identifier);
      const watches = await listWatches({ conversationId });
      return watches.some(
        (watch) =>
          watch.namespace === plugin.manifest.name &&
          watch.identifier === normalized &&
          turnEvents(watch).includes(eventType),
      );
    },
  };
}
