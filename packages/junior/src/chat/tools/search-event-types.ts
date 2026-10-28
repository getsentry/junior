import { z } from "zod";
import { eventNamespaceSchema, type EventCatalog } from "@/chat/events/catalog";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";

const DEFAULT_SEARCH_RESULTS = 10;
const MAX_SEARCH_RESULTS = 20;

const searchedResourceTypeSchema = z
  .object({
    namespace: z.string(),
    type: z.string(),
    identifierFormat: z.string().optional(),
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

function searchableResourceTypes(catalog: EventCatalog) {
  return Object.entries(catalog)
    .flatMap(([namespace, registration]) =>
      registration.resourceTypes.map((resourceType) => ({
        namespace,
        type: resourceType.type,
        ...(resourceType.identifier
          ? { identifierFormat: resourceType.identifier.format }
          : undefined),
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

/** Create the read-only tool that searches enabled event types. */
export function createSearchEventTypesTool(catalog: EventCatalog) {
  return zodTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
    description:
      "Search the event types currently enabled without creating anything. Includes plugin resources and core Workspace snapshot events. Use watchEvents for temporary updates in the current conversation; use createEventAutomation for durable automation. This tool does not watch a resource, create an automation, or list concrete resources.",
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
                    ...resourceType.supportedEvents,
                    ...(resourceType.suggestedEvents ?? []),
                    ...Object.keys(resourceType.matchFields ?? {}),
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
        totalMatches: matches.length,
        resourceTypes,
      };
      return {
        ...details,
      };
    },
  });
}
