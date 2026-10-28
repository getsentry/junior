import type { EventInput } from "@sentry/junior-plugin-api";
import { z } from "zod";
import { sentryIssueResource, sentryProjectResource } from "../events/issue.js";
import {
  SENTRY_METRIC_ALERT_EVENTS,
  sentryMetricAlertResource,
} from "../events/metric-alert.js";

const issueWebhookSchema = z
  .object({
    action: z.string(),
    data: z.object({
      issue: z
        .object({
          culprit: z.string().optional(),
          firstSeen: z.string().optional(),
          id: z.string().min(1),
          issueCategory: z.string().optional(),
          issueType: z.string().optional(),
          level: z.string().optional(),
          priority: z.string().optional(),
          project: z.object({ slug: z.string().min(1) }).passthrough(),
          status: z.string().optional(),
          substatus: z.string().optional().nullable(),
          title: z.string().optional(),
          url: z.string().url(),
          web_url: z.string().url().optional(),
        })
        .passthrough(),
    }),
    installation: z.object({ uuid: z.string().min(1) }).passthrough(),
  })
  .passthrough();

const metricAlertWebhookSchema = z
  .object({
    action: z.string(),
    data: z.object({
      description_text: z.string().optional(),
      description_title: z.string().optional(),
      metric_alert: z
        .object({
          alert_rule: z
            .object({
              id: z.coerce.string().min(1),
              projects: z.array(z.string().min(1)).optional(),
            })
            .passthrough(),
          id: z.coerce.string().min(1),
        })
        .passthrough(),
      web_url: z.string().url(),
    }),
    installation: z.object({ uuid: z.string().min(1) }).passthrough(),
  })
  .passthrough();

function organizationSlug(issueApiUrl: string): string | undefined {
  try {
    const segments = new URL(issueApiUrl).pathname.split("/").filter(Boolean);
    const organizationsIndex = segments.indexOf("organizations");
    return organizationsIndex >= 0
      ? segments[organizationsIndex + 1]
      : undefined;
  } catch {
    return undefined;
  }
}

function providerTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  // Issue payloads use ISO timestamps; Sentry-Hook-Timestamp is unix seconds.
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) ? seconds * 1000 : undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function issueText(issue: {
  culprit?: string;
  issueCategory?: string;
  issueType?: string;
  level?: string;
  priority?: string;
  status?: string;
  substatus?: string | null;
  title?: string;
  web_url?: string;
}): string | undefined {
  const parts = [
    issue.title ? `Title: ${issue.title}` : undefined,
    issue.culprit ? `Culprit: ${issue.culprit}` : undefined,
    issue.level ? `Level: ${issue.level}` : undefined,
    issue.priority ? `Priority: ${issue.priority}` : undefined,
    issue.issueCategory ? `Category: ${issue.issueCategory}` : undefined,
    issue.issueType ? `Type: ${issue.issueType}` : undefined,
    issue.status ? `Status: ${issue.status}` : undefined,
    issue.substatus ? `Substatus: ${issue.substatus}` : undefined,
    issue.web_url ? `URL: ${issue.web_url}` : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/**
 * Read the org slug from a Sentry web URL. Sentry builds metric alert links
 * with either `/organizations/<org>/` paths or `<org>.sentry.io` hosts.
 */
function webOrganizationSlug(webUrl: string): string | undefined {
  const fromPath = organizationSlug(webUrl);
  if (fromPath) return fromPath;
  const labels = new URL(webUrl).hostname.split(".");
  return labels.length >= 3 ? labels[0] : undefined;
}

interface WebhookInput {
  body: unknown;
  hookResource: string;
  hookTimestamp?: string;
  webhookOrg: string;
}

function normalizeIssueEvents(input: WebhookInput): EventInput[] {
  const parsed = issueWebhookSchema.safeParse(input.body);
  if (!parsed.success || parsed.data.action !== "created") return [];

  const issue = parsed.data.data.issue;
  const org = organizationSlug(issue.url)?.toLowerCase();
  if (!org || org !== input.webhookOrg.toLowerCase()) return [];
  const issueResource = sentryIssueResource({
    issueId: issue.id,
    org,
    project: issue.project.slug,
  });
  const projectResource = sentryProjectResource({
    org,
    project: issue.project.slug,
  });
  const eventType = "issue.created";
  const occurredAtMs =
    providerTime(issue.firstSeen) ??
    providerTime(input.hookTimestamp) ??
    Date.now();
  const untrustedText = issueText(issue);
  const event = {
    // Sentry assigns a new Request-ID to retries, so use resource identity for
    // idempotency across repeated deliveries of the same lifecycle event.
    eventKey: `sentry:${issueResource.identifier}:${eventType}`,
    eventType,
    occurredAtMs,
    trustedSummary: `${issueResource.label} was created.`,
    ...(untrustedText ? { untrustedText } : undefined),
  } satisfies Omit<EventInput, "identifier">;

  return [
    { ...event, identifier: issueResource.identifier },
    { ...event, identifier: projectResource.identifier },
  ];
}

function normalizeMetricAlertEvents(input: WebhookInput): EventInput[] {
  const parsed = metricAlertWebhookSchema.safeParse(input.body);
  if (!parsed.success) return [];
  const eventType = `metric_alert.${parsed.data.action}`;
  if (!(SENTRY_METRIC_ALERT_EVENTS as readonly string[]).includes(eventType)) {
    return [];
  }

  const { data } = parsed.data;
  const org = webOrganizationSlug(data.web_url)?.toLowerCase();
  if (!org || org !== input.webhookOrg.toLowerCase()) return [];
  const alertRuleId = data.metric_alert.alert_rule.id;
  const incidentId = data.metric_alert.id;
  const resource = sentryMetricAlertResource({ alertRuleId, org });
  const untrustedText = [
    data.description_title,
    data.description_text,
    `URL: ${data.web_url}`,
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n");

  const event = {
    // One event per incident state. Sentry retries get new Request-IDs.
    eventKey: `sentry:${resource.identifier}:${incidentId}:${eventType}`,
    eventType,
    occurredAtMs: providerTime(input.hookTimestamp) ?? Date.now(),
    trustedSummary: `${resource.label} is ${parsed.data.action}.`,
    data: { alertRuleId, incidentId, url: data.web_url },
    untrustedText,
  } satisfies Omit<EventInput, "identifier">;
  // Also publish to each project of the alert rule, so one project
  // subscription receives its new issues and its metric alerts.
  const projects = [...new Set(data.metric_alert.alert_rule.projects ?? [])];

  return [
    { ...event, identifier: resource.identifier },
    ...projects.map((project) => ({
      ...event,
      identifier: sentryProjectResource({ org, project }).identifier,
    })),
  ];
}

/** Normalize one verified Sentry webhook into subscribable Sentry events. */
export function normalizeSentryEvents(input: WebhookInput): EventInput[] {
  switch (input.hookResource) {
    case "issue":
      return normalizeIssueEvents(input);
    case "metric_alert":
      return normalizeMetricAlertEvents(input);
    default:
      return [];
  }
}
