import type { ResourceEventCatalog } from "@/chat/resource-events/catalog";
import {
  canHoldResourceEventSubscription,
  canUseResourceEventSubscriptionTools,
} from "@/chat/resource-events/tool-support";
import type { ToolRegistry } from "@/chat/tools/definition";
import { createListResourceEventSubscriptionsTool } from "@/chat/tools/list-resource-event-subscriptions";
import { createSearchResourceEventTypesTool } from "@/chat/tools/search-resource-event-types";
import { createStopWatchingResourcesTool } from "@/chat/tools/stop-watching-resources";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import { createWatchResourceEventsTool } from "@/chat/tools/watch-resource-events";

/** Build the complete resource-watch tool set allowed by this runtime context. */
export function createResourceEventTools(
  context: ToolRuntimeContext,
  catalog: ResourceEventCatalog,
): ToolRegistry {
  const enabled = Object.keys(catalog).length > 0;
  const discoveryTools: ToolRegistry =
    canHoldResourceEventSubscription(context.conversationId) && enabled
      ? {
          searchResourceEventTypes: createSearchResourceEventTypesTool(catalog),
        }
      : {};
  if (!canUseResourceEventSubscriptionTools(context)) {
    return discoveryTools;
  }

  return {
    ...discoveryTools,
    ...(enabled
      ? {
          watchResourceEvents: createWatchResourceEventsTool(context, catalog),
        }
      : undefined),
    listResourceEventSubscriptions:
      createListResourceEventSubscriptionsTool(context),
    stopWatchingResources: createStopWatchingResourcesTool(context),
  };
}
