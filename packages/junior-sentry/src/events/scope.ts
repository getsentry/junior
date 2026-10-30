import {
  eventMatchFieldsSchema,
  type EventMatchFields,
} from "@sentry/junior-plugin-api";
import { z } from "zod";

/**
 * A project slug in event data. It is lowercase, the same form as
 * identifiers, because the plugin lowercases every identifier.
 */
export const sentrySlugDataSchema = z.string().min(1).toLowerCase();

/**
 * Filter on the projects of a Sentry event. `projects` is a list on every
 * event, so one filter fits an issue, which has one project, and a metric
 * alert, whose rule can cover several projects.
 *
 * There is no `org` filter. One Sentry integration belongs to one org, and
 * its webhook secret scopes every delivery to that org. So `org` is the same
 * on every event of an install, and a filter on it cannot narrow anything.
 */
export function sentryProjectsMatchFields(
  events: readonly string[],
): EventMatchFields {
  return eventMatchFieldsSchema.parse({
    projects: {
      kind: "string",
      list: true,
      description:
        "lowercase Sentry project slugs, such as junior; an issue has one, a metric alert has the projects of its rule",
      events,
    },
  });
}
