import type { LocationConfigurationService } from "@/chat/configuration/types";
import type { Location } from "@/chat/conversations/location";
import { getLocationConfigurationService } from "@/chat/runtime/thread-state";

/**
 * Resolve durable configuration for one stored Conversation Location. Use it
 * when a Run has a Location but no Destination for that place, such as a
 * person's Turn in a Thread, which reads its root's Location.
 */
export function getLocationConfigurationServiceForLocation(
  location: Location,
): LocationConfigurationService {
  // Slack configuration rows are keyed by workspace and channel.
  return getLocationConfigurationService({
    platform: "slack",
    teamId: location.teamId,
    channelId: location.channelId,
  });
}
