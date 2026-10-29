import {
  eventMatchFieldsSchema,
  type SubscribableResource,
} from "@sentry/junior-plugin-api";

/** Metric alert states, named after Sentry's `metric_alert.<action>` webhooks. */
export const SENTRY_METRIC_ALERT_EVENTS = [
  "metric_alert.critical",
  "metric_alert.warning",
  "metric_alert.resolved",
] as const;

export const SENTRY_METRIC_ALERT_SUGGESTED_EVENTS = [
  "metric_alert.critical",
  "metric_alert.warning",
];

/** Trusted values that every Sentry metric alert event sets. */
export const SENTRY_METRIC_ALERT_MATCH_FIELDS = eventMatchFieldsSchema.parse({
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
