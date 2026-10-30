import {
  eventMatchFieldsSchema,
  type EventMatchFields,
} from "@sentry/junior-plugin-api";
import { z } from "zod";

/**
 * An org or project slug in event data. It is lowercase, the same form as
 * identifiers, because the plugin lowercases every identifier.
 */
export const sentrySlugDataSchema = z.string().min(1).toLowerCase();

/**
 * Filters on the org and projects of a Sentry event. `projects` is a list on
 * every event, so one filter fits an issue, which has one project, and a
 * metric alert, whose rule can cover several projects.
 */
export function sentryScopeMatchFields(
  events: readonly string[],
): EventMatchFields {
  return eventMatchFieldsSchema.parse({
    org: {
      kind: "string",
      description: "lowercase Sentry organization slug, such as sentry",
      events,
    },
    projects: {
      kind: "string",
      list: true,
      description:
        "lowercase Sentry project slugs, such as junior; an issue has one, a metric alert has the projects of its rule",
      events,
    },
  });
}
