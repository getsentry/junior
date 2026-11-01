import {
  eventDataSchema,
  eventInputSchema,
  normalizeEventIdentifier,
  type EventPublisher,
  type PluginRegistration,
} from "@sentry/junior-plugin-api";
import type { EventAppPublisher } from "@/chat/events/app-publisher";

/** Core event delivery that plugin event publishers wrap. */
export type CoreEventPublisher = Pick<EventAppPublisher, "publish"> &
  Partial<Pick<EventAppPublisher, "hasMatch" | "neededMatchKeys">>;

function requirePublishedEvent(
  plugin: PluginRegistration,
  eventType: string,
): void {
  const registration = plugin.events;
  if (!registration || registration.isEnabled?.() === false) {
    throw new Error(
      `Plugin "${plugin.manifest.name}" cannot publish events without an active registration`,
    );
  }
  if (
    !registration.resourceTypes.some((resourceType) =>
      resourceType.supportedEvents.includes(eventType),
    )
  ) {
    throw new Error(
      `Plugin "${plugin.manifest.name}" did not register event "${eventType}"`,
    );
  }
}

/**
 * Scope core event delivery to one plugin.
 *
 * Events go out under the plugin namespace with normalized identifiers, and
 * only for event types the plugin registered.
 */
export function createPluginEventPublisher(
  plugin: PluginRegistration,
  events: CoreEventPublisher,
): EventPublisher {
  const pluginName = plugin.manifest.name;
  return {
    async hasMatch(event) {
      if (!events.hasMatch) return false;
      const parsed = eventInputSchema.parse(event);
      requirePublishedEvent(plugin, parsed.eventType);
      return await events.hasMatch({
        ...parsed,
        identifier: normalizeEventIdentifier(plugin.events, parsed.identifier),
        namespace: pluginName,
      });
    },
    async neededMatchKeys(input) {
      if (!events.neededMatchKeys) return [];
      const identifiers = [
        ...new Set(
          input.identifiers
            .map((identifier) =>
              normalizeEventIdentifier(plugin.events, identifier),
            )
            .filter(Boolean),
        ),
      ];
      if (identifiers.length === 0 || input.eventTypes.length === 0) {
        return [];
      }
      return await events.neededMatchKeys({
        ...(input.data
          ? { data: eventDataSchema.parse(input.data) }
          : undefined),
        eventTypes: input.eventTypes,
        identifiers,
        namespace: pluginName,
      });
    },
    async publish(event) {
      const parsed = eventInputSchema.parse(event);
      requirePublishedEvent(plugin, parsed.eventType);
      await events.publish({
        ...parsed,
        identifier: normalizeEventIdentifier(plugin.events, parsed.identifier),
        namespace: pluginName,
      });
    },
  };
}
