import {
  eventMatchFieldsSchema,
  type EventMatchFields,
} from "@sentry/junior-plugin-api";
import * as z from "zod";

/**
 * A project slug in event data. It is lowercase, the same form as
 * identifiers, because the plugin lowercases every identifier.
 */
export const sentrySlugDataSchema = z.string().min(1).toLowerCase();

/**
 * Filter on the org and the projects of a Sentry event. `projects` is a list
 * on every event, so one filter fits an issue, which has one project, and a
 * metric alert, whose rule can cover several projects.
 *
 * Project slugs repeat across orgs, and each org that installs the public
 * integration sends its own events. So a trigger with no identifier must
 * filter on `org`, or it would run for every org.
 */
export function sentryScopeMatchFields(
  events: readonly string[],
): EventMatchFields {
  return eventMatchFieldsSchema.parse({
    org: {
      kind: "string",
      case: "lower",
      description: "lowercase Sentry org slug, such as sentry",
      events,
    },
    projects: {
      kind: "string",
      case: "lower",
      list: true,
      description:
        "lowercase Sentry project slugs, such as junior; an issue has one, a metric alert has the projects of its rule",
      events,
    },
  });
}
