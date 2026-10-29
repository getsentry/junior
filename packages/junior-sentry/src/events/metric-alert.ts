import {
  eventIdentifierSchema,
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

/** The identifier format that `sentryMetricAlertResource` builds. */
export const SENTRY_METRIC_ALERT_IDENTIFIER = eventIdentifierSchema.parse({
  template: "metric-alert:{org}/{alertRuleId}",
  parts: {
    org: { kind: "string", description: "Sentry organization slug" },
    alertRuleId: { kind: "number", description: "Sentry metric alert rule ID" },
  },
});

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
