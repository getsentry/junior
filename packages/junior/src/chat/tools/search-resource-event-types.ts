import { z } from "zod";
import {
  eventNamespaceSchema,
  type ResourceEventCatalog,
} from "@/chat/resource-events/catalog";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";

const DEFAULT_SEARCH_RESULTS = 10;
const MAX_SEARCH_RESULTS = 20;

const searchedResourceTypeSchema = z
  .object({
    namespace: z.string(),
    type: z.string(),
    supportedEvents: z.array(z.string()),
    suggestedEvents: z.array(z.string()).optional(),
    matchFields: z
      .record(
        z.string(),
        z
          .object({
            kind: z.enum(["boolean", "string", "number"]),
            description: z.string(),
            enum: z.array(z.string()).optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

const outputSchema = juniorToolOutputSchema
  .extend({
    query: z.string().nullable(),
    namespace: z.string().nullable(),
    totalMatches: z.number().int().nonnegative(),
    resourceTypes: z.array(searchedResourceTypeSchema),
  })
  .strict();

function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, " ")
    .trim();
}

function searchableResourceTypes(catalog: ResourceEventCatalog) {
  return Object.entries(catalog)
    .flatMap(([namespace, registration]) =>
      registration.resourceTypes.map((resourceType) => ({
        namespace,
        type: resourceType.type,
        supportedEvents: [...resourceType.supportedEvents].sort(),
        ...(resourceType.suggestedEvents
          ? { suggestedEvents: [...resourceType.suggestedEvents].sort() }
          : undefined),
        ...(resourceType.matchFields
          ? { matchFields: resourceType.matchFields }
          : undefined),
      })),
    )
    .sort(
      (left, right) =>
        left.namespace.localeCompare(right.namespace) ||
        left.type.localeCompare(right.type),
    );
}

/** Create the read-only tool that searches enabled resource event types. */
export function createSearchResourceEventTypesTool(
  catalog: ResourceEventCatalog,
) {
  return zodTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
    description:
      "Search the resource event types currently enabled by plugins without creating anything. Use watchResourceEvents to receive temporary updates in the current Slack thread; use createEventTask to execute a durable instruction for matching events. When explaining results, preserve that distinction. This tool does not watch a resource, create a task, or enumerate concrete resources.",
    inputSchema: z
      .object({
        query: z
          .string()
          .nullable()
          .describe(
            "Optional terms matching a namespace, resource type, or event name. Empty lists all enabled resource event types.",
          )
          .optional(),
        namespace: eventNamespaceSchema(catalog)
          .nullable()
          .describe("Optional enabled plugin namespace to search within.")
          .optional(),
        maxResults: z
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
    async execute({ query, namespace, maxResults }) {
      const normalizedQuery = normalizeSearchText(query ?? "");
      const terms = normalizedQuery.split(/\s+/).filter(Boolean);
      const matches = searchableResourceTypes(catalog).filter(
        (resourceType) => {
          if (namespace && resourceType.namespace !== namespace) return false;
          const text = normalizeSearchText(
            [
              resourceType.namespace,
              resourceType.type,
              ...resourceType.supportedEvents,
              ...(resourceType.suggestedEvents ?? []),
              ...Object.keys(resourceType.matchFields ?? {}),
            ].join(" "),
          );
          return terms.every((term) => text.includes(term));
        },
      );
      const resourceTypes = matches.slice(
        0,
        maxResults ?? DEFAULT_SEARCH_RESULTS,
      );
      const details = {
        query: query ?? null,
        namespace: namespace ?? null,
        totalMatches: matches.length,
        resourceTypes,
      };
      return {
        ...details,
      };
    },
  });
}
