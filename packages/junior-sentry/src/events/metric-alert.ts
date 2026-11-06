import {
  eventMatchFieldsSchema,
  type SubscribableResource,
} from "@sentry/junior-plugin-api";
import { sentryProjectsMatchFields } from "./scope.js";

/** The `action` values of Sentry metric alert webhooks. */
export const SENTRY_METRIC_ALERT_ACTIONS = [
  "critical",
  "warning",
  "resolved",
] as const;

/** Metric alert states, named after Sentry's `metric_alert.<action>` webhooks. */
export const SENTRY_METRIC_ALERT_EVENTS = [
  "metric_alert.critical",
  "metric_alert.warning",
  "metric_alert.resolved",
] as const satisfies readonly `metric_alert.${(typeof SENTRY_METRIC_ALERT_ACTIONS)[number]}`[];

export const SENTRY_METRIC_ALERT_SUGGESTED_EVENTS = [
  "metric_alert.critical",
  "metric_alert.warning",
];

/**
 * Trusted values that Sentry metric alert events set. `projects` is missing
 * when the rule lists no projects or too many to fit in event data.
 */
export const SENTRY_METRIC_ALERT_MATCH_FIELDS = eventMatchFieldsSchema.parse({
  ...sentryProjectsMatchFields(SENTRY_METRIC_ALERT_EVENTS),
  alertRuleId: {
    kind: "string",
    description: "id of the Sentry metric alert rule, such as 7",
    events: [...SENTRY_METRIC_ALERT_EVENTS],
  },
});

/** The identifier shape that `sentryMetricAlertResource` builds. */
export const SENTRY_METRIC_ALERT_IDENTIFIER = {
  format: "metric-alert:org/alertRuleId",
  pattern: String.raw`^metric-alert:[^\s/:#]+\/\d+$`,
};

/** Build the stable Sentry metric alert identity shared by tools and webhooks. */
export function sentryMetricAlertResource(input: {
  alertRuleId: string;
  org: string;
}): Pick<SubscribableResource, "identifier" | "label" | "namespace"> {
  return {
    identifier: `metric-alert:${input.org}/${input.alertRuleId}`,
    label: `Sentry metric alert ${input.org}/${input.alertRuleId}`,
    namespace: "sentry",
  };
}
