import { getPlugins } from "@/chat/plugins/agent-hooks";
import { CORE_EVENT_NAMESPACE, type EventCatalog } from "@/chat/events/catalog";
import { workspaceSnapshotEvents } from "@/chat/sandbox/snapshot/events";
import {
  SLACK_EVENT_NAMESPACE,
  slackChannelMessageEvents,
} from "@/chat/slack/channel-message-events";

/**
 * Enabled event registrations for search, guidance, and tool schemas.
 *
 * Includes core Workspace snapshot events under the `junior` namespace, Slack
 * channel-message events under the `slack` namespace, plus every enabled plugin
 * registration. Plugins may not use the `junior` or `slack` namespaces.
 */
export function getEventCatalog(): EventCatalog {
  const snapshot = workspaceSnapshotEvents();
  const catalog: Record<string, EventCatalog[string]> = {
    [CORE_EVENT_NAMESPACE]: {
      resourceTypes: [
        ...snapshot.resourceTypes,
        {
          type: "timer",
          supportedEvents: ["timer.fired"],
          suggestedEvents: [],
        },
      ],
      limits: {
        ...snapshot.limits,
        timer: {
          automation: false,
          watch: false,
          watchUnavailableMessage: "Use watchTimer to create a timer Watch.",
        },
      },
    },
    [SLACK_EVENT_NAMESPACE]: slackChannelMessageEvents(),
  };
  for (const plugin of getPlugins()) {
    const registration = plugin.events;
    if (!registration || registration.isEnabled?.() === false) {
      continue;
    }
    if (
      plugin.manifest.name === CORE_EVENT_NAMESPACE ||
      plugin.manifest.name === SLACK_EVENT_NAMESPACE
    ) {
      throw new Error(
        `Plugin "${plugin.manifest.name}" cannot register events; that namespace is reserved for core events`,
      );
    }
    catalog[plugin.manifest.name] = registration;
  }
  return catalog;
}
