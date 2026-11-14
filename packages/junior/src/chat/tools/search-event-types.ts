import {
  agentEventKeys,
  agentEventMatchKey,
  eventMatchFieldSchema,
  type EventReach,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { eventNamespaceSchema, type EventCatalog } from "@/chat/events/catalog";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool, zodToolDefinition } from "@/chat/tool-support/zod-tool";
import { RESOURCE_WATCH_TOOL_SOURCE } from "@/chat/events/tool-support";

const DEFAULT_SEARCH_RESULTS = 10;
const MAX_SEARCH_RESULTS = 20;

const searchedResourceTypeSchema = z
  .object({
    namespace: z.string(),
    type: z.string(),
    identifier_format: z.string().optional(),
    supported_events: z.array(z.string()),
    suggested_events: z.array(z.string()).optional(),
    // Use the plugin contract schema, so new filter field keys such as
    // `events` reach the agent instead of failing this output.
    match_fields: z.record(z.string(), eventMatchFieldSchema).optional(),
  })
  .strict();

// The reach of each event, once for each namespace in the results. Filter
// names are the snake_case match keys that the tools accept.
const searchedNamespaceSchema = z
  .object({
    namespace: z.string(),
    reach: z.record(
      z.string(),
      z.union([
        z.literal("all"),
        z.literal("resource"),
        z.object({ any_of: z.array(z.string()).min(1) }).strict(),
      ]),
    ),
  })
  .strict();

function agentReach(reach: EventReach) {
  return typeof reach === "string"
    ? reach
    : { any_of: reach.anyOf.map(agentEventMatchKey) };
}

const outputSchema = juniorToolOutputSchema
  .extend({
    query: z.string().nullable(),
    namespace: z.string().nullable(),
    total_matches: z.number().int().nonnegative(),
    resource_types: z.array(searchedResourceTypeSchema),
    namespaces: z.array(searchedNamespaceSchema),
  })
  .strict();

function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, " ")
    .trim();
}

// The reach of the events of these resource types, once for each namespace.
function namespaceReach(
  catalog: EventCatalog,
  resourceTypes: readonly { namespace: string; supported_events: string[] }[],
) {
  const events = new Map<string, Set<string>>();
  for (const resourceType of resourceTypes) {
    const set = events.get(resourceType.namespace) ?? new Set<string>();
    for (const eventType of resourceType.supported_events) set.add(eventType);
    events.set(resourceType.namespace, set);
  }
  return [...events].map(([namespace, eventTypes]) => ({
    namespace,
    reach: Object.fromEntries(
      [...eventTypes].sort().flatMap((eventType) => {
        const reach = catalog[namespace]?.events[eventType]?.reach;
        return reach ? [[eventType, agentReach(reach)]] : [];
      }),
    ),
  }));
}

function searchableResourceTypes(catalog: EventCatalog) {
  return Object.entries(catalog)
    .flatMap(([namespace, registration]) =>
      registration.resourceTypes.map((resourceType) => ({
        namespace,
        type: resourceType.type,
        ...(resourceType.identifier
          ? { identifier_format: resourceType.identifier.format }
          : undefined),
        supported_events: [...resourceType.supportedEvents].sort(),
        ...(resourceType.suggestedEvents
          ? { suggested_events: [...resourceType.suggestedEvents].sort() }
          : undefined),
        ...(resourceType.matchFields
          ? { match_fields: agentEventKeys(resourceType.matchFields) }
          : undefined),
      })),
    )
    .sort(
      (left, right) =>
        left.namespace.localeCompare(right.namespace) ||
        left.type.localeCompare(right.type),
    );
}

/** Static definition of `searchEventTypes` for the deployment event catalog. */
export function searchEventTypesToolDefinition(catalog: EventCatalog) {
  return zodToolDefinition({
    exposure: "deferred",
    source: RESOURCE_WATCH_TOOL_SOURCE,
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
    description:
      'Search the event types currently enabled without creating anything. Use only when the user asks what events are supported or the required resource type or event name is unclear. Includes plugin resources and core Workspace snapshot events. namespaces gives the reach of each event. An event automation selects its events with match filters from the match_fields of its namespace. With reach "all", match can be left out to run for every resource. With { any_of }, match must set at least one of those filters. With reach "resource", only watchEvents can use the event. Use watchEvents for temporary updates in the current conversation; use createAutomation with an event trigger for durable automation. This tool does not watch a resource, create an automation, or list concrete resources.',
    inputSchema: z
      .object({
        query: z
          .string()
          .nullable()
          .describe(
            "Optional terms matching a namespace, resource type, or event name. Resource types that match more terms come first. Empty lists all enabled event types.",
          )
          .optional(),
        namespace: eventNamespaceSchema(catalog)
          .nullable()
          .describe("Optional enabled plugin namespace to search within.")
          .optional(),
        max_results: z
          .number()
          .int()
          .min(1)
          .max(MAX_SEARCH_RESULTS)
          .nullable()
          .describe("Maximum matching resource types to return.")
          .optional(),
      })
      .strict(),
    outputSchema,
  });
}

/** Create the read-only tool that searches enabled event types. */
export function createSearchEventTypesTool(catalog: EventCatalog) {
  return zodTool({
    ...searchEventTypesToolDefinition(catalog),
    async execute({ query, namespace, max_results: maxResults }) {
      const normalizedQuery = normalizeSearchText(query ?? "");
      const terms = normalizedQuery.split(/\s+/).filter(Boolean);
      const candidates = searchableResourceTypes(catalog).filter(
        (resourceType) => !namespace || resourceType.namespace === namespace,
      );
      // A query is free text, so words such as "events" name nothing in the
      // catalog. One matching term is enough; more matching terms rank first.
      const matches =
        terms.length === 0
          ? candidates
          : candidates
              .map((resourceType) => {
                const text = normalizeSearchText(
                  [
                    resourceType.namespace,
                    resourceType.type,
                    ...resourceType.supported_events,
                    ...(resourceType.suggested_events ?? []),
                    ...Object.keys(resourceType.match_fields ?? {}),
                  ].join(" "),
                );
                return {
                  resourceType,
                  score: terms.filter((term) => text.includes(term)).length,
                };
              })
              .filter((match) => match.score > 0)
              .sort((left, right) => right.score - left.score)
              .map((match) => match.resourceType);
      const resourceTypes = matches.slice(
        0,
        maxResults ?? DEFAULT_SEARCH_RESULTS,
      );
      const details = {
        query: query ?? null,
        namespace: namespace ?? null,
        total_matches: matches.length,
        resource_types: resourceTypes,
        namespaces: namespaceReach(catalog, resourceTypes),
      };
      return {
        ...details,
      };
    },
  });
}
