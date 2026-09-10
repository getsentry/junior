import {
  hasEventCatalogEntries,
  type EventCatalog,
} from "@/chat/events/catalog";
import type { ToolRegistry } from "@/chat/tools/definition";
import { createListWatchesTool } from "@/chat/tools/list-watches";
import { createSearchEventTypesTool } from "@/chat/tools/search-event-types";
import { createStopWatchingResourcesTool } from "@/chat/tools/stop-watches";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import { createWatchEventsTool } from "@/chat/tools/watch-events";

/** Build the complete resource-watch tool set for this runtime context. */
export function createEventTools(
  context: ToolRuntimeContext,
  catalog: EventCatalog,
): ToolRegistry {
  const enabled = hasEventCatalogEntries(catalog);
  return {
    ...(enabled
      ? {
          searchEventTypes: createSearchEventTypesTool(catalog),
          watchEvents: createWatchEventsTool(context, catalog),
        }
      : undefined),
    listWatches: createListWatchesTool(context),
    stopWatchingResources: createStopWatchingResourcesTool(context),
  };
}
